'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const projectRoot=path.resolve(__dirname,'..');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

// Drain native Promise continuations without waiting for real time. Timer
// callbacks are deliberately not awaited: a pending network read must not stop
// later poll attempts, visibility changes, or account changes in these tests.
async function microtasks(){
  for(let i=0;i<24;i++)await Promise.resolve();
}

function fakeClock(start=100000){
  let time=start,nextId=1;
  const tasks=new Map(),failures=[];
  const NativeDate=Date;
  class ClockDate extends NativeDate{
    constructor(...args){super(...(args.length?args:[time]));}
    static now(){return time;}
  }
  function schedule(fn,delay=0,interval=0){
    const id=nextId++;
    tasks.set(id,{id,at:time+Math.max(0,Number(delay)||0),fn,interval});
    return id;
  }
  const clock={
    Date:ClockDate,
    now:()=>time,
    setTimeout:(fn,delay)=>schedule(fn,delay),
    clearTimeout:id=>tasks.delete(id),
    setInterval:(fn,delay)=>schedule(fn,delay,Math.max(1,Number(delay)||1)),
    clearInterval:id=>tasks.delete(id),
    async advance(ms){
      assert(ms>=0,'test clock cannot run backwards');
      const end=time+ms;
      await microtasks();
      let executed=0;
      for(;;){
        const due=[...tasks.values()].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
        if(!due)break;
        assert(++executed<1000,'runtime must not create a busy timer loop');
        time=due.at;
        if(due.interval)due.at+=due.interval;
        else tasks.delete(due.id);
        try{
          const result=due.fn();
          if(result&&typeof result.then==='function')result.catch(error=>failures.push(error));
        }catch(error){failures.push(error);}
        await microtasks();
        if(failures.length)throw failures.shift();
      }
      time=end;
      await microtasks();
      if(failures.length)throw failures.shift();
    }
  };
  return clock;
}

function eventTarget(extra={}){
  const listeners=new Map();
  return Object.assign({
    addEventListener(type,fn){
      if(!listeners.has(type))listeners.set(type,new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    dispatchEvent(event){
      for(const fn of [...(listeners.get(event.type)||[])])fn(event);
      return true;
    }
  },extra);
}

const projects={
  a:{id:'10000000-0000-4000-8000-000000000001',client_key:'local-a',status:'active'},
  b:{id:'10000000-0000-4000-8000-000000000002',client_key:'local-b',status:'active'},
  archived:{id:'10000000-0000-4000-8000-000000000003',client_key:'local-archived',status:'archived'},
  unknown:{id:'10000000-0000-4000-8000-000000000004',client_key:'local-new',status:'active'}
};
const head=(project,revision)=>({project_id:project.id,revision});

function assertSmallHeadRead(request){
  const url=new URL(request.path,'https://test.invalid');
  assert.equal(url.pathname,'/rest/v1/sentlog_project_snapshots');
  assert.deepEqual(url.searchParams.get('select')?.split(',').sort(),['project_id','revision'],
    'the frequent check must request only project identifiers and revisions');
  assert.equal(String(request.options?.method||'GET').toUpperCase(),'GET');
  assert.equal(request.options?.body,undefined,'a revision check cannot write any data');
}

let passed=0;
async function test(name,fn){
  try{await fn();}
  catch(error){error.message=name+': '+error.message;throw error;}
  passed++;
  console.log('PASS '+name);
}

const runtime=fs.readFileSync(path.join(projectRoot,'sentlog/edit-sync-runtime.txt'),'utf8');

function setup({realScheduler=false}={}){
  const clock=fakeClock(),requests=[],enqueues=[],runs=[],pending=new Set();
  const meta=new Map([[projects.a.client_key,{revision:1}],[projects.b.client_key,{revision:1}]]);
  let rows=[head(projects.a,1),head(projects.b,1)],reader=null,schedulerOptions;
  let activeReads=0,maxActiveReads=0,resetCount=0,currentSnapshot=null;
  let run=async()=>({started:true});
  const document=eventTarget({hidden:false,visibilityState:'visible'});
  const navigator={onLine:true};
  const scheduler={
    request(ids){
      const values=Array.from(ids);
      enqueues.push(values);
      for(const id of values)pending.add(id);
    },
    reset(){resetCount++;pending.clear();},
    wake(){},
    dispose(){},
    pending
  };
  const window=eventTarget({
    sentlogAppReady:new Promise(()=>{}),
    sentlogImporting:false,
    sentlogSyncView:{isBusy:()=>false},
    SentlogEditSync:{
      createScheduler(options){schedulerOptions=options;return scheduler;},
      watchRecords(){}
    }
  });
  const context=vm.createContext({
    window,document,navigator,Map,Set,JSON,Number,String,Array,Promise,Error,Math,URL,
    Date:clock.Date,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    setInterval:clock.setInterval,clearInterval:clock.clearInterval,
    console:{warn(){}},session:{user:{id:'owner-a'},access_token:'token-a'},
    syncing:false,mergeBusy:false,
    getSyncMeta:id=>meta.get(id),
    archive:{canSync:cp=>cp.status==='active'},
    projectSnapshot:()=>clone(currentSnapshot),
    syncNow:async options=>{runs.push(clone(options));return run(options);},
    rest:async(requestPath,options)=>{
      const request={path:requestPath,options,account:context.session?.user?.id,at:clock.now()};
      requests.push(request);assertSmallHeadRead(request);
      activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);
      try{return clone(reader?await reader(request):rows);}
      finally{activeReads--;}
    }
  });
  if(realScheduler){
    vm.runInContext(fs.readFileSync(path.join(projectRoot,'sentlog/edit-sync.js'),'utf8'),context);
    const create=window.SentlogEditSync.createScheduler;
    window.SentlogEditSync.createScheduler=options=>{
      schedulerOptions=options;
      const actual=create(options),request=actual.request;
      actual.request=(ids,options)=>{enqueues.push(Array.from(ids));return request(ids,options);};
      return actual;
    };
  }
  const api=vm.runInContext(runtime+'\n;({createSyncHeadWatcher,syncHeads,editSync,knownCloudProjects,editSyncSessionChanged,wakeEditSync,sharedFileText,projectFilesChanged});',context);
  for(const cp of [projects.a,projects.b,projects.archived])api.knownCloudProjects.set(cp.id,clone(cp));
  return {
    api,clock,context,document,navigator,window,requests,enqueues,runs,pending,meta,
    setRows(value){rows=clone(value);},setReader(fn){reader=fn;},
    setRun(fn){run=fn;},
    setSnapshot(value){currentSnapshot=clone(value);},
    setOwner(id){context.session=id?{user:{id},access_token:'token-'+id}:null;api.editSyncSessionChanged();},
    async runQueued(){return schedulerOptions.run([...pending]);},
    canRun:()=>schedulerOptions.canRun(),
    get activeReads(){return activeReads;},get maxActiveReads(){return maxActiveReads;},
    get resetCount(){return resetCount;}
  };
}

async function receiverTests(){
  await test('only one revision-only GET remains in flight through repeated wakeups',async()=>{
    const s=setup(),response=deferred();s.setReader(()=>response.promise);
    const first=s.api.syncHeads.poll();
    await microtasks();
    const attempts=Array.from({length:20},()=>s.api.syncHeads.poll());
    s.api.wakeEditSync();await s.clock.advance(9000);
    assert.equal(s.requests.length,1);assert.equal(s.maxActiveReads,1);
    assert.equal(s.api.syncHeads.running,true);
    response.resolve([head(projects.a,1)]);await Promise.all([first,...attempts]);
    assert.equal(s.api.syncHeads.running,false);assert.equal(s.activeReads,0);
    assert.equal(s.enqueues.length,0,'unchanged revision causes no data synchronization');
    s.api.syncHeads.stop();
  });

  await test('a changed active project queues only its local project and preserves the applied revision',async()=>{
    const s=setup();s.setRows([head(projects.a,2),head(projects.b,1),head(projects.archived,90)]);
    await s.api.syncHeads.poll();
    assert.deepEqual(s.enqueues,[[projects.a.client_key]]);
    assert.equal(s.meta.get(projects.a.client_key).revision,1,'observing a head is not a successful merge');
    await s.runQueued();
    assert.deepEqual(s.runs,[{eventDriven:true,projectIds:[projects.a.client_key]}]);
    s.window.sentlogSyncView.isBusy=()=>true;
    assert.equal(s.canRun(),false,'an editor safety guard still blocks the scheduled cycle');
    s.api.syncHeads.stop();
  });

  await test('a blocked revision is not re-enqueued by unchanged fifteen-second polls but a newer revision is',async()=>{
    const s=setup();s.setRows([head(projects.a,2)]);
    await s.api.syncHeads.poll();
    // Leave getSyncMeta unchanged, as happens while the selected record cannot
    // be merged. The independent 15-second fallback owns retries of this head.
    await s.clock.advance(24000);
    assert.equal(s.requests.length,3,'initial read, queued wakeup and a fifteen-second fallback make three reads, well below the old 3-second polling rate');
    assert.equal(s.enqueues.length,1,'unchanged blocked heads cannot trigger repeated full payload reads');
    assert.equal(s.meta.get(projects.a.client_key).revision,1);
    s.setRows([head(projects.a,3)]);await s.api.syncHeads.poll();
    assert.equal(s.enqueues.length,2);assert.deepEqual(s.enqueues[1],[projects.a.client_key]);
    s.api.syncHeads.stop();
  });

  await test('unknown projects request discovery once and discovered archived projects stay quiet',async()=>{
    const s=setup();s.setRows([head(projects.unknown,4),head(projects.b,2),head(projects.archived,500)]);
    await s.api.syncHeads.poll();await s.api.syncHeads.poll();
    assert.deepEqual(s.enqueues,[['*']],'one discovery request covers simultaneous known and unknown changes');
    await s.runQueued();assert.deepEqual(s.runs,[{eventDriven:true,projectIds:null}]);
    s.api.knownCloudProjects.set(projects.unknown.id,{...projects.unknown,status:'archived'});
    s.setRows([head(projects.unknown,5),head(projects.archived,501)]);
    await s.api.syncHeads.poll();
    assert.equal(s.enqueues.length,1,'archived IDs in the complete project map cannot loop discovery');
    s.api.syncHeads.stop();
  });

  await test('account changes clear queued work and discard stale responses without overlapping reads',async()=>{
    const s=setup();s.setRows([head(projects.a,2)]);await s.api.syncHeads.poll();
    assert(s.pending.has(projects.a.client_key));
    const response=deferred();s.setReader(()=>response.promise);
    const old=s.api.syncHeads.poll();await microtasks();
    s.setOwner('owner-b');
    assert.equal(s.resetCount,1);assert.deepEqual([...s.pending],['*']);
    assert.equal(s.api.knownCloudProjects.size,0);
    const whileOld=s.api.syncHeads.poll();await s.clock.advance(6000);
    assert.equal(s.requests.length,2,'a new account does not start a second physical request over an old one');
    const before=s.enqueues.length;
    response.resolve([head(projects.a,99)]);await Promise.all([old,whileOld]);
    assert.equal(s.enqueues.length,before,'the old account response cannot request synchronization');
    assert.equal(s.api.syncHeads.retryAt,0);
    s.setReader(null);s.setRows([]);await s.clock.advance(0);
    assert.equal(s.requests.at(-1).account,'owner-b');assert.equal(s.maxActiveReads,1);
    s.setOwner('owner-a');s.api.knownCloudProjects.set(projects.a.id,projects.a);
    s.setRows([head(projects.a,2)]);await s.api.syncHeads.poll();
    assert.deepEqual(s.enqueues.at(-1),[projects.a.client_key],
      'returning to an account rechecks revisions instead of inheriting its previous notification cache');
    s.setOwner(null);assert.equal(s.pending.size,0,'logout leaves no pending cross-account work');
    s.api.syncHeads.stop();
  });

  await test('an old account request failure does not back off the newly signed-in account',async()=>{
    const s=setup(),response=deferred();s.setReader(()=>response.promise);
    const old=s.api.syncHeads.poll();await microtasks();s.setOwner('owner-b');
    response.reject(Error('old account network failure'));await old;
    assert.equal(s.api.syncHeads.retryAt,0);
    s.setReader(null);s.setRows([]);await s.clock.advance(0);
    assert.equal(s.requests.length,2);assert.equal(s.requests[1].account,'owner-b');
    s.api.syncHeads.stop();
  });

  await test('failed lightweight reads wait thirty seconds even when foreground events wake them',async()=>{
    const s=setup();s.setReader(()=>Promise.reject(Error('temporary network error')));
    const start=s.clock.now();await s.api.syncHeads.poll();
    assert.equal(s.api.syncHeads.retryAt,start+30000);
    s.setReader(null);s.setRows([head(projects.a,2)]);
    s.api.wakeEditSync();await s.clock.advance(29999);await s.api.syncHeads.poll();
    assert.equal(s.requests.length,1);assert.equal(s.enqueues.length,0);
    await s.clock.advance(1);
    assert.equal(s.requests.length,2);assert.equal(s.api.syncHeads.retryAt,0);
    assert.deepEqual(s.enqueues,[[projects.a.client_key]]);
    s.api.syncHeads.stop();
  });

  await test('hidden and offline devices pause polling and do not consume a response received while hidden',async()=>{
    const s=setup();s.document.hidden=true;
    await s.api.syncHeads.poll();await s.clock.advance(9000);
    assert.equal(s.requests.length,0);
    s.document.hidden=false;s.navigator.onLine=false;s.api.wakeEditSync();await s.clock.advance(9000);
    assert.equal(s.requests.length,0);
    s.navigator.onLine=true;
    const response=deferred();s.setReader(()=>response.promise);
    s.api.wakeEditSync();await s.clock.advance(0);
    assert.equal(s.requests.length,1);
    s.document.hidden=true;response.resolve([head(projects.a,2)]);await microtasks();
    assert.equal(s.enqueues.length,0);
    s.document.hidden=false;s.setReader(null);s.setRows([head(projects.a,2)]);
    s.api.wakeEditSync();await s.clock.advance(0);
    assert.deepEqual(s.enqueues,[[projects.a.client_key]],'the same revision remains eligible after foregrounding');
    s.context.syncing=true;assert.equal(s.canRun(),false);
    s.context.syncing=false;s.window.sentlogImporting=true;assert.equal(s.canRun(),false);
    s.api.syncHeads.stop();
  });

  await test('capped or malformed head responses never schedule a partial synchronization',async()=>{
    for(const rows of [
      Array.from({length:1000},(_,i)=>({project_id:'cloud-'+i,revision:1})),
      [head(projects.a,2),{project_id:projects.b.id,revision:'not-a-revision'}],
      {error:'unexpected object'}
    ]){
      const s=setup();s.setRows(rows);await s.api.syncHeads.poll();
      assert.equal(s.enqueues.length,0);assert.equal(s.api.syncHeads.retryAt,s.clock.now()+30000);
      assert.equal(s.meta.get(projects.a.client_key).revision,1);
      s.api.syncHeads.stop();
    }
  });

  await test('the real scheduler retains observed revisions through deferred starts and failed cycles',async()=>{
    const s=setup({realScheduler:true});let attempt=0;
    s.setRun(async()=>{
      attempt++;
      if(attempt===1)return {started:false,retryAt:s.clock.now()+5000};
      if(attempt===2)return {started:true,retryAt:s.clock.now()+30000};
      return {started:true};
    });
    s.setRows([head(projects.a,2)]);await s.api.syncHeads.poll();
    await s.clock.advance(200);
    assert.equal(s.runs.length,1);assert.deepEqual(clone(s.api.editSync.pending),[projects.a.client_key]);
    await s.api.syncHeads.poll();await s.clock.advance(4999);
    assert.equal(s.runs.length,1,'a queued head must respect a not-started retry deadline');
    await s.clock.advance(1);assert.equal(s.runs.length,2);
    s.setRows([head(projects.a,2),head(projects.b,2)]);await s.api.syncHeads.poll();
    s.api.wakeEditSync();await s.clock.advance(29999);
    assert.equal(s.runs.length,2,'a new peer change cannot shorten a failed cycle backoff');
    await s.clock.advance(1);
    assert.equal(s.runs.length,3);
    assert.deepEqual(new Set(s.runs[2].projectIds),new Set([projects.a.client_key,projects.b.client_key]),
      'the failed scope and newly received scope both reach the successful retry');
    assert.deepEqual(clone(s.api.editSync.pending),[]);
    assert.equal(s.enqueues.length,2,'repeat observations of the same head do not create extra queue requests');
    s.api.syncHeads.stop();s.api.editSync.dispose();
  });
}

async function attachmentTests(){
  const baseline={project:{id:'local-a'},drawings:[{
    meta:{id:'drawing-a',name:'図面1'},
    state:{id:'drawing-a',sourceType:'pdf',fileName:'図面.pdf',pageCount:2,
      pageReplacements:{},autoTracePhotos:[{id:'source-photo',size:200}],
      shapes:[{id:'record-a',memo:'既存コメント',point:{x:10,y:20},
        photos:[{id:'photo-a',name:'現場.jpg',size:100,sha256:'a'.repeat(64)}]}]}
  }]};
  await test('comment, position, label and display edits do not reopen the unchanged attachment pipeline',async()=>{
    const s=setup(),edited=clone(baseline),shape=edited.drawings[0].state.shapes[0];
    shape.memo='iPadで記入したコメント';shape.point={x:320,y:450};shape.labelPoint={x:350,y:470};
    edited.drawings[0].state.currentPage=2;edited.drawings[0].state.scale=1.5;
    edited.project.updatedAt=123456;edited.drawings[0].meta.name='図面名を変更';
    s.setSnapshot(edited);
    assert.equal(s.api.projectFilesChanged(edited.project,baseline),false);
    assert.equal(s.api.sharedFileText(edited),s.api.sharedFileText(baseline));
    assert.deepEqual(baseline.drawings[0].state.shapes[0].photos,[{id:'photo-a',name:'現場.jpg',size:100,sha256:'a'.repeat(64)}]);
    s.api.syncHeads.stop();
  });
  await test('new photos, drawing additions, photo replacement and PDF revisions retain the attachment pipeline',async()=>{
    const changes=[
      value=>value.drawings[0].state.shapes[0].photos.push({id:'new-photo',size:100}),
      value=>value.drawings[0].state.autoTracePhotos.push({id:'new-source-photo',size:300}),
      value=>value.drawings[0].state.shapes[0].photos[0].sha256='b'.repeat(64),
      value=>value.drawings[0].state.shapes[0].photos[0].size=101,
      value=>value.drawings[0].state.shapes[0].photos.splice(0),
      value=>value.drawings.push({meta:{id:'drawing-b'},state:{sourceType:'image',fileName:'追加.png',shapes:[]}}),
      value=>value.drawings[0].state.pageReplacements['2']={updatedAt:123456,pdfHash:'c'.repeat(64),pdfSize:456},
      value=>value.drawings[0].state.fileName='別の図面.pdf'
    ];
    const s=setup();
    for(const change of changes){
      const edited=clone(baseline);change(edited);s.setSnapshot(edited);
      assert.equal(s.api.projectFilesChanged(edited.project,baseline),true,'a changed file reference must keep normal file verification');
    }
    s.setSnapshot(baseline);
    assert.equal(s.api.projectFilesChanged(baseline.project,null),true,'missing baseline cannot skip files');
    assert.equal(s.api.projectFilesChanged(null,baseline),true);
    s.api.syncHeads.stop();
  });
}

(async()=>{
  await receiverTests();await attachmentTests();
  console.log(`${passed} edit-driven cloud synchronization scenarios passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});

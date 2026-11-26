'use strict';
// Execute the actual post-adoption callback and actual shared UI observation
// helpers. Synthetic accounts/projects only; this fixture performs no writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),builtRoot=process.env.SENTLOG_BUILT_ROOT?path.resolve(process.env.SENTLOG_BUILT_ROOT):root;
function helpers(source){
  const start=source.indexOf('/* project-sync-controls-v1:'),end=source.indexOf('function renderProjectSyncControls(){',start);
  assert(start>=0&&end>start,'actual project observation helpers must exist');return source.slice(start,end).trim();
}
function resumed(source){
  const start=source.indexOf('  async onResumed(entry){'),end=source.indexOf('\n});\nwindow.sentlogDrawingRecoveryReview',start);
  assert(start>=0&&end>start,'actual drawing resume callback must exist');return source.slice(start,end).trim();
}
const sourceHelpers=helpers(fs.readFileSync(path.join(root,'sentlog/project-sync-controls.txt'),'utf8'));
const sourceResumed=resumed(fs.readFileSync(path.join(root,'sentlog/delta-sync-cloud-runtime.txt'),'utf8'));
const cloud=fs.readFileSync(path.join(builtRoot,'sentlog/cloud-sync.js'),'utf8'),sources=[['source',sourceHelpers,sourceResumed]];
if(process.env.SENTLOG_BUILT_ROOT||cloud.includes('sentlog-sync-wait-v202')){
  const builtHelpers=helpers(cloud),builtResumed=resumed(cloud);
  assert.equal(builtHelpers,sourceHelpers,'built observation helpers must match the reviewed source');
  assert.equal(builtResumed,sourceResumed,'built post-adoption callback must match the reviewed source');
  sources.push(['built',builtHelpers,builtResumed]);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function microtasks(){for(let n=0;n<30;n++)await Promise.resolve();}
function fixture(helperSource,resumeSource){
  const hold=deferred(),timers=new Map(),calls=[],select={value:'previous-project'};let serial=0,generation=7,device='review-device';
  const entry={localProjectId:'review-local',scope:{ownerId:'review-owner',projectId:'review-cloud',deviceId:'review-device'}};
  const context={session:{user:{id:'review-owner'}},sessionGuard:{generation:()=>generation},DEVICE_KEY:'synthetic-device-key',
    localStorage:{getItem:()=>device},document:{getElementById:id=>id==='sentlogSyncProjectSelect'?select:null},
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    syncNow:async options=>{calls.push(JSON.parse(JSON.stringify(options)));return hold.promise;}};
  vm.createContext(context);
  const api=vm.runInContext(helperSource+'\nconst actualResume={'+resumeSource+'};\n({resume:actualResume.onResumed,request:requestProjectSync,requests:projectSyncRequests});',context);
  return {api,entry,calls,hold,timers,select,context,
    expire(){for(const [id,timer]of [...timers]){assert.equal(timer.ms,30000);timers.delete(id);timer.fn();}},
    change(kind){if(kind==='owner')context.session={user:{id:'another-owner'}};else if(kind==='device')device='another-device';
      else if(kind==='generation')generation++;else if(kind==='selection')select.value='another-project';else throw Error('unknown scope change');}};
}
function observeNotice(task){
  const state={settled:false,notices:[]};
  // The drawing-review commit path turns a rejected onResumed promise into a
  // saved-drawing notice. Obsolete scopes must therefore resolve silently.
  state.done=task.then(()=>{state.settled=true;},error=>{state.settled=true;state.error=error;state.notices.push(error.message);});return state;
}
let passed=0;async function test(mode,name,run){await run();passed++;console.log('PASS',mode,name);}
async function suite(mode,helperSource,resumeSource){
  await test(mode,'the current account sees a bounded wait while the shared save task remains alive',async()=>{
    const f=fixture(helperSource,resumeSource),state=observeNotice(f.api.resume(f.entry));await microtasks();
    assert.equal(f.select.value,f.entry.localProjectId);assert.deepEqual(f.calls,[{force:true,projectIds:['review-local']}]);
    const pending=f.api.request(f.entry.localProjectId);f.expire();await state.done;
    assert.match(state.error?.message||'',/確認に時間がかかっています/);assert.equal(state.notices.length,1);assert.equal(f.timers.size,0);
    assert.equal(f.api.requests.size,1);assert.equal(f.api.request(f.entry.localProjectId),pending,'timeout must not release or replace the worker promise');
    const retry=observeNotice(f.api.resume(f.entry));await microtasks();assert.equal(f.calls.length,1);
    f.hold.resolve({started:true});await retry.done;assert.equal(retry.notices.length,0);assert.equal(f.api.requests.size,0);assert.equal(f.timers.size,0);
  });
  for(const kind of ['owner','device','generation','selection'])for(const outcome of ['timeout','reject']){
    await test(mode,kind+' changes suppress a later '+outcome+' instead of reviving the old drawing notice',async()=>{
      const f=fixture(helperSource,resumeSource),state=observeNotice(f.api.resume(f.entry));await microtasks();assert.equal(f.calls.length,1);
      f.change(kind);if(outcome==='timeout')f.expire();else f.hold.reject(Error('synthetic old-job failure'));
      await state.done;assert.equal(state.error,undefined);assert.equal(state.notices.length,0);assert.equal(f.timers.size,0);
      if(outcome==='timeout'){f.hold.resolve({started:true});await microtasks();assert.equal(state.notices.length,0);}
      assert.equal(f.api.requests.size,0);assert.equal(f.calls.length,1);
    });
  }
  await test(mode,'manual observation and concurrent post-adoption retries share one live owner/project task',async()=>{
    const f=fixture(helperSource,resumeSource),manual=f.api.request(f.entry.localProjectId);
    const a=observeNotice(f.api.resume(f.entry)),b=observeNotice(f.api.resume(f.entry));await microtasks();
    assert.equal(f.api.request(f.entry.localProjectId),manual);assert.equal(f.calls.length,1);assert.equal(f.api.requests.size,1);
    f.hold.resolve({started:true});await Promise.all([manual,a.done,b.done]);
    assert.equal(a.notices.length,0);assert.equal(b.notices.length,0);assert.equal(f.api.requests.size,0);assert.equal(f.timers.size,0);
  });
  await test(mode,'an already different owner or device cannot change the selection or start a request',async()=>{
    for(const kind of ['owner','device']){
      const f=fixture(helperSource,resumeSource);f.change(kind);await f.api.resume(f.entry);
      assert.equal(f.select.value,'previous-project');assert.equal(f.calls.length,0);assert.equal(f.api.requests.size,0);assert.equal(f.timers.size,0);
    }
  });
  await test(mode,'current-scope start failures and save rejections still reach the notice handler',async()=>{
    for(const failed of ['not-started','rejected']){
      const f=fixture(helperSource,resumeSource),state=observeNotice(f.api.resume(f.entry));await microtasks();
      if(failed==='not-started')f.hold.resolve({started:false});else f.hold.reject(Error('synthetic save failure'));
      await state.done;assert.equal(state.notices.length,1);assert.match(state.error.message,failed==='not-started'?/この案件だけ同期/:/synthetic save failure/);
      assert.equal(f.api.requests.size,0);assert.equal(f.timers.size,0);
    }
  });
}
const watchdog=setTimeout(()=>{console.error('FAIL drawing resume observation did not settle');process.exit(1);},15000);
(async()=>{for(const [mode,helperSource,resumeSource]of sources)await suite(mode,helperSource,resumeSource);console.log('PASS',passed,'drawing resume observation cases');})()
  .catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));

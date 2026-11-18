'use strict';
const assert=require('node:assert/strict');
const {createScheduler,watchRecords}=require('../sentlog/edit-sync.js');
const WS='surveyFieldNoteWorkspaceV1',DRAW=id=>'surveyFieldNoteDrawingV1:'+id;
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function microtasks(){for(let i=0;i<8;i++)await Promise.resolve();}
function clock(){
  let time=0,serial=0;const timers=new Map();
  return {now:()=>time,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{at:time+ms,fn});return id;},clearTimer:id=>timers.delete(id),
    async tick(ms){
      const end=time+ms;let steps=0;
      while(true){
        const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        if(!next)break;if(++steps>1000)throw Error('Timer loop');time=next[1].at;timers.delete(next[0]);next[1].fn();await microtasks();
      }
      time=end;await microtasks();
    },get count(){return timers.size;}};
}
function recordFixture(){
  const project={id:'p1',name:'調査',updatedAt:1,drawings:[{id:'d1',name:'図面',updatedAt:1}]};
  const drawing={currentPage:1,width:1200,height:800,pdfPageInfo:{},labelSize:'normal',shapes:[{id:'s1',memo:'',point:{x:1,y:2},photos:[]}]};
  const data=new Map([[WS,JSON.stringify({projects:[project]})],[DRAW('d1'),JSON.stringify(drawing)]]);
  const controls={archiveWait:null,archiveError:null,replaceError:null};
  const batch=writes=>{for(const [key,value] of writes){if(value===null)data.delete(key);else data.set(key,value);}};
  const records={getItem:key=>data.get(key)??null,keys:()=>[...data.keys()],
    setItem:(key,value)=>batch([[key,String(value)]]),removeItem:key=>batch([[key,null]]),batch,
    async archiveAtomic({writes}){if(controls.archiveWait)await controls.archiveWait.promise;if(controls.archiveError)throw controls.archiveError;batch(writes);return 'committed';},
    async replaceAll(values){if(controls.replaceError)throw controls.replaceError;data.clear();batch(values);return 'replaced';}};
  const changes=[],watch=watchRecords(records,{onChange:ids=>changes.push(ids.sort())});
  return {project,drawing,data,records,controls,changes,watch};
}

async function schedulerTests(){
  {
    const c=clock(),calls=[],s=createScheduler({...c,run:async ids=>{calls.push({at:c.now(),ids});return {started:true};}});
    s.request(['p1']);await c.tick(500);s.request(['p1','p2']);await c.tick(799);assert.equal(calls.length,0);
    await c.tick(1);assert.deepEqual(calls,[{at:1300,ids:['p1','p2']}]);assert.equal(c.count,0);
    s.request(['p1']);await c.tick(700);s.request(['p1']);await c.tick(700);s.request(['p1']);await c.tick(700);s.request(['p1']);await c.tick(700);s.request(['p1']);await c.tick(200);
    assert.equal(calls[1].at,4300,'sustained typing is sent at the maximum wait');
  }
  {
    const c=clock(),flight=deferred(),calls=[];let active=0,maxActive=0;
    const s=createScheduler({...c,run:async ids=>{active++;maxActive=Math.max(maxActive,active);calls.push(ids);if(calls.length===1)await flight.promise;active--;return {started:true};}});
    s.request(['p1'],{delay:0});await c.tick(0);s.request(['p1']);await c.tick(400);s.request(['p2']);await c.tick(3000);
    assert.equal(calls.length,1);flight.resolve();await microtasks();await c.tick(0);
    assert.deepEqual(calls,[['p1'],['p1','p2']],'same-project edits during a flight remain queued');assert.equal(maxActive,1);
    s.request(['p3'],{delay:0});await c.tick(1499);assert.equal(calls.length,2);await c.tick(1);assert.equal(calls.length,3,'event cycles respect their minimum gap');
  }
  {
    const c=clock(),calls=[];let online=false;
    const s=createScheduler({...c,canRun:()=>online,run:async ids=>{calls.push(ids);return {started:true};}});
    s.request(['p1'],{delay:0});await c.tick(2500);assert.equal(calls.length,0);assert.deepEqual(s.pending,['p1']);assert.equal(c.count,1);
    online=true;s.wake();await c.tick(0);assert.deepEqual(calls,[['p1']]);
    online=false;s.request(['p2'],{delay:0});await c.tick(1500);online=true;await c.tick(1000);assert.deepEqual(calls[1],['p2'],'blocked work recovers even without a second edit');
  }
  {
    const c=clock(),calls=[];let attempt=0;
    const s=createScheduler({...c,run:async ids=>{calls.push({at:c.now(),ids});return ++attempt===1?{started:false,retryAt:c.now()+5000}:{started:true};}});
    s.request(['p1'],{delay:0});await c.tick(0);await c.tick(200);s.request(['p2'],{delay:0});s.wake();await c.tick(4799);assert.equal(calls.length,1);
    await c.tick(1);assert.deepEqual(new Set(calls[1].ids),new Set(['p1','p2']));assert.equal(calls[1].at,5000,'new edits do not bypass an explicit retry deadline');
  }
  {
    const c=clock(),calls=[];let attempt=0;
    const s=createScheduler({...c,run:async ids=>{calls.push({at:c.now(),ids});if(++attempt===1)throw Error('network');return {started:true};}});
    s.request(['p1'],{delay:0});await c.tick(0);s.request(['*'],{delay:0});s.wake();await c.tick(29999);assert.equal(calls.length,1);
    await c.tick(1);assert.deepEqual(calls[1],{at:30000,ids:['*']});assert.equal(s.retryAt,0);assert.equal(c.count,0);
  }
  {
    const c=clock(),calls=[];let attempt=0;
    const s=createScheduler({...c,run:async ids=>{
      calls.push({at:c.now(),ids});attempt++;
      return attempt===1?{started:false}:attempt===2?{started:true,retryAt:c.now()+6000}:{started:true};
    }});
    s.request(['p1'],{delay:0});await c.tick(999);assert.equal(calls.length,1);await c.tick(1);assert.equal(calls.length,2);
    s.request(['p2'],{delay:0});await c.tick(5999);assert.equal(calls.length,2);await c.tick(1);
    assert.equal(calls[2].at,7000);assert.deepEqual(new Set(calls[2].ids),new Set(['p1','p2']),'an error after a started cycle retains its original scope');
  }
  {
    const c=clock(),flight=deferred(),calls=[];
    const s=createScheduler({...c,run:async ids=>{calls.push(ids);return calls.length===1?flight.promise:{started:true};}});
    s.request(['old-account'],{delay:0});await c.tick(0);s.reset();s.request(['new-account'],{delay:0});await c.tick(1000);assert.equal(calls.length,1);
    flight.resolve({started:false,retryAt:90000});await microtasks();await c.tick(0);
    assert.deepEqual(calls,[['old-account'],['new-account']],'reset discards the old flight response without allowing parallel runs');assert.equal(s.retryAt,0);
    s.request(['pending']);s.dispose();await c.tick(5000);assert.equal(calls.length,2);assert.equal(c.count,0);
  }
  console.log('PASS edit scheduler: typing debounce/max wait, one flight, queued generations, blocking, backoff, wildcard and account reset');
}

async function recordTests(){
  {
    const f=recordFixture(),d=copy(f.drawing);d.shapes[0].memo='入力';f.records.setItem(DRAW('d1'),JSON.stringify(d));
    assert.deepEqual(f.changes,[['p1']],'public setItem does not duplicate its internal batch notification');
    d.shapes[0].point.x=5;f.records.batch([[DRAW('d1'),JSON.stringify(d)],[WS,JSON.stringify({projects:[{...f.project,updatedAt:2}]})]]);
    assert.deepEqual(f.changes,[['p1'],['p1']],'direct batch detects a position change once');
    f.records.removeItem(DRAW('d1'));assert.deepEqual(f.changes[2],['p1']);f.watch.dispose();f.records.setItem(DRAW('d1'),JSON.stringify(d));assert.equal(f.changes.length,3);
  }
  {
    const f=recordFixture(),view=copy(f.drawing);Object.assign(view,{currentPage:2,width:2000,height:900,pdfPageInfo:{2:{wMm:210}},labelSize:'large'});
    f.records.setItem(DRAW('d1'),JSON.stringify(view));f.records.setItem(WS,JSON.stringify({projects:[{...f.project,updatedAt:2,drawings:[{...f.project.drawings[0],updatedAt:2}]}]}));
    f.records.setItem('sentlogCloudProjectSyncV2:p1',JSON.stringify({revision:2}));assert.deepEqual(f.changes,[]);
    view.shapes[0].photos.push({id:'photo1',name:'写真'});f.records.setItem(DRAW('d1'),JSON.stringify(view));assert.equal(f.changes.length,1);
    view.shapes[0].photos[0].localBlob='cache';view.shapes[0].photos[0].data='data:local';f.records.setItem(DRAW('d1'),JSON.stringify(view));assert.equal(f.changes.length,1,'photo cache fields do not echo');
    view.autoTracePhotos=[{id:'trace',data:'first'}];f.records.setItem(DRAW('d1'),JSON.stringify(view));view.autoTracePhotos[0].data='second';f.records.setItem(DRAW('d1'),JSON.stringify(view));assert.equal(f.changes.length,2);
    view.dxf={data:{geometry:'real edit'}};f.records.setItem(DRAW('d1'),JSON.stringify(view));assert.equal(f.changes.length,3,'a real non-photo data field remains shared content');
  }
  {
    const f=recordFixture(),d=copy(f.drawing);d.shapes[0].memo='remote';
    f.records.setItem(DRAW('d1'),JSON.stringify(d),{origin:'remote'});
    f.records.batch([[WS,JSON.stringify({projects:[{...f.project,name:'受信'}]})]],{origin:'remote'});
    await f.records.archiveAtomic({writes:[[DRAW('d1'),JSON.stringify({...d,shapes:[]})]],origin:'remote'});
    f.records.removeItem(DRAW('d1'),{origin:'device'});
    await f.records.replaceAll([[WS,JSON.stringify({projects:[]})]],[],{origin:'device'});
    assert.deepEqual(f.changes,[],'remote commits, merges and device-only operations never echo');
  }
  {
    const f=recordFixture(),wait=deferred();f.controls.archiveWait=wait;
    const renamed={...f.project,name:'変更'};const flight=f.records.archiveAtomic({writes:[[WS,JSON.stringify({projects:[renamed]})]]});
    assert.deepEqual(f.changes,[]);wait.resolve();assert.equal(await flight,'committed');assert.deepEqual(f.changes,[['p1']],'atomic changes notify only after success');
    f.controls.archiveError=Error('conflict');await assert.rejects(f.records.archiveAtomic({writes:[[WS,'{"projects":[]}']]}),/conflict/);assert.equal(f.changes.length,1);
  }
  {
    const f=recordFixture(),wait=deferred();f.controls.archiveWait=wait;
    const remote=copy(f.drawing);remote.shapes[0].memo='remote';
    const receive=f.records.archiveAtomic({writes:[[DRAW('d1'),JSON.stringify(remote)]],origin:'remote'});
    const local=copy(f.drawing);local.shapes[0].memo='typed during network wait';f.records.setItem(DRAW('d1'),JSON.stringify(local));
    assert.deepEqual(f.changes,[['p1']],'a pending remote operation cannot suppress local writes to the same key');wait.resolve();await receive;assert.equal(f.changes.length,1);
  }
  {
    const f=recordFixture(),newDrawing=copy(f.drawing);
    f.records.setItem(DRAW('orphan'),JSON.stringify(newDrawing));assert.deepEqual(f.changes,[]);
    const p2={id:'p2',name:'追加',drawings:[{id:'orphan'}]};f.records.setItem(WS,JSON.stringify({projects:[f.project,p2]}));
    assert.deepEqual(f.changes,[['p2']],'drawing-before-workspace writes wait for their project mapping');
    await f.records.replaceAll([[WS,JSON.stringify({projects:[p2]})],[DRAW('orphan'),JSON.stringify(newDrawing)]],[]);
    assert.deepEqual(f.changes[1],['p1'],'full replacement includes removed projects');
    const p3={id:'p3',name:'復元',drawings:[{id:'replacement'}]};await f.records.replaceAll([[WS,JSON.stringify({projects:[p3]})],[DRAW('replacement'),JSON.stringify(newDrawing)]],[]);
    assert.deepEqual(f.changes[2],['p2','p3']);
    f.controls.replaceError=Error('storage');await assert.rejects(f.records.replaceAll([],[]),/storage/);assert.equal(f.changes.length,3);
  }
  {
    const f=recordFixture();f.watch.dispose();let notified=0;const warnings=[],warn=console.warn;
    console.warn=(...args)=>warnings.push(args);
    try{
      const watch=watchRecords(f.records,{onChange(){notified++;throw Error('observer failure');}});
      const d=copy(f.drawing);d.shapes[0].memo='保存は完了';
      assert.doesNotThrow(()=>f.records.setItem(DRAW('d1'),JSON.stringify(d)));
      assert.equal(JSON.parse(f.data.get(DRAW('d1'))).shapes[0].memo,'保存は完了');assert.equal(notified,1);assert.equal(warnings.length,1);
      watch.dispose();
    }finally{console.warn=warn;}
  }
  console.log('PASS saved-edit hooks: shared comments/positions/photos, view/cache filtering, direct batches, successful atomic writes, remote origins and orphan drawings');
}

(async()=>{await schedulerTests();await recordTests();})().catch(error=>{console.error(error);process.exitCode=1;});

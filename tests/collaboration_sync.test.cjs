'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../sentlog/record-collaboration.js');
const runtime=fs.readFileSync(require.resolve('../sentlog/collaboration-sync-runtime.txt'),'utf8');
const pure=runtime.slice(0,runtime.indexOf('// Browser integration.'));
const helpers=fs.readFileSync(require.resolve('../sentlog/edit-sync-runtime.txt'),'utf8');
const fileHelpers=helpers.slice(helpers.indexOf('function sharedFileText('),helpers.indexOf('// Browser integration.'));
const copy=x=>JSON.parse(JSON.stringify(x)),stable=x=>JSON.stringify(C.canonical(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function microtasks(){for(let n=0;n<100;n++)await Promise.resolve();}
function clock(){
  let time=100000,serial=0;const timers=new Map();
  return {now:()=>time,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{at:time+ms,fn});return id;},clearTimer:id=>timers.delete(id),
    async tick(ms){const end=time+ms;let count=0;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;if(++count>200)throw Error('Timer loop');time=next[1].at;timers.delete(next[0]);next[1].fn();await microtasks();}time=end;await microtasks();},get count(){return timers.size;}};
}
const pureContext=vm.createContext({setTimeout,clearTimeout});vm.runInContext(pure+'\nthis.api={createCollaborationWorker,collaborationCanSkipFileCheck};',pureContext);
const {createCollaborationWorker,collaborationCanSkipFileCheck}=pureContext.api;
const cases=[];const test=(name,fn)=>cases.push({name,fn});

test('serialized metadata retains guarded revision without another notification',async()=>{
  const time=clock(),calls=[],first=deferred();let active=0,max=0;
  const worker=createCollaborationWorker({...time,enabled:()=>true,owner:()=> 'a',run:async ids=>{active++;max=Math.max(max,active);calls.push([...ids]);if(calls.length===1)await first.promise;active--;return {deferredIds:calls.length===1?['p1']:[]};}});
  worker.request(['p1']);await time.tick(0);worker.request(['p2']);await time.tick(500);assert.equal(calls.length,1);
  first.resolve();await microtasks();await time.tick(799);assert.equal(calls.length,1);await time.tick(1);
  assert.deepEqual(new Set(calls[1]),new Set(['p1','p2']));assert.equal(max,1);assert.equal(worker.pending.length,0);worker.stop();
});
test('fresh confirmation waits for a new round after the current round',async()=>{
  const time=clock(),hold=deferred(),calls=[];
  const worker=createCollaborationWorker({...time,enabled:()=>true,owner:()=> 'a',run:async ids=>{calls.push([...ids]);if(calls.length===1)await hold.promise;return {revision:calls.length,deferredIds:[]};}});
  worker.request(['p1']);await time.tick(0);let resolved=false;const fresh=worker.wait(['p1']).then(r=>{resolved=true;return r;});
  await time.tick(0);assert.equal(resolved,false);hold.resolve();await microtasks();assert.equal(resolved,false);await time.tick(0);
  assert.equal((await fresh).revision,2);assert.equal(calls.length,2);worker.stop();
});
test('account changes discard old results while retaining physical single-flight',async()=>{
  const time=clock(),hold=deferred();let owner='a',active=0,max=0;const commits=[];
  const worker=createCollaborationWorker({...time,enabled:()=>true,owner:()=>owner,run:async(ids,context)=>{active++;max=Math.max(max,active);try{if(context.owner==='a')await hold.promise;context.assertCurrent();commits.push(context.owner);return {deferredIds:[]};}finally{active--;}}});
  const old=worker.wait(['p1']).catch(e=>e);await time.tick(0);owner='b';worker.reset();worker.request(['p2']);await time.tick(2000);assert.equal(max,1);
  hold.resolve();await microtasks();await time.tick(0);assert.equal((await old).code,'COLLAB_ACCOUNT_CHANGED');assert.deepEqual(commits,['b']);assert.equal(max,1);worker.stop();
});
test('offline/hidden pause and network/permanent backoffs cannot be shortened by new notifications',async()=>{
  const time=clock();let enabled=false,attempt=0,mode='network';const worker=createCollaborationWorker({...time,enabled:()=>enabled,owner:()=> 'a',run:async()=>{attempt++;if(mode==='network')throw Error('network');if(mode==='protocol')throw Object.assign(Error('COLLAB_HISTORY_REQUIRED: history'),{retryable:false});return {deferredIds:[]};}});
  worker.request(['p1']);await time.tick(5000);assert.equal(attempt,0);enabled=true;worker.wake();await time.tick(0);assert.equal(attempt,1);
  worker.request(['p2']);await time.tick(29999);assert.equal(attempt,1);mode='protocol';await time.tick(1);assert.equal(attempt,2);assert.equal(worker.retryAt,Infinity);
  worker.request(['p3']);await time.tick(60000);assert.equal(attempt,2);mode='ok';worker.request(['*'],{force:true});await time.tick(0);assert.equal(attempt,3);assert.equal(worker.pending.length,0);worker.stop();
});

test('a forced scoped check cannot consume another project retry or strand drain waiters',async()=>{
  const time=clock(),calls=[];let paused=false;
  const worker=createCollaborationWorker({...time,enabled:()=>!paused,owner:()=> 'a',run:async ids=>{calls.push([...ids]);if(ids.includes('failed'))throw Error('network');return {deferredIds:[]};}});
  worker.request(['failed']);await time.tick(0);const retry=worker.retryAt;
  const check=worker.wait(['other'],{force:true});await time.tick(0);await check;
  assert.deepEqual(calls,[['failed'],['other']]);assert.equal(worker.retryAt,retry);assert.deepEqual([...worker.pending],['failed']);
  paused=true;const wait=worker.wait(['queued']).catch(e=>e);worker.releaseWaiters();assert.equal((await wait).code,'COLLAB_PAUSED');assert.ok(worker.pending.includes('queued'));worker.stop();
});

const WS='surveyFieldNoteWorkspaceV1',DP='surveyFieldNoteDrawingV1:',MP='sentlogCloudProjectSyncV2:';
function fixture(){
  const time=clock(),record=C.upgrade({id:'r1',kind:'field-record',memo:'初回',point:{x:1,y:2},photos:[{id:'ph1',name:'写真',size:10}]}),drawing={sourceType:'pdf',fileName:'図面.pdf',pageCount:1,shapes:[record],collabDeletedRecords:[]};
  const project={id:'p1',name:'現場',updatedAt:1,collaborationVersion:1,drawings:[{id:'d1',name:'図面',pageCount:1}]},base={project:copy(project),drawings:[{meta:copy(project.drawings[0]),state:copy(drawing)}]};
  const data=new Map([[WS,JSON.stringify({projects:[project]})],[DP+'d1',JSON.stringify(drawing)],[MP+'p1',JSON.stringify({revision:1,fingerprint:stable(base),fingerprint_schema:2,local_updated_at:1,base_snapshot:base})]]);
  const h={time,data,base,project,server:{revision:1,payload:copy(base),updated_at:'2026-11-18'},calls:[],statuses:[],fileCalls:[],commits:0,restHook:null,hashHook:null,fileHold:null,channel:null};
  const records={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),batch:w=>{for(const [k,v] of w){if(v===null)data.delete(k);else data.set(k,v);}},settled:async()=>{},assertSafe(){},flush:async()=>{}};
  const cp={id:'cloud-p1',client_key:'p1',name:'現場',status:'active'};
  const ls=new Map([['device','device-id']]);
  const context={console,Blob,structuredClone,Map,Set,Date:class extends Date{static now(){return time.now();}},setTimeout:time.setTimer,clearTimeout:time.clearTimer,
    session:{user:{id:'owner-a'},access_token:'test'},syncing:false,syncNotBefore:0,syncErrorNotBefore:0,mergeBusy:false,
    SUPABASE_URL:'https://example.invalid',SUPABASE_KEY:'public',DEVICE_KEY:'device',WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DP,SYNC_META_PREFIX:MP,SYNC_FINGERPRINT_SCHEMA:2,
    document:{hidden:false,addEventListener(){}},navigator:{onLine:true},localStorage:{getItem:k=>ls.get(k)??null,setItem:(k,v)=>ls.set(k,v)},
    window:{SentlogRecordCollaboration:C,SentlogRecords:records,sentlogAppReady:Promise.resolve(),addEventListener(){},SentlogCollaborationChannel:{create:opts=>(h.channel=opts,{wake(){}})}},
    archive:{ready:true,refresh:async()=>{},canSync:p=>p.status==='active',includeLocal:()=>true},knownCloudProjects:new Map([[cp.id,cp]]),syncConflicts:new Map(),drawingUploadBlocks:new Set(),editSync:{wake(){}},
    syncStatus:{begin:()=>h.statuses.length,finish:(id,s)=>h.statuses.push(s),track:async(label,fn)=>fn()},refreshMergePanel(){},enc:encodeURIComponent,
    ensureSession:async()=>context.session,ensureDevice:async()=> 'device-id',deviceName:()=> '端末',deviceType:()=> 'browser',
    workspace:()=>JSON.parse(data.get(WS)),drawingState:id=>JSON.parse(data.get(DP+id)||'null'),
    getSyncMeta:id=>JSON.parse(data.get(MP+id)||'null'),setSyncMeta:(id,meta,baseline)=>data.set(MP+id,JSON.stringify({...meta,fingerprint_schema:2,base_snapshot:baseline})),
    snapshotFingerprint:async p=>{if(h.hashHook)await h.hashHook(p);return stable(p);},normalizeMergeSnapshot:p=>p,
    tryMergeProject:async()=>{throw Error('Unexpected merge');},
    pullProjectAssets:async(cp,device,assets)=>{h.fileCalls.push(cp.id);if(h.fileHold)await h.fileHold.promise;assets.set(cp.id,[]);return 0;},collectDrawings:()=>[],collectPhotos:()=>[],
    uploadDrawing:async()=>({status:'exists'}),uploadPhoto:async()=>({status:'exists'}),dbGet:async()=>null,dbPut:async()=>{},sha256Hex:async()=>'',uploadAsset:async()=>{},downloadPrivateAsset:async()=>{},readProjectAssets:async()=>[],
    rest:async(path,options={})=>{
      h.calls.push({path,options});if(h.restHook){const value=await h.restHook(path,options);if(value!==undefined)return value;}
      if(path.includes('sentlog_devices'))return options.method?null:[{id:'device-id',active:true,device_name:'現場のiPad'}];
      if(path.includes('sentlog_projects?select='))return [copy(cp)];
      if(path.includes('sentlog_projects?client_key='))return [copy(cp)];
      if(path.includes('sentlog_projects?id='))return null;
      if(path.includes('sentlog_project_snapshots?')){
        if(options.method==='POST'){const v=JSON.parse(options.body);h.server={revision:v.revision,payload:copy(v.payload),updated_at:v.updated_at};return [copy(h.server)];}
        return path.includes('payload')?[copy(h.server)]:[{revision:h.server.revision,updated_at:h.server.updated_at}];
      }
      throw Error('Unexpected REST '+path);
    }};
  context.window.sentlogSyncView={commit:async(cp,snap,expected,options)=>{
    if(!options.expectedRecords.every(([key,v])=>data.get(key)===v))return {applied:false};h.commits++;
    const ws=JSON.parse(data.get(WS));ws.projects=ws.projects.map(p=>p.id===cp.client_key?copy(snap.payload.project):p);
    const writes=[[WS,JSON.stringify(ws)],...snap.payload.drawings.map(d=>[DP+d.meta.id,JSON.stringify(d.state)]),...options.extraWrites];records.batch(writes);return {applied:true};}};
  vm.createContext(context);vm.runInContext(fileHelpers+runtime+'\nprojectSnapshot=collaborationProjectSnapshot;this.testAPI={metadata:collaborationMetadataWorker,files:collaborationFileWorker,device:collaborationEnsureDevice,snapshot:collaborationProjectSnapshot,normalize:collaborationNormalizeStored,pull:collaborationPullProject,upsert:collaborationUpsert,photos:collaborationCollectPhotos,uploadHistorical:collaborationUploadPhoto,round:collaborationMetadataRound,sync:collaborationSyncNow,reset:collaborationSessionChanged};',context);
  h.context=context;h.api=context.testAPI;h.current={owner:'owner-a',assertCurrent(){if(context.session?.user?.id!=='owner-a')throw Object.assign(Error('owner'),{code:'COLLAB_ACCOUNT_CHANGED'});}};
  h.stop=()=>{h.api.metadata.stop();h.api.files.stop();};return h;
}

test('unchanged common file references skip hashing, replacements and same-ID uncertainty keep the legacy guard',()=>{
  const h=fixture(),b=h.base,l=copy(b),r=copy(b);l.drawings[0].state.shapes[0].memo='別のコメント';r.drawings[0].state.shapes[0].point.x=99;
  assert.equal(collaborationCanSkipFileCheck(l,r,b),true);
  l.drawings[0].state.shapes[0].photos.push({id:'new-local',name:'new'});assert.equal(collaborationCanSkipFileCheck(l,r,b),true);
  r.drawings[0].state.shapes[0].photos.push({id:'new-local',name:'new'});assert.equal(collaborationCanSkipFileCheck(l,r,b),false,'a shared ID absent from the baseline still needs byte verification');
  r.drawings[0].state.shapes[0].photos.pop();l.drawings[0].state.shapes[0].photos[0].size=11;assert.equal(collaborationCanSkipFileCheck(l,r,b),false);
  l.drawings[0].state.shapes[0].photos[0].size=10;r.drawings[0].state.pageReplacements={1:{pdfHash:'new'}};assert.equal(collaborationCanSkipFileCheck(l,r,b),false);h.stop();
});
test('normalization imports old-client raw edits once, retains tombstones and local photo caches, and never mutates supplied objects',()=>{
  const h=fixture(),raw=JSON.parse(h.data.get(DP+'d1'));raw.shapes[0].memo='旧版で未送信';raw.shapes[0].point.x=88;raw.shapes[0].photos[0].data='local-cache';
  const tomb=C.markDeleted(C.upgrade({id:'gone',memo:'履歴',photos:[]}),{expectedToken:C.revisionToken({id:'gone',memo:'履歴',photos:[]}),revisionId:'delete-op',actor:{deviceId:'d',deviceName:'端末'},at:2});raw.collabDeletedRecords.push(tomb);h.data.set(DP+'d1',JSON.stringify(raw));const before=stable(raw);
  h.api.normalize(['p1'],h.current);const normalized=JSON.parse(h.data.get(DP+'d1'));
  assert.match(normalized.shapes[0].memo,/旧版で未送信/);assert.equal(normalized.shapes[0].point.x,88);assert.equal(normalized.shapes[0].photos[0].data,'local-cache');assert.deepEqual(normalized.collabDeletedRecords[0],tomb);
  const once=h.data.get(DP+'d1');h.api.normalize(['p1'],h.current);assert.equal(h.data.get(DP+'d1'),once,'normalization does not append the recovered edit twice');
  const snap=h.api.snapshot(h.project);assert.equal(snap.project.collaborationVersion,1);assert.equal(snap.drawings[0].state.shapes[0].photos[0].data,undefined);assert.deepEqual(snap.drawings[0].state.collabDeletedRecords[0],tomb);assert.equal(stable(raw),before);
  const bad=JSON.parse(once);bad.collabDeletedRecords[0].memo='削除後の旧版入力';h.data.set(DP+'d1',JSON.stringify(bad));const saved=h.data.get(DP+'d1');assert.throws(()=>h.api.normalize(['p1'],h.current),/削除済み/);assert.equal(h.data.get(DP+'d1'),saved,'raw late edits on a deleted record remain saved');h.stop();
});

test('a photo deleted before its file pass and tombstoned record photos retain uploadable original IDs',async()=>{
  const h=fixture(),d=JSON.parse(h.data.get(DP+'d1'));
  let r=C.addPhoto(d.shapes[0],{id:'deleted-before-upload',name:'消す前.jpg',size:12},{revisionId:'add-photo',at:4});
  const heads=C.view(r).photos.find(p=>p.id==='deleted-before-upload').headIds;
  r=C.removePhoto(r,'deleted-before-upload',{expectedHeads:heads,revisionId:'remove-photo',at:5});
  const dead=C.markDeleted(r,{expectedToken:C.revisionToken(r),revisionId:'delete-record',at:6});
  d.shapes=[];d.collabDeletedRecords=[dead];h.data.set(DP+'d1',JSON.stringify(d));const before=h.data.get(DP+'d1');
  const items=h.api.photos(h.project);assert.deepEqual(new Set(items.map(p=>p.photo.id)),new Set(['ph1','deleted-before-upload']));assert.equal(items.length,2);assert.equal(h.data.get(DP+'d1'),before);
  const uploaded=[];h.context.uploadPhoto=async(cp,device,item)=>{uploaded.push(item.photo.id);return {status:'uploaded'};};
  h.api.files.request(['p1']);await h.time.tick(0);assert.deepEqual(new Set(uploaded),new Set(['ph1','deleted-before-upload']));
  const item=items.find(p=>p.photo.id==='deleted-before-upload'),assets=new Map([['photo:d1:'+item.photo.id,{byte_size:12,sha256:'original'}]]);
  h.context.dbGet=async()=>new Blob(['different']);h.context.sha256Hex=async()=> 'different';
  await assert.rejects(h.api.uploadHistorical({},'device',item,assets),/上書きせず/);assert.equal(h.data.get(DP+'d1'),before);h.stop();
});
test('device cache uses actual device_name, rechecks activation after 30s and throttles last_seen to 60s',async()=>{
  const h=fixture();assert.equal(await h.api.device(),'device-id');assert.equal(h.context.window.SentlogCollaborationDevice.name,'現場のiPad');
  await h.api.device();assert.equal(h.calls.filter(c=>c.path.includes('sentlog_devices')).length,2);await h.time.tick(30000);await h.api.device();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,1);
  await h.time.tick(30000);await h.api.device();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,2);await h.time.tick(30000);
  h.restHook=async path=>path.includes('sentlog_devices')?[{id:'device-id',active:false,device_name:'停止'}]:undefined;await assert.rejects(h.api.device(),/停止中/);h.stop();
});
test('metadata sends are scoped, use fresh revision for CAS, and never enter original-file I/O',async()=>{
  const h=fixture();const st=JSON.parse(h.data.get(DP+'d1'));st.shapes[0]=C.appendComment(st.shapes[0],'追記',{commentId:'c2',revisionId:'c2-r1',actor:{deviceId:'d',deviceName:'端末'},at:3});h.data.set(DP+'d1',JSON.stringify(st));
  const result=await h.api.round(['p1'],h.current);assert.equal(result.uploaded,1);assert.equal(h.fileCalls.length,0);assert.equal(h.api.files.pending.length,0);
  const heads=h.calls.filter(c=>c.path.includes('sentlog_project_snapshots')&&!c.options.method);assert.equal(heads.length,1,'the freshly pulled head is reused, with no redundant revision GET');
  const write=h.calls.find(c=>c.options.method==='POST');const body=JSON.parse(write.options.body);assert.equal(body.revision,2);assert.equal(body.payload.project.collaborationVersion,1);assert.match(body.payload.drawings[0].state.shapes[0].memo,/追記/);assert.equal(h.context.getSyncMeta('p1').revision,2);h.stop();
});
test('first legacy upgrade without a sync baseline accepts exact content and preserves a real divergent edit',async()=>{
  for(const divergent of [false,true]){
    const h=fixture(),plain=copy(h.base);delete plain.project.collaborationVersion;delete plain.drawings[0].state.collabDeletedRecords;delete plain.drawings[0].state.shapes[0].collab;
    h.server.payload=copy(plain);h.data.set(WS,JSON.stringify({projects:[plain.project]}));
    if(divergent)plain.drawings[0].state.shapes[0].memo='未送信の別内容';
    h.data.set(DP+'d1',JSON.stringify(plain.drawings[0].state));h.data.delete(MP+'p1');
    const result=await h.api.round(['p1'],h.current);
    if(divergent){assert.ok(result.deferredIds.includes('p1'));assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);assert.match(JSON.parse(h.data.get(DP+'d1')).shapes[0].memo,/未送信/);}
    else{assert.equal(result.deferredIds.length,0);assert.equal(h.server.revision,2);assert.equal(h.server.payload.project.collaborationVersion,1);}
    h.stop();
  }
});
test('CAS race keeps project queued for a short fresh read; protocol guard does not get blind retries',async()=>{
  const h=fixture();const st=JSON.parse(h.data.get(DP+'d1'));st.shapes[0].memo='旧版から回収';h.data.set(DP+'d1',JSON.stringify(st));
  h.restHook=async(path,options)=>{if(options.method==='POST')throw Error('別端末の変更があります。同期を再確認してください。');};
  h.api.metadata.request(['p1']);await h.time.tick(0);assert.deepEqual([...h.api.metadata.pending],['p1']);const writes=()=>h.calls.filter(c=>c.options.method==='POST').length;assert.equal(writes(),1);
  await h.time.tick(799);assert.equal(writes(),1);await h.time.tick(1);assert.equal(writes(),2);
  h.restHook=async(path,options)=>{if(options.method==='POST')throw Error('COLLAB_HISTORY_REQUIRED: missing old revision');};await h.time.tick(800);assert.equal(h.api.metadata.retryAt,Infinity);const count=writes();h.api.metadata.request(['p1']);await h.time.tick(60000);assert.equal(writes(),count);h.stop();
});
test('a same-timestamp local edit during hashing prevents incoming commit',async()=>{
  const h=fixture();h.server.revision=2;h.server.payload.drawings[0].state.shapes[0]=C.appendComment(h.server.payload.drawings[0].state.shapes[0],'受信',{commentId:'remote',revisionId:'remote-r',at:3});let once=false;
  h.hashHook=async()=>{if(once)return;once=true;const d=JSON.parse(h.data.get(DP+'d1'));d.shapes[0].point.x=777;h.data.set(DP+'d1',JSON.stringify(d));};
  const r=await h.api.pull(h.context.knownCloudProjects.get('cloud-p1'),h.current);assert.equal(r.deferred,true);assert.equal(h.commits,0);assert.equal(JSON.parse(h.data.get(DP+'d1')).shapes[0].point.x,777);assert.equal(h.context.getSyncMeta('p1').revision,1);h.stop();
});
test('metadata and fresh confirmations finish while original files are blocked; asset events retain an immediate next pass',async()=>{
  const h=fixture();h.fileHold=deferred();h.api.files.request(['p1']);await h.time.tick(0);assert.equal(h.fileCalls.length,1);assert.equal(h.context.syncing,true);
  const st=JSON.parse(h.data.get(DP+'d1'));st.shapes[0].memo='写真転送中の追記';h.data.set(DP+'d1',JSON.stringify(st));
  await h.api.sync({eventDriven:true,projectIds:['p1']});await h.time.tick(0);assert.equal(h.server.revision,2);assert.equal(h.context.syncing,true);
  const fresh=h.context.window.sentlogCollabRefresh('p1');await h.time.tick(0);assert.equal((await fresh).fresh,true);
  h.channel.onChange({kind:'asset',projectId:'cloud-p1'});assert.deepEqual([...h.api.files.pending],['p1']);h.fileHold.resolve();h.fileHold=null;await microtasks();await h.time.tick(0);assert.equal(h.fileCalls.length,2);h.stop();
});
test('metadata success cannot clear unrelated file retry state or claim all files synchronized',async()=>{
  const h=fixture();h.fileHold={promise:Promise.reject(Error('photo download failed'))};h.fileHold.promise.catch(()=>{});
  h.api.files.request(['p1']);await h.time.tick(0);assert.equal(h.context.syncErrorNotBefore,h.time.now()+30000);const retry=h.context.syncErrorNotBefore;
  await h.api.round(['p1'],h.current);assert.equal(h.context.syncErrorNotBefore,retry);assert.notEqual(h.statuses.at(-1).level,'ok');assert.ok(h.api.files.pending.length);h.stop();
});
test('fresh confirmation rejects unavailable, missing, deferred and switched-account reads',async()=>{
  const h=fixture();h.context.navigator.onLine=false;await assert.rejects(h.context.window.sentlogCollabRefresh('p1'),/オンライン/);h.context.navigator.onLine=true;
  const missing=h.context.window.sentlogCollabRefresh('missing').catch(e=>e);await h.time.tick(0);assert.match((await missing).message,/同期対象/);
  const hold=deferred();h.restHook=async path=>{if(path.includes('sentlog_project_snapshots')){await hold.promise;return [{revision:1}];}};
  const old=h.context.window.sentlogCollabRefresh('p1').catch(e=>e);await h.time.tick(0);h.context.session={user:{id:'owner-b'}};h.api.reset();hold.resolve();await microtasks();await h.time.tick(0);assert.equal((await old).code,'COLLAB_ACCOUNT_CHANGED');h.stop();
});
const watchdog=setTimeout(()=>{console.error('FAIL collaboration sync fixture promise did not settle');process.exit(1);},15000);
(async()=>{for(const t of cases){await t.fn();console.log('PASS '+t.name);}console.log('PASS '+cases.length+' collaboration synchronization scenarios');})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));

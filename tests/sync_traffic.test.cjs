'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const helper=fs.readFileSync('sentlog/sync-traffic.js','utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
const digest=async b=>hash(Buffer.from(await b.arrayBuffer()));
const clock={time:100000},scope={user:'owner'};
const disk=new Map(),store={get:async k=>disk.get(k),put:async(k,v)=>disk.set(k,v),remove:async k=>disk.delete(k)};
const context={navigator:{},console};context.window=context;
vm.runInNewContext(helper,context);
const create=(extra={})=>context.SentlogSyncTraffic.create({store,owner:()=>scope.user,now:()=>clock.time,locks:null,...extra});
const original=new Blob(['verified-photo']),sha=hash('verified-photo');
const asset={id:'asset',kind:'photo',sha256:sha,byte_size:original.size,storage_path:'owner/project/photos/p.jpg',status:'uploaded',source_device_id:'other',metadata:{drawing_id:'drawing',photo_id:'photo'},file_name:'p.jpg',mime_type:'image/jpeg',project_id:'project',client_key:'photo:drawing:photo'};
async function ledgerTests(){
 let a=create(),calls=0;const send=async()=>{calls++;return {received:true};};
 const assets=Array.from({length:1339},(_,n)=>({...asset,id:'asset-'+n}));
 for(let round=0;round<12;round++)for(const item of assets)await a.ack('photo',item,'device',send);
 assert.equal(calls,1339,'unchanged cycles must not repeat a successful ACK');
 a=create();for(const item of assets)await a.ack('photo',item,'device',send);
 assert.equal(calls,1339,'confirmed receipts survive a reload');
 for(const item of [{...asset,sha256:hash('changed')},{...asset,byte_size:999},{...asset,storage_path:'new-delivery'},{...asset}])await a.ack('photo',item,'device',send);
 assert.equal(calls,1343,'hash, byte size and delivery path distinguish content');
 await a.ack('photo',asset,'other-device',send);scope.user='other-owner';await a.ack('photo',asset,'device',send);scope.user='owner';
 assert.equal(calls,1345,'device and account scopes are isolated');
 await a.ack('photo',asset,'device',send,{force:true});assert.equal(calls,1346);
 await a.forget('photo',asset,'device');await a.ack('photo',asset,'device',send);assert.equal(calls,1347);
 await Promise.all(Array.from({length:40},()=>a.ack('photo',{...asset,id:'concurrent'},'device',send)));
 assert.equal(calls,1348,'in-flight confirmations are serialized and deduplicated');
 let failures=0;const broken=async()=>{failures++;throw Error('offline');};
 await assert.rejects(a.ack('photo',{...asset,id:'retry'},'device',broken),/offline/);
 await assert.rejects(a.ack('photo',{...asset,id:'retry'},'device',broken),/offline/);assert.equal(failures,1);
 clock.time+=30001;await a.ack('photo',{...asset,id:'retry'},'device',send);assert.equal(calls,1349,'a failed confirmation remains retryable');
 await assert.rejects(a.ack('photo',{...asset,id:'negative'},'device',async()=>({received:false})),/完了/);
 clock.time+=30001;await a.ack('photo',{...asset,id:'negative'},'device',send);assert.equal(calls,1350);
 await assert.rejects(a.ack('photo',{...asset,sha256:'invalid'},'device',send),/情報/);
 const brokenStore={get:async()=>{throw Error('quota');},put:async()=>{throw Error('quota');},remove:async()=>{throw Error('quota');}};
 const fallback=create({store:brokenStore});let fallbackCalls=0;
 await fallback.ack('photo',asset,'device',async()=>{fallbackCalls++;return {received:true};});
 await fallback.ack('photo',asset,'device',async()=>{fallbackCalls++;return {received:true};});assert.equal(fallbackCalls,1);
 let active=0,max=0;
 await Promise.all(Array.from({length:10},()=>a.withFileLock('photo:drawing:photo',async()=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;})));
 assert.equal(max,1,'download/save/check operations are serialized');
 // Browser Web Locks coordinate independent module instances, not just one Map.
 const locks={tails:new Map(),request(k,fn){const next=(this.tails.get(k)||Promise.resolve()).catch(()=>{}).then(fn);this.tails.set(k,next);return next;}};
 const tab1=create({locks}),tab2=create({locks});let tabs=0;
 await Promise.all([tab1,tab2].map(tab=>tab.ack('photo',{...asset,id:'two-tabs'},'device',async()=>{tabs++;return {received:true};})));
 assert.equal(tabs,1);
 console.log('PASS ACK ledger: 1,339 files x 12 cycles, reload, version/device/account scope, concurrency, retry, failed cache, Web Locks');
}
async function receiverTests({saveBroken=false,different=false}={}){
 const local=new Map(different?[['photo:drawing:photo',new Blob(['unsent edit'])]]:[]);
 const cache=new Map(),traffic=create({store:{get:async k=>cache.get(k),put:async(k,v)=>cache.set(k,v),remove:async k=>cache.delete(k)}});
 const calls={download:0,ack:0,write:0},messages=[];
 const read=async key=>local.get(key),write=async(key,blob)=>{calls.write++;if(!saveBroken)local.set(key,blob);};
 const download=async()=>{calls.download++;await new Promise(r=>setImmediate(r));return original;};
 const send=async()=>{calls.ack++;return {received:true};};
 const win={SentlogSyncTraffic:traffic,SentlogRecords:{ready:true,writeFile:write},sentlogSyncView:{photoReceived(){}}};
 const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
 const source=cloud.slice(cloud.indexOf('async function ackAsset('),cloud.indexOf('async function pullRemoteProjects('));
 const cloudApi=vm.runInNewContext(source+';({pullProjectAssets})',{
  Blob,Map,Set,console:{warn(){}},window:win,workspace:()=>({projects:[{id:'local-project',drawings:[{id:'drawing'}]}]}),readProjectAssets:async()=>[asset],dbGet:read,dbPut:write,sha256Hex:digest,downloadPrivateAsset:download,rest:send
 });
 const photos=fs.readFileSync('sentlog/photo-recovery.js','utf8');
 const receiver=photos.slice(photos.indexOf(' async function acknowledgePhoto('),photos.indexOf(' async function provide('));
 const photoApi=vm.runInNewContext(receiver+';({receive})',{
  Blob,File,Set,Map,Date,window:win,currentPhotoKeys:()=>({keys:new Set(['photo:drawing:photo'])}),activeProjectIds:async()=>new Set(['project']),assetList:async()=>[asset],photoKey:(d,p)=>'photo:'+d+':'+p,localPhoto:read,matches:async(b,a)=>b instanceof Blob&&b.size===a.byte_size&&(await digest(b))===a.sha256,downloaded:download,rpc:send,lastRequested:new Map(),show:m=>messages.push(m)
 });
 const cp={id:'project',client_key:'local-project'};
 const first=await Promise.allSettled([cloudApi.pullProjectAssets(cp,'device'),photoApi.receive('device')]);
 if(saveBroken||different){
  assert.equal(calls.ack,0,'failed save or different local bytes cannot be acknowledged');
  assert(messages.some(m=>m.includes('確認が必要')));assert.equal(first[0].status,'rejected');
  if(different){assert.equal(calls.download,0);assert.equal(calls.write,0);assert.equal(await local.get('photo:drawing:photo').text(),'unsent edit');}
 }else{
  assert(first.every(r=>r.status==='fulfilled'));assert.equal(calls.download,1);assert.equal(calls.write,1);assert.equal(calls.ack,1,'normal/recovery paths share one content-specific ACK');
  for(let i=0;i<8;i++){await cloudApi.pullProjectAssets(cp,'device');await photoApi.receive('device');}
  assert.equal(calls.ack,1);assert.equal(calls.download,1);
  local.clear();await photoApi.receive('device');assert.equal(calls.ack,2,'lost local copy must be re-confirmed after verified recovery');
 }
}
async function snapshotTests(){
 const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
 const source=cloud.slice(cloud.indexOf('async function pullRemoteProjects('),cloud.indexOf('async function syncNow('));
 const cp={id:'project',client_key:'local',status:'active'},lp={id:'local',drawings:[]},payload={project:lp,drawings:[]};
 let revision=1,payloadGets=0,fileChecks=0;const meta={revision:1,base_snapshot:payload,fingerprint:'same',fingerprint_schema:2};
 const api=vm.runInNewContext(source+';({pullRemoteProjects})',{
  Map,Set,Number,JSON,SYNC_FINGERPRINT_SCHEMA:2,enc:encodeURIComponent,archive:{canSync:()=>true},syncConflicts:new Map(),getSyncMeta:()=>meta,workspace:()=>({projects:[lp]}),snapshotFingerprint:async()=> 'same',projectSnapshot:()=>payload,setSyncMeta(){},pullProjectAssets:async()=>{fileChecks++;return 0;},
  rest:async path=>{
   if(path.startsWith('/rest/v1/sentlog_projects?'))return [cp];
   if(path.endsWith('&select=revision,updated_at'))return [{revision,updated_at:'date'}];
   if(path.endsWith('&select=revision,payload,updated_at')){payloadGets++;return [{revision,payload,updated_at:'date'}];}
   throw Error('Unexpected request: '+path);
  }
 });
 await api.pullRemoteProjects('device');await api.pullRemoteProjects('device');
 assert.equal(payloadGets,0);assert.equal(fileChecks,2,'unchanged snapshots still check file delivery');
 revision=2;await api.pullRemoteProjects('device');assert.equal(payloadGets,1);
 revision=1;delete meta.base_snapshot;await api.pullRemoteProjects('device');assert.equal(payloadGets,2,'missing baseline forces a full snapshot');
}
async function manualSyncTests(){
 const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
 const source=cloud.slice(cloud.indexOf('async function syncNow('),cloud.indexOf('// Integrated in the cloud module'));
 const alias=cloud.match(/^window\.sentlogArchiveSync=.*;$/m)[0];
 let timestamp=100000,attempts=0,fail=false;const scopes=[],statuses=[];
 const c=vm.createContext({Date:{now:()=>timestamp},Map,Set,Number,JSON,console:{warn(){}},session:{},syncing:false,mergeBusy:false,syncNotBefore:0,
  document:{hidden:false},navigator:{onLine:true},msg(){},refreshMergePanel(){},
  syncStatus:{begin:()=>1,finish:(_,s)=>statuses.push(s.level)},
  archive:{refresh:async()=>{attempts++;if(fail)throw Error('network');}},
  ensureSession:async()=>{},ensureDevice:async()=>'device',workspace:()=>({projects:[]}),
  pullRemoteProjects:async(_,scope)=>{scopes.push(scope);return {changed:0,files:0,blocked:new Set(),conflicts:0};},
  window:{sentlogAppReady:Promise.resolve(),SentlogRecords:{settled:async()=>{},assertSafe(){}}}
 });
 vm.runInContext(source+';'+alias,c);
 await c.syncNow();await c.syncNow();assert.equal(attempts,1,'automatic cycles respect debounce');
 fail=true;await c.window.sentlogArchiveSync();assert.equal(attempts,2);assert.equal(statuses.at(-1),'error');
 fail=false;await c.syncNow();assert.equal(attempts,2,'automatic retries respect error backoff');
 await c.window.sentlogArchiveSync({manualProject:'archived-project'});assert.equal(attempts,3);assert.equal(scopes.at(-1),'archived-project');assert.equal(statuses.at(-1),'ok');
 await c.window.sentlogArchiveSync();assert.equal(attempts,4,'manual retry is not swallowed by debounce');
 c.window.sentlogImporting=true;await c.window.sentlogArchiveSync();assert.equal(attempts,4,'manual operation retains import safety guard');
 c.window.sentlogImporting=false;c.syncing=true;await c.window.sentlogArchiveSync();assert.equal(attempts,4,'manual operation retains single-flight guard');
 c.syncing=false;timestamp+=31000;await c.syncNow();assert.equal(attempts,5);
 assert(cloud.includes('if(done)await syncNow({force:true});'));
 console.log('PASS explicit synchronization: immediate retry and archived-project scope, automatic debounce/backoff, import and single-flight guards');
}
(async()=>{
 await manualSyncTests();await ledgerTests();await receiverTests();await receiverTests({saveBroken:true});await receiverTests({different:true});await snapshotTests();
 const index=fs.readFileSync('sentlog/index.html','utf8'),pc=fs.readFileSync('sentlog-pc/index.html','utf8'),sw=fs.readFileSync('sentlog/sw.js','utf8'),cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
 assert(index.includes("['sync-traffic.js?v=190','SentlogSyncTraffic v1.90']"));assert(index.includes('src="./sync-traffic.js?v=190"'));assert(pc.includes('src="../sentlog/sync-traffic.js?v=190"'));assert(sw.includes("'sync-traffic.js'"));assert(sw.includes('sentlog-pwa-v201'));
 assert(cloud.includes('cycleAssets.get(cp.id)||await readProjectAssets'));
 assert(cloud.includes('if(!options?.force&&Date.now()<syncNotBefore)return;'));
 assert(cloud.includes('syncTimer=setInterval(()=>{if(session&&navigator.onLine&&!document.hidden)syncNow()},15000);'));
 console.log('PASS built receivers: one download and ACK across both paths, corrupt/missing save guards, lost-file recovery, revision-only unchanged fetch, versioned boot');
})().catch(e=>{console.error(e);process.exitCode=1;});

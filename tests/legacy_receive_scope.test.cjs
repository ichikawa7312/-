'use strict';
// Run against the built application. Synthetic sessions, IndexedDB and network
// responses only; the real SessionGuard and guarded file writer are exercised.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{File}=require('node:buffer');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const SESSION='sentlogCloudSessionV1',DEVICE='sentlogCloudDeviceV1';
const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8'),photos=fs.readFileSync('sentlog/photo-recovery.js','utf8');
const scopeStart=cloud.indexOf('function captureAssetReceiveScope('),ackStart=cloud.indexOf('async function ackAsset(');
const scopeExport='window.sentlogCaptureAssetReceiveScope=captureAssetReceiveScope;';
const scopeEnd=cloud.indexOf(scopeExport,scopeStart)+scopeExport.length;
const cloudEnd=cloud.indexOf(cloud.includes('collaboration-sync-v1')?'async function syncNow(':'async function pullRemoteProjects(',ackStart);
const photoStart=photos.indexOf(' async function acknowledgePhoto('),photoEnd=photos.indexOf(' async function provide(',photoStart);
assert(scopeStart>=0&&scopeEnd>scopeStart&&ackStart>=0&&cloudEnd>ackStart&&photoStart>=0&&photoEnd>photoStart,
  'Build the guarded legacy receivers before running their scope tests');
const scopeCode=cloud.slice(scopeStart,scopeEnd),cloudCode=cloud.slice(ackStart,cloudEnd),photoCode=photos.slice(photoStart,photoEnd);
const restStart=cloud.indexOf('async function rest(path,'),restEnd=cloud.indexOf('async function authPassword(',restStart);
const apiStart=photos.indexOf(' async function api('),apiEnd=photos.indexOf(' async function digest(',apiStart);
const ensureCode=cloud.match(/async function ensureSession\(\)\{session=await sessionGuard\.ensure\(\);return session;\}/)?.[0];
const headersStart=cloud.indexOf('const headers='),headersEnd=cloud.indexOf('\n});',headersStart)+4;
assert(restStart>=0&&restEnd>restStart&&apiStart>=0&&apiEnd>apiStart&&ensureCode&&headersEnd>headersStart,
  'Use the real REST/RPC entry points, including their session-refresh await');
const restCode=cloud.slice(restStart,restEnd),apiCode=photos.slice(apiStart,apiEnd),headersCode=cloud.slice(headersStart,headersEnd);
const networkCode=fs.readFileSync('sentlog/sync-network-runtime.txt','utf8');
const hash=async blob=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
function gate(){let release;return {promise:new Promise(r=>release=r),release};}
async function fixture(route,{holdDownload=false,holdReceipt=false,holdEnsure=false}={}){
  const indexedDB=new IDBFactory(),entries=new Map(),events=new Map(),messages=[];
  const storage={get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:k=>entries.get(k)??null,
    setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)};
  const savedSession={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:9999999999,user:{id:'synthetic-owner'}};
  storage.setItem(SESSION,JSON.stringify(savedSession));storage.setItem(DEVICE,'synthetic-device');
  const win={navigator:{},localStorage:storage,fetch:async()=>{throw Error('Live network is forbidden in this fixture');},
    addEventListener:(name,fn)=>events.set(name,fn),sentlogDeltaOwnsProject:()=>false,sentlogDeltaOwnsPhoto:()=>false,
    sentlogSyncView:{canReplaceDrawing:()=>true,fileReceived:async()=>{},photoReceived(){}}};
  const common={window:win,localStorage:storage,navigator:{onLine:true},indexedDB,IDBKeyRange,Blob,File,Response,AbortController,
    queueMicrotask,setTimeout,clearTimeout,console:{warn(){},error:console.error},crypto:webcrypto};
  const context=vm.createContext(common);
  vm.runInContext(fs.readFileSync('sentlog/session-guard.js','utf8'),context);
  const auth=win.SentlogSessionGuard.create({storage,key:SESSION,fetcher:win.fetch,locks:null});
  const ensureStarted=gate(),ensureRelease=gate(),originalEnsure=auth.ensure;let ensureHeld=false;
  auth.ensure=async()=>{if(holdEnsure&&!ensureHeld){ensureHeld=true;ensureStarted.release();await ensureRelease.promise;}return originalEnsure();};
  vm.runInContext(fs.readFileSync('sentlog/record-store.js','utf8'),context);await win.SentlogRecords.init();
  const records=win.SentlogRecords;
  const read=async key=>{const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readonly'),request=tx.objectStore('files').get(key);let result;
    request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}};
  const receiptStarted=gate(),receiptRelease=gate(),cache=new Map();let receiptHeld=false;
  vm.runInContext(fs.readFileSync('sentlog/sync-traffic.js','utf8'),context);
  win.SentlogSyncTraffic=win.SentlogSyncTraffic.create({owner:()=>auth.read()?.user?.id||'',locks:null,store:{
    async get(key){if(holdReceipt&&!receiptHeld){receiptHeld=true;receiptStarted.release();await receiptRelease.promise;}return cache.get(key);},
    put:async(key,value)=>cache.set(key,value),remove:async key=>cache.delete(key)}});
  const kind=route==='drawing'?'drawing':'photo',key=kind==='drawing'?'background:drawing':'photo:drawing:photo';
  const blob=new Blob(['synthetic '+kind+' bytes'],{type:kind==='drawing'?'application/pdf':'image/jpeg'});
  const asset={id:'synthetic-asset',project_id:'synthetic-project',kind,status:'uploaded',source_device_id:'synthetic-peer',
    client_key:kind==='drawing'?'drawing:drawing':key,file_name:kind==='drawing'?'drawing.pdf':'photo.jpg',
    mime_type:blob.type,byte_size:blob.size,sha256:await hash(blob),storage_path:'synthetic-owner/synthetic-project/'+kind,
    metadata:{drawing_id:'drawing',photo_id:'photo'}};
  const calls={download:0,ack:0,write:0,authorization:[]},downloadStarted=gate(),downloadRelease=gate();let downloadHeld=false;
  const download=async()=>{calls.download++;if(holdDownload&&!downloadHeld){downloadHeld=true;downloadStarted.release();await downloadRelease.promise;}return blob;};
  const fetch=async(url,options)=>{
    assert(String(url).includes('/rest/v1/rpc/sentlog_ack_'),'only the synthetic ACK endpoint can be requested');
    calls.ack++;calls.authorization.push(options.headers.Authorization);
    return new Response(JSON.stringify({received:true}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const originalWrite=records.writeFile;records.writeFile=(...args)=>{calls.write++;return originalWrite(...args);};
  const helpers={...common,fetch,sessionGuard:auth,DEVICE_KEY:DEVICE,SUPABASE_URL:'https://synthetic.invalid',SUPABASE_KEY:'synthetic-key',
    BASE:'https://synthetic.invalid',KEY:'synthetic-key',enc:encodeURIComponent,sleep:async()=>{},
    collaborationAssetOwner:'',collaborationAssertOwner(){},
    workspace:()=>({projects:[{id:'local-project',drawings:[{id:'drawing'}]}]}),readProjectAssets:async()=>[asset],
    dbGet:read,sha256Hex:hash,downloadPrivateAsset:download,IS_PC:false,
    currentPhotoKeys:()=>({keys:new Set([key])}),activeProjectIds:async()=>new Set([asset.project_id]),assetList:async()=>[asset],
    photoKey:(d,p)=>'photo:'+d+':'+p,localPhoto:read,matches:async(value,a)=>value instanceof Blob&&value.size===a.byte_size&&(await hash(value))===a.sha256,
    downloaded:download,lastRequested:new Map(),show:message=>messages.push(message)};
  const cloudApi=vm.runInNewContext('let session=sessionGuard.read();'+scopeCode+ensureCode+headersCode+networkCode+restCode+cloudCode+
    ';({pullProjectAssets})',helpers);
  const photoApi=vm.runInNewContext(apiCode+photoCode+';({receive})',{...helpers,session:()=>auth.read()});
  const start=()=>route==='recovery'?photoApi.receive(storage.getItem(DEVICE)):
    cloudApi.pullProjectAssets({id:asset.project_id,client_key:'local-project'},storage.getItem(DEVICE));
  function change(kind){
    if(kind==='owner')auth.set({...savedSession,user:{id:'synthetic-other-owner'}});
    else if(kind==='logout')auth.set(null);
    else if(kind==='device')storage.setItem(DEVICE,'synthetic-other-device');
    else if(kind==='relogin'){auth.set(null);auth.set(savedSession);}
    else if(kind==='refresh')auth.set({...savedSession,access_token:'synthetic-refreshed-access'});
    else throw Error('Unknown synthetic scope change');
  }
  return {start,change,calls,key,blob,read:()=>read(key),records,auth,messages,
    downloadStarted:downloadStarted.promise,releaseDownload:downloadRelease.release,
    receiptStarted:receiptStarted.promise,releaseReceipt:receiptRelease.release,
    ensureStarted:ensureStarted.promise,releaseEnsure:ensureRelease.release,
    seed:async value=>{await originalWrite(key,value);},async close(){await records.settled();}};
}
const scopeChanged=error=>error?.code==='FILE_RECEIVE_SCOPE_CHANGED';
let passed=0;
async function test(name,body){await body();passed++;console.log('PASS',name);}
const watchdog=setTimeout(()=>{console.error('FAIL legacy receive scope fixture did not settle');process.exit(1);},15000);
(async()=>{
  for(const route of ['recovery','photo','drawing']){
    await test(route+': ordinary receive verifies durable bytes and acknowledges once',async()=>{
      const f=await fixture(route);await f.start();assert.equal(await hash(await f.read()),await hash(f.blob));
      assert.equal(f.calls.write,1);assert.equal(f.calls.ack,1);await f.start();
      assert.deepEqual(f.calls.authorization,['Bearer synthetic-access']);
      assert.equal(f.calls.download,1);assert.equal(f.calls.ack,1);await f.close();
    });
    for(const change of ['owner','logout','device','relogin','refresh'])await test(route+': '+change+' during download blocks file save and ACK',async()=>{
      const f=await fixture(route,{holdDownload:true}),operation=f.start();const rejection=assert.rejects(operation,scopeChanged);
      await f.downloadStarted;const generation=f.auth.generation();f.change(change);
      if(change==='relogin')assert(f.auth.generation()>generation,'same-account login must still change the real authentication generation');
      f.releaseDownload();await rejection;assert.equal(await f.read(),undefined);assert.equal(f.calls.write,0);assert.equal(f.calls.ack,0);
      assert.equal(f.records.failed,false);await f.close();
      if(change==='relogin'||change==='refresh'){
        await f.start();assert.equal(await hash(await f.read()),await hash(f.blob));assert.equal(f.calls.ack,1);await f.close();
      }
    });
    await test(route+': generation change after Blob put enqueue aborts the real file transaction',async()=>{
      const f=await fixture(route),put=IDBObjectStore.prototype.put;let interrupted=false;
      IDBObjectStore.prototype.put=function(value,key){const request=put.apply(this,arguments);
        if(!interrupted&&this.name==='files'&&key===f.key){interrupted=true;f.change('relogin');}return request;};
      try{await assert.rejects(f.start(),scopeChanged);}finally{IDBObjectStore.prototype.put=put;}
      assert(interrupted);assert.equal(await f.read(),undefined);assert.equal(f.calls.ack,0);
      assert.equal(f.records.failed,false);await f.close();await f.start();assert.equal(f.calls.ack,1);await f.close();
    });
    await test(route+': same-account relogin while ACK cache is read cannot send an old receipt',async()=>{
      const f=await fixture(route,{holdReceipt:true});await f.seed(f.blob);
      const operation=f.start(),rejection=assert.rejects(operation,scopeChanged);await f.receiptStarted;f.change('relogin');
      f.releaseReceipt();await rejection;assert.equal(f.calls.ack,0);assert.equal(f.calls.write,0);
      assert.equal(await hash(await f.read()),await hash(f.blob));await f.close();
    });
    if(route!=='recovery')for(const change of ['owner','relogin','device'])await test(route+': '+change+' inside real REST session refresh blocks the network ACK',async()=>{
      const f=await fixture(route,{holdEnsure:true});await f.seed(f.blob);
      const operation=f.start(),rejection=assert.rejects(operation,scopeChanged);await f.ensureStarted;f.change(change);
      f.releaseEnsure();await rejection;assert.equal(f.calls.ack,0);assert.equal(f.calls.write,0);
      assert.equal(await hash(await f.read()),await hash(f.blob));await f.close();
    });
  }
  await test('PC page exports a guard from its own SessionGuard and PC device key without cloud-sync',async()=>{
    const pc=fs.readFileSync('sentlog-pc/index.html','utf8'),start=pc.indexOf('function captureAssetReceiveScope('),end=pc.indexOf(scopeExport,start)+scopeExport.length;
    assert(start>=0&&end>start,'the PC page must install its own scope capture');
    const entries=new Map([[SESSION,JSON.stringify({access_token:'synthetic-pc',user:{id:'pc-owner'}})],['sentlogPcWebDeviceV1','pc-device']]);
    const storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
    const win={localStorage:storage,navigator:{},addEventListener(){},fetch:async()=>{throw Error('Live network forbidden');}};
    const context=vm.createContext({window:win,localStorage:storage,DEVICE_KEY:'sentlogPcWebDeviceV1'});
    vm.runInContext(fs.readFileSync('sentlog/session-guard.js','utf8'),context);
    const auth=win.SentlogSessionGuard.create({key:SESSION,storage,fetcher:win.fetch});context.sessionGuard=auth;
    vm.runInContext(pc.slice(start,end),context);const valid=win.sentlogCaptureAssetReceiveScope('pc-device');valid();
    assert.throws(()=>win.sentlogCaptureAssetReceiveScope('phone-device'),scopeChanged);
    const saved=auth.read();auth.set(null);auth.set(saved);assert.throws(valid,scopeChanged);
    win.sentlogCaptureAssetReceiveScope('pc-device')();
  });
  await test('PC photo-recovery module still provides an exact original without loading cloud-sync',async()=>{
    const f=await require('./photo_recovery_pc.test.cjs').fixture();
    assert.equal(f.posts.length,1);assert.deepEqual(f.calls,['claim','finish']);
    assert.equal(await hash(f.original),f.sha);assert.equal(await hash(f.posts[0].bytes),f.sha);
  });
  await test('drawing: cancelled replacement retains the previous durable PDF',async()=>{
    const f=await fixture('drawing'),previous=new Blob(['synthetic prior PDF'],{type:'application/pdf'});await f.seed(previous);
    const put=IDBObjectStore.prototype.put;let interrupted=false;
    IDBObjectStore.prototype.put=function(value,key){const request=put.apply(this,arguments);
      if(!interrupted&&this.name==='files'&&key===f.key){interrupted=true;f.change('owner');}return request;};
    try{await assert.rejects(f.start(),scopeChanged);}finally{IDBObjectStore.prototype.put=put;}
    assert(interrupted);assert.equal(await hash(await f.read()),await hash(previous));assert.equal(f.calls.ack,0);await f.close();
  });
  console.log('PASS legacy receive authentication:',passed,'synthetic cases; actual SessionGuard, file transaction and ACK cache; no live service calls');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));

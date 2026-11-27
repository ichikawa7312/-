'use strict';
// Synthetic transport and disposable FakeIndexedDB. Execute the production
// SessionGuard, bounded download, legacy receiver, receipt cache and writer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto'),{File}=require('node:buffer');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const ROOT=path.resolve(process.env.SENTLOG_BUILT_ROOT||path.join(__dirname,'../..'));
const cloud=fs.readFileSync(path.join(ROOT,'sentlog/cloud-sync.js'),'utf8');
const writer=fs.readFileSync(path.join(ROOT,'sentlog/record-store.js'),'utf8');
const SESSION='sentlogCloudSessionV1',DEVICE='sentlogCloudDeviceV1',WS='surveyFieldNoteWorkspaceV1';
const DRAW='surveyFieldNoteDrawingV1:',SYNC='sentlogCloudProjectSyncV2:',PREFIX='__sentlog_record__:';
const OTHER='synthetic-other-project',ODRAW='synthetic-other-drawing',META='__sentlog_records_meta_v130__';
const STORES=['files','sentlog_delta_control_v1','sentlog_delta_journal_v1'];
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,'production boundary: '+start);return source.slice(a,b);}
const scopeExport='window.sentlogCaptureAssetReceiveScope=captureAssetReceiveScope;';
const scopeCode=section(cloud,'function captureAssetReceiveScope(','async function ensureSession(');
const ensureCode=cloud.match(/async function ensureSession\(\)\{session=await sessionGuard\.ensure\(\);return session;\}/)?.[0];
assert(ensureCode&&scopeCode.includes(scopeExport));
const headersCode=section(cloud,'const headers=','let authNeedsLogin=');
const restCode=section(cloud,'async function rest(path,','async function authPassword(');
const receiveCode=section(cloud,'async function downloadPrivateAsset(','async function syncNow(');
const setMetaCode=section(cloud,'function setSyncMeta(','function projectSnapshot(');
const part=fs.readFileSync(path.join(ROOT,'sentlog/part05.txt'),'utf8');
const persistCode=section(part,'function drawingStorageKey(','function showError(');
const roundCode=section(cloud,'async function collaborationFileRound(','async function collaborationObservedRound(');
const sharedStateCode=section(cloud,'async function collaborationCheckSharedState(','function collaborationProjectFailure(');
const hash=async value=>value===undefined?null:createHash('sha256').update(value instanceof Blob?Buffer.from(await value.arrayBuffer()):String(value)).digest('hex');
function gate(){let release;return {promise:new Promise(resolve=>release=resolve),release};}
async function normalized(value){
  if(value instanceof Blob)return {kind:'Blob',size:value.size,type:value.type,sha256:await hash(value)};
  if(value instanceof Map)return Promise.all([...value].map(async([key,item])=>[key,await normalized(item)]));
  if(Array.isArray(value))return Promise.all(value.map(normalized));
  if(value&&typeof value==='object'){const result={};for(const key of Object.keys(value).sort())result[key]=await normalized(value[key]);return result;}
  return value===undefined?{kind:'undefined'}:value;
}
async function within(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error('Synthetic cloud asset fixture timed out: '+label)),10000);
})]);}finally{clearTimeout(timer);}}
async function fixture(kind='photo',{hold=null}={}){
  const factory=new IDBFactory(),entries=new Map(),events=new Map(),queue=[];
  let holdRecordQueue=false,clock=100000,heldDownload=false,heldReceipt=false;
  const downloadGate=gate(),downloadStarted=gate(),receiptGate=gate(),receiptStarted=gate();
  const storage={get length(){return entries.size;},key:i=>[...entries.keys()][i]??null,getItem:key=>entries.get(key)??null,
    setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key)};
  const session={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:9999999999,user:{id:'synthetic-owner'}};
  storage.setItem(SESSION,JSON.stringify(session));storage.setItem(DEVICE,'synthetic-device');
  const notifications=[],calls={inventory:0,download:0,write:0,ack:0,writesAfterFailure:0,acksAfterFailure:0};
  const win={navigator:{},localStorage:storage,fetch:async()=>{throw Error('Live transport is forbidden');},
    addEventListener:(name,fn)=>events.set(name,fn),sentlogDeltaOwnsProject:()=>false,
    sentlogSyncView:{canReplaceDrawing:()=>true,fileReceived:async()=>notifications.push({kind:'drawing',recordFailed:records.failed}),
      photoReceived:()=>notifications.push({kind:'photo',recordFailed:records.failed})}};
  const common={window:win,localStorage:storage,navigator:{onLine:true},indexedDB:factory,IDBKeyRange,Blob,File,Response,AbortController,
    queueMicrotask:fn=>holdRecordQueue?queue.push(fn):queueMicrotask(fn),setTimeout,clearTimeout,
    console:{warn(){},error:console.error},crypto:webcrypto};
  const context=vm.createContext(common);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'sentlog/session-guard.js'),'utf8'),context);
  const auth=win.SentlogSessionGuard.create({storage,key:SESSION,fetcher:win.fetch,locks:null});
  vm.runInContext(writer,context);const records=win.SentlogRecords;await records.init();
  assert.equal(typeof records.assertSafe,'function','The assembled main app must supply the real Records safety API');
  const key=kind==='drawing'?'background:drawing':'photo:drawing:photo';
  const blob=new Blob(['Synthetic incoming '+kind+' bytes'],{type:kind==='drawing'?'application/pdf':'image/jpeg'});
  const asset={id:'synthetic-asset',project_id:'synthetic-project',kind,status:'uploaded',source_device_id:'synthetic-peer',
    client_key:kind==='drawing'?'drawing:drawing':key,file_name:kind==='drawing'?'synthetic.pdf':'synthetic.jpg',
    mime_type:blob.type,byte_size:blob.size,sha256:await hash(blob),storage_path:'synthetic-owner/synthetic-project/'+kind,
    metadata:{drawing_id:'drawing',photo_id:'photo'}};
  async function disk(store='files'){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readonly'),rows=new Map();tx.objectStore(store).openCursor().onsuccess=e=>{
        const cursor=e.target.result;if(cursor){rows.set(cursor.key,cursor.value);cursor.continue();}};
      tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  const read=async key=>(await disk()).get(key);
  const cache=new Map();
  async function receiptWait(){if(hold==='receipt'&&!heldReceipt){heldReceipt=true;receiptStarted.release();await receiptGate.promise;}}
  vm.runInContext(fs.readFileSync(path.join(ROOT,'sentlog/sync-traffic.js'),'utf8'),context);
  win.SentlogSyncTraffic=win.SentlogSyncTraffic.create({owner:()=>auth.read()?.user?.id||'',locks:null,now:()=>clock,
    store:{get:async key=>{await receiptWait();return cache.get(key);},put:async(key,value)=>cache.set(key,value),
      remove:async key=>{await receiptWait();return cache.delete(key);}}});
  const originalWrite=records.writeFile;
  records.writeFile=(...args)=>{calls.write++;if(records.failed)calls.writesAfterFailure++;return originalWrite(...args);};
  const fetch=async(url,options={})=>{
    if(String(url).includes('/storage/v1/object/authenticated/')){
      calls.download++;if(hold==='download'&&!heldDownload){heldDownload=true;downloadStarted.release();await downloadGate.promise;}
      return new Response(blob);
    }
    assert(String(url).includes('/rest/v1/rpc/sentlog_ack_'),'Unexpected synthetic transport');
    calls.ack++;if(records.failed)calls.acksAfterFailure++;
    assert.equal(options.headers.Authorization,'Bearer synthetic-access');
    return new Response('{"received":true}',{status:200});
  };
  const helpers={...common,fetch,sessionGuard:auth,DEVICE_KEY:DEVICE,SUPABASE_URL:'https://synthetic.invalid',SUPABASE_KEY:'synthetic-public-key',BUCKET:'synthetic-temp',
    enc:encodeURIComponent,sleep:async()=>{},collaborationAssetOwner:'',collaborationAssertOwner(){},
    workspace:()=>JSON.parse(records.getItem(WS)),readProjectAssets:async()=>{calls.inventory++;return [asset];},
    dbGet:read,sha256Hex:hash,syncStatus:{track:async(label,run)=>run()}};
  const network=fs.readFileSync(path.join(ROOT,'sentlog/sync-network-runtime.txt'),'utf8');
  const api=vm.runInNewContext('let session=sessionGuard.read();'+scopeCode+ensureCode+headersCode+network+restCode+receiveCode+';({pullProjectAssets})',helpers);
  const cp={id:asset.project_id,client_key:'local-project',name:'Synthetic receive project',status:'active'};
  function setMeta(revision){const fn=vm.runInNewContext(setMetaCode+';setSyncMeta',{window:{SentlogRecords:records},SYNC_META_PREFIX:SYNC,SYNC_FINGERPRINT_SCHEMA:2});
    fn(OTHER,{revision,fingerprint:'synthetic-'+revision});return {key:SYNC+OTHER,raw:records.getItem(SYNC+OTHER)};}
  function persistOther(){const state=JSON.parse(records.getItem(DRAW+ODRAW));state.shapes[0].memo='Unsaved synthetic other-project memo';
    vm.runInNewContext(persistCode+';persist();',{window:{SentlogRecords:records},WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DRAW,
      workspace:JSON.parse(records.getItem(WS)),state,activeProjectId:OTHER,activeDrawingId:ODRAW,Date,Intl});
    return {key:DRAW+ODRAW,raw:records.getItem(DRAW+ODRAW)};}
  async function failCommit(mutation='metadata'){
    const original=IDBObjectStore.prototype.put;let fired=false,draft;
    IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);
      if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===META){
        fired=true;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}return request;};
    try{draft=mutation==='editor'?persistOther():setMeta(2);await assert.rejects(records.flush(),error=>error.name==='QuotaExceededError');}
    finally{IDBObjectStore.prototype.put=original;}
    assert(fired&&records.failed&&records.pending);assert.equal(records.recordFailureDetails.phase,'commit');return draft;
  }
  const state={shapes:[{id:'synthetic-record',type:'memo',memo:'Preserved synthetic memo',photos:[]}],collabDeletedRecords:[]};
  const projects=[{id:cp.client_key,name:cp.name,drawings:[{id:'drawing',name:'Synthetic drawing'}]},
    {id:OTHER,name:'Synthetic other project',drawings:[{id:ODRAW,name:'Synthetic other drawing'}]}];
  records.batch([[WS,JSON.stringify({projects})],[DRAW+'drawing',JSON.stringify(state)],[DRAW+ODRAW,JSON.stringify(state)]]);
  setMeta(1);await records.settled();
  const preservedKey='photo:'+ODRAW+':preserved',preserved=new Blob(['Preserved original synthetic bytes'],{type:'image/jpeg'});
  await originalWrite(preservedKey,preserved);
  const snapshot=async()=>{const stores={};for(const name of STORES)stores[name]=await normalized(await disk(name));return stores;};
  return {records,auth,storage,win,helpers,api,cp,key,blob,asset,calls,notifications,read,disk,snapshot,failCommit,setMeta,
    start:()=>api.pullProjectAssets(cp,storage.getItem(DEVICE)),preservedKey,preservedSHA256:await hash(preserved),
    downloadStarted:downloadStarted.promise,releaseDownload:downloadGate.release,receiptStarted:receiptStarted.promise,releaseReceipt:receiptGate.release,
    holdPending(){holdRecordQueue=true;},releasePending(){holdRecordQueue=false;for(const fn of queue.splice(0))queueMicrotask(fn);},
    advance:ms=>{clock+=ms;},change(kind){if(kind==='owner')auth.set({...session,user:{id:'synthetic-other-owner'}});
      else if(kind==='device')storage.setItem(DEVICE,'synthetic-other-device');else if(kind==='import')win.sentlogImporting=true;else throw Error('Unknown fence');},
    async assertPreserved(before,draft){assert.deepEqual(await snapshot(),before,'Every durable store must stay unchanged after the failed record commit');
      assert.equal(records.getItem(draft.key),draft.raw,'Unsaved editor memory must be retained');
      assert.notEqual(await read(PREFIX+draft.key),draft.raw,'A failed record commit must not replace prior durable bytes');
      assert.equal(await hash(await read(preservedKey)),await hash(preserved));},
    async retryAndReceive(){await records.retry();assert(!records.failed&&!records.pending);
      // Preserve the existing receipt failure backoff; do not add an ACK API.
      if(hold==='receipt')clock+=30001;await api.pullProjectAssets(cp,storage.getItem(DEVICE));
      assert.equal(await hash(await read(key)),asset.sha256);assert.equal(calls.ack,1);}
  };
}
function fullRound(f){
  const statuses=[];
  const environment={window:f.win,workspace:f.helpers.workspace,pullProjectAssets:f.api.pullProjectAssets,
    collaborationFilePreparation:new Set(),collaborationForcedProjects:new Set(),collaborationMetadataFailures:new Map(),collaborationFileFailures:new Map(),
    collaborationManualProjects:new Map(),collaborationFileWorker:{pending:[],running:false},
    collaborationMetadataWorker:{pending:[],running:false,wait:async()=>({readyIds:[f.cp.client_key],deferredIds:[],failedIds:[],blocked:new Set(),retryById:{},deviceId:'synthetic-device'})},
    knownCloudProjects:new Map([[f.cp.id,f.cp]]),archive:{canSync:()=>true,includeLocal:()=>true},drawingUploadBlocks:new Set(),syncing:false,collaborationAssetOwner:'',syncErrorNotBefore:0,
    syncStatus:{begin:()=>1,finish:(cycle,value)=>statuses.push(value)},collectDrawings:()=>[],collaborationCollectPhotos:()=>[],
    collaborationSharedFailure:()=>false,collaborationProjectFailure:()=>{throw Error('Unexpected classification');},collaborationFailureMessage:()=>'',
    dbGet:f.helpers.dbGet,sha256Hex:hash,downloadPrivateAsset:()=>{throw Error('Unexpected independent download');},readProjectAssets:f.helpers.readProjectAssets,
    dbPut:()=>{throw Error('Unexpected dbPut');},uploadAsset:()=>{throw Error('Unexpected upload');},editSync:{wake(){}},refreshMergePanel(){}};
  const run=vm.runInNewContext(sharedStateCode+roundCode+';collaborationFileRound',environment);
  return {statuses,start:()=>run([f.cp.client_key],{force:true,owner:'synthetic-owner',report(){},assertCurrent(){assert.equal(f.auth.read()?.user?.id,'synthetic-owner');}})};
}
module.exports={fixture,fullRound,within,hash,ROOT,WS,DRAW,SYNC,OTHER,ODRAW,PREFIX,scopeExport,section,
  sourceSHA256:{cloud:createHash('sha256').update(cloud).digest('hex'),writer:createHash('sha256').update(writer).digest('hex')}};

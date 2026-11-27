'use strict';
// A disposable fixture for the production-assembled photo receiver. Every record,
// file, account and transport response below is synthetic. This is not a native
// browser result and does not identify the cause of any customer storage error.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {File}=require('node:buffer'),{webcrypto,createHash}=require('node:crypto');
const {IDBObjectStore}=require('fake-indexeddb');
const root=path.resolve(process.env.SENTLOG_BUILT_ROOT||path.join(__dirname,'../..'));
const {openApplication,digest,WORKSPACE,DRAWING}=require(path.join(root,'tests/helpers/delta_recovery_fixture.cjs'));
const source=fs.readFileSync(path.join(root,'sentlog/photo-recovery.js'),'utf8');
const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
const scopeStart=cloud.indexOf('function captureAssetReceiveScope('),scopeExport='window.sentlogCaptureAssetReceiveScope=captureAssetReceiveScope;';
const scopeEnd=cloud.indexOf(scopeExport,scopeStart)+scopeExport.length;
assert(scopeStart>=0&&scopeEnd>scopeStart,'Use the assembled production receive-scope guard');
const SESSION='sentlogCloudSessionV1',DEVICE_KEY='sentlogCloudDeviceV1',META='__sentlog_records_meta_v130__';
const OWNER='synthetic-owner',DEVICE='synthetic-device',PROJECT='synthetic-cloud-project',LOCAL='synthetic-local-project',DID='synthetic-drawing';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture({count=1,bytes=128,existing=false,deleted=false}={}){
  const assets=[],blobs=new Map(),photos=[];
  for(let n=0;n<count;n++){
    const id='asset-'+String(n).padStart(5,'0'),pid='photo-'+String(n).padStart(5,'0');
    const body=new Uint8Array(bytes);body.fill(n%251);new DataView(body.buffer).setUint32(0,n);
    const blob=new Blob([body],{type:'image/jpeg'});blobs.set(id,blob);photos.push({id:pid,name:'Synthetic photo '+n});
    assets.push({id,project_id:PROJECT,status:deleted?'storage_deleted':'uploaded',kind:'photo',file_name:'synthetic-'+n+'.jpg',mime_type:'image/jpeg',byte_size:blob.size,sha256:await digest(blob),storage_path:OWNER+'/'+PROJECT+'/'+id,metadata:{drawing_id:DID,photo_id:pid}});
  }
  const state={sourceType:'pdf',fileName:'synthetic.pdf',pageCount:1,shapes:[{id:'synthetic-record',type:'memo',memo:'Saved synthetic memo',photos}],collabDeletedRecords:[]};
  const project={id:LOCAL,name:'Synthetic project',drawings:[{id:DID,name:'Synthetic drawing',fileName:'synthetic.pdf',sourceType:'pdf',pageCount:1}]};
  const local=new Map([[WORKSPACE,JSON.stringify({projects:[project]})],[DRAWING+DID,JSON.stringify(state)]]);
  const app=await openApplication({local});
  if(existing)for(const a of assets)await app.records.writeFile('photo:'+DID+':'+a.metadata.photo_id,blobs.get(a.id));
  const session={access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_at:9999999999,user:{id:OWNER}};
  app.localStorage.setItem(SESSION,JSON.stringify(session));app.localStorage.setItem(DEVICE_KEY,DEVICE);
  let clock=Date.parse('2026-01-02T03:04:05Z'),timerSequence=0,draftNumber=0;
  const intervals=[],startup=[],timeouts=new Map(),events=new Map(),hooks={},status={textContent:''},cache=new Map();
  const calls={requests:[],downloads:[],acks:[],writes:[],writeErrors:[],viewUpdates:[],hashBytes:0,hashCalls:0,faults:0};
  const originalWrite=app.records.writeFile;
  app.records.writeFile=async(key,value,options)=>{calls.writes.push(key);if(hooks.beforeWrite)await hooks.beforeWrite(key,value,options);try{return await originalWrite(key,value,options);}catch(e){calls.writeErrors.push({name:e.name,code:e.code,message:e.message});throw e;}};
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const environment={window:null,Blob,File,Response,AbortController,Uint8Array,TextEncoder,ArrayBuffer,URL,Date:ClockDate,console,
    location:{pathname:'/sentlog/'},indexedDB:app.factory,localStorage:app.localStorage,navigator:{onLine:true},
    document:{hidden:false,getElementById:id=>id==='slPhotoRedeliveryStatus'?status:null,querySelector:()=>null,addEventListener:(name,fn)=>events.set('document:'+name,fn)},
    addEventListener:(name,fn)=>events.set(name,fn),SentlogRecords:app.records,sentlogAppReady:Promise.resolve(),
    sentlogDeltaOwnsProject:()=>false,sentlogDeltaOwnsPhoto:()=>false,
    sentlogSyncView:{photoReceived:id=>calls.viewUpdates.push(id)},
    crypto:{subtle:{digest:async(name,buffer)=>{calls.hashCalls++;calls.hashBytes+=buffer.byteLength;if(hooks.beforeDigest)await hooks.beforeDigest(buffer);return webcrypto.subtle.digest(name,buffer);}}},
    setTimeout(fn,ms){const id=++timerSequence;timeouts.set(id,{fn,ms});if(fn.name==='run'&&ms===2500)startup.push({fn,ms});return id;},
    clearTimeout:id=>timeouts.delete(id),setInterval(fn,ms){intervals.push({fn,ms});return ++timerSequence;},
    fetch:async(url,options={})=>{
      const parsed=new URL(url),p=parsed.pathname;calls.requests.push({path:p,method:options.method||'GET'});
      if(p.includes('/storage/')){const id=p.split('/').at(-1);assert(blobs.has(id),'Unexpected synthetic photo');calls.downloads.push(id);if(hooks.onDownload)await hooks.onDownload(id);return new Response(blobs.get(id));}
      if(p.endsWith('/sentlog_projects'))return new Response(JSON.stringify([{id:PROJECT}]));
      if(p.endsWith('/sentlog_assets')){if(hooks.onInventory)await hooks.onInventory();const after=(parsed.searchParams.get('id')||'gt.').slice(3);return new Response(JSON.stringify(assets.filter(a=>a.id>after).slice(0,Number(parsed.searchParams.get('limit')||400))));}
      if(p.endsWith('/sentlog_pdf_requests'))return new Response('[]');
      if(p.endsWith('/rpc/sentlog_ack_photo')){calls.acks.push(JSON.parse(options.body));return new Response('{"received":true}');}
      if(p.endsWith('/rpc/sentlog_request_photo'))return new Response('{"requested":true}');
      throw Error('Unexpected synthetic transport path '+p);
    }};
  environment.window=environment;
  vm.createContext(environment);
  vm.runInContext(fs.readFileSync(path.join(root,'sentlog/session-guard.js'),'utf8'),environment);
  const auth=environment.SentlogSessionGuard.create({storage:app.localStorage,key:SESSION,fetcher:environment.fetch,locks:null,now:()=>clock});
  environment.sessionGuard=auth;environment.DEVICE_KEY=DEVICE_KEY;environment.sentlogManagementSession=()=>auth.ensure();
  vm.runInContext(cloud.slice(scopeStart,scopeEnd),environment);
  vm.runInContext(fs.readFileSync(path.join(root,'sentlog/sync-traffic.js'),'utf8'),environment);
  environment.SentlogSyncTraffic=environment.SentlogSyncTraffic.create({owner:()=>auth.read()?.user?.id||'',locks:null,now:()=>clock,store:{
    get:async key=>{if(hooks.beforeReceiptRead)await hooks.beforeReceiptRead(key);return cache.get(key);},put:async(key,value)=>cache.set(key,value),remove:async key=>cache.delete(key)}});
  const traffic=environment.SentlogSyncTraffic;
  environment.SentlogSyncTraffic={...traffic,ack:(kind,asset,id,send,options)=>traffic.ack(kind,asset,id,async args=>{if(hooks.beforeAck)await hooks.beforeAck(asset);return send(args);},options)};
  vm.runInContext(source,environment);await new Promise(setImmediate);assert.equal(intervals.length,1);assert.equal(intervals[0].ms,60000);assert.equal(startup.length,1);
  const draft=()=>{const key=DRAWING+DID,next=JSON.parse(app.records.getItem(key));next.shapes[0].memo='Unsaved synthetic memo '+(++draftNumber);const raw=JSON.stringify(next);app.records.setItem(key,raw);return {key,raw};};
  const failRecordCommit=async()=>{
    const put=IDBObjectStore.prototype.put;let fired=false;
    IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);
      if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===META){fired=true;calls.faults++;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}return request;};
    let d;try{d=draft();await assert.rejects(app.records.flush(),e=>e.name==='QuotaExceededError');}finally{IDBObjectStore.prototype.put=put;}
    assert(fired);assert(app.records.ready&&app.records.failed&&app.records.pending);return d;
  };
  const metrics=()=>({downloads:calls.downloads.length,writerCalls:calls.writes.length,acknowledgements:calls.acks.length,viewUpdates:calls.viewUpdates.length,hashCalls:calls.hashCalls,hashBytes:calls.hashBytes,recordFailed:app.records.failed,recordPending:app.records.pending,status:status.textContent});
  return {app,assets,blobs,calls,hooks,environment,auth,cache,metrics,failRecordCommit,draft,
    tick:async()=>{clock+=60000;await intervals[0].fn();},online:()=>events.get('online')(),
    async savedPhotoIds(){return [...(await app.disk()).keys()].filter(k=>String(k).startsWith('photo:'));},
    recordDisk:async()=> (await app.disk()).get('__sentlog_record__:'+DRAWING+DID),
    async retry(){await app.records.retry();},changeOwner(){auth.set({...session,user:{id:'synthetic-other-owner'}});},changeDevice(){app.localStorage.setItem(DEVICE_KEY,'synthetic-other-device');}
  };
}
async function deadline(task,ms=30000){let timer;try{return await Promise.race([task,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Probe deadline exceeded')),ms))]);}finally{clearTimeout(timer);}}
module.exports={fixture,deadline,digest,root,source,sha,DRAWING,DID,OWNER,DEVICE};

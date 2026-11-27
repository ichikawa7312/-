'use strict';
// Synthetic, disposable IndexedDB only. The failure detail must explain the
// failed stage without changing atomic rollback/retry or exposing record data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const ROOT=path.resolve(process.env.SENTLOG_STORAGE_SOURCE_ROOT||path.join(__dirname,'..'));
const code=fs.readFileSync(path.join(ROOT,'sentlog/record-store.js'),'utf8');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const META='__sentlog_records_meta_v130__',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const drawingId='private-synthetic-drawing',removedId='private-synthetic-removed';
const scope={ownerId:'private-synthetic-owner',projectId:'private-synthetic-cloud',deviceId:'private-synthetic-device'};
const project={id:'private-synthetic-project',name:'private-synthetic-name',drawings:[{id:drawingId,name:'Synthetic'},{id:removedId,name:'Synthetic removed'}]};
const json=JSON.stringify;
async function fixture(){
  const indexedDB=new IDBFactory(),local=new Map([[WS,json({projects:[project]})],
    [DRAW+drawingId,json({shapes:[],collabDeletedRecords:[]})],[DRAW+removedId,json({shapes:[],collabDeletedRecords:[]})]]);
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto};
  context.window=context;vm.createContext(context);vm.runInContext(code,context);const records=context.SentlogRecords;await records.init();
  await records.deltaJournal.begin({scope,localProjectId:project.id,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'},serverRevision:1});
  await records.deltaJournal.activate({scope,localProjectId:project.id,baselineId:'synthetic-baseline'});
  async function disk(){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
      const stores=['files',LOG,CONTROL],tx=db.transaction(stores,'readonly'),result={};
      for(const name of stores){const s=tx.objectStore(name);let keys,values;
        s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>{values=e.target.result;result[name]=new Map(keys.map((k,i)=>[k,values[i]]));};}
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  const changed=json({shapes:[{id:'private-synthetic-record',memo:'private-synthetic-content 増🧪',photos:[]}],collabDeletedRecords:[]});
  const workspace=json({projects:[{...project,name:'private-synthetic-renamed',drawings:project.drawings.slice(0,1)}]});
  const writes=[[WS,workspace],[DRAW+drawingId,changed],[DRAW+removedId,null]];
  return {records,disk,writes,context};
}
function assertPrivate(detail){
  const text=json(detail);
  for(const value of ['private-synthetic-',WS,DRAW,scope.ownerId,project.name])assert(!text.includes(value),'failure detail exposed record content or an identifier');
  assert.deepEqual(Object.keys(detail).sort(),['errorName','operation','phase','recordValueBytes','recordsToDelete','recordsToWrite','requestedRecords','store','version'].sort());
}
function assertSize(detail,writes){
  assert.equal(detail.requestedRecords,writes.length);
  assert.equal(detail.recordsToWrite,writes.filter(([,v])=>v!==null).length);
  assert.equal(detail.recordsToDelete,writes.filter(([,v])=>v===null).length);
  assert.equal(detail.recordValueBytes,writes.reduce((n,[,v])=>n+(v===null?0:Buffer.byteLength(v,'utf8')),0));
}
async function failAndRetry({store,method,key,stage,measurementFails=false}){
  const f=await fixture(),before=await f.disk(),native=IDBObjectStore.prototype[method];
  const NativeBlob=f.context.Blob;if(measurementFails)f.context.Blob=function(){throw Error('synthetic diagnostic allocation failure');};
  const injected=new DOMException('private-synthetic-error-message','QuotaExceededError');let failedTx,caught;
  IDBObjectStore.prototype[method]=function(...args){
    if(this.name!==store||(key!==undefined&&args[1]!==key))return native.apply(this,args);
    failedTx=this.transaction;
    if(stage==='request-create')throw injected;
    const request=native.apply(this,args);
    if(stage==='request'){
      // Replace only this fake DB's queued operation. The real fake-indexeddb
      // request error, propagation, transaction abort and rollback still run.
      const queued=this.transaction._requests.find(item=>item.request===request);assert(queued);
      queued.operation=()=>{throw injected;};
    }else if(stage==='commit'){
      // Browser commit-time disk errors happen after successful requests. Fake
      // IndexedDB has no disk, so abort after the final write request succeeds.
      request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));
    }
    return request;
  };
  try{f.records.batch(f.writes);await assert.rejects(()=>f.records.flush(),error=>{caught=error;return error.name==='QuotaExceededError';});}
  finally{IDBObjectStore.prototype[method]=native;}
  assert.equal(caught,stage==='request-create'?injected:failedTx.error,'the diagnostic must preserve the original rejection');
  assert.throws(()=>f.records.assertSafe(),error=>error===caught);
  assert.deepEqual(await f.disk(),before,'every object store must roll back atomically');
  for(const [key,value]of f.writes)assert.equal(f.records.getItem(key),value,'unsaved editor state must survive');
  assert.equal(f.records.pending,true);assert.equal(f.records.failed,true);
  const detail=f.records.recordFailureDetails;
  assert(detail,'failed record saves need a safe diagnostic');
  assert.equal(detail.phase,stage);assert.equal(detail.errorName,'QuotaExceededError');
  assert.equal(detail.store,stage==='commit'?null:store);assert.equal(detail.operation,stage==='commit'?null:method);
  assertPrivate(detail);
  if(measurementFails){assert.equal(detail.recordValueBytes,null);assert.equal(detail.requestedRecords,3);assert.equal(detail.recordsToWrite,2);assert.equal(detail.recordsToDelete,1);}
  else assertSize(detail,f.writes);
  detail.phase='modified-by-reader';assert.equal(f.records.recordFailureDetails.phase,stage,'diagnostic snapshots must be defensive copies');
  f.context.Blob=NativeBlob;await f.records.retry();
  assert.equal(f.records.pending,false);assert.equal(f.records.failed,false);assert.equal(f.records.recordFailureDetails,null);
  const after=await f.disk();for(const [key,value]of f.writes)assert.equal(after.files.get(PREFIX+key)??null,value);
  assert.equal(after[LOG].size,before[LOG].size+1,'retry must append exactly one durable journal entry');
}
const cases=[];function test(name,fn){cases.push([name,fn]);}
for(const [label,store,method,key]of [
  ['record','files','put',PREFIX+DRAW+drawingId],
  ['journal',LOG,'add',undefined],
  ['control',CONTROL,'put','clock']
]){
  test(label+' synchronous write failure keeps the original exception, pending records and retry',()=>failAndRetry({store,method,key,stage:'request-create'}));
  test(label+' asynchronous request failure retains its source despite follow-on AbortErrors',()=>failAndRetry({store,method,key,stage:'request'}));
}
test('transaction failure after all successful writes is distinct from a failed request',()=>failAndRetry({store:'files',method:'put',key:META,stage:'commit'}));
test('failed diagnostic byte measurement cannot replace the storage error or lose pending records',()=>failAndRetry({store:'files',method:'put',key:PREFIX+DRAW+drawingId,stage:'request-create',measurementFails:true}));
test('successful writes have no failure detail and do not calculate diagnostic bytes',async()=>{
  const f=await fixture();assert.equal(f.records.recordFailureDetails,null);
  const NativeBlob=f.context.Blob;f.context.Blob=function(){throw Error('normal record commits must not allocate diagnostic blobs');};
  try{f.records.batch(f.writes);await f.records.flush();assert.equal(f.records.recordFailureDetails,null);assert.equal(f.records.failed,false);}
  finally{f.context.Blob=NativeBlob;}
});
// A small DOM test double executes the real UI event handlers. It deliberately
// does not make claims about native rendering, keyboard or mobile layout.
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parent=null;this.attributes={};this.style={};this.dataset={};this.hidden=false;this.open=false;this.disabled=false;this.text='';}
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);if(key==='hidden')this.hidden=true;}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  appendChild(child){this.append(child);return child;}
  before(child){child.parent=this.parent;this.parent.children.splice(this.parent.children.indexOf(this),0,child);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(){}
  matches(selector){return selector[0]==='#'?this.id===selector.slice(1):selector[0]==='.'?(this.className||'').split(/\s+/).includes(selector.slice(1)):this.tagName.toLowerCase()===selector;}
  querySelector(selector){for(const child of this.children){if(child.matches(selector))return child;const found=child.querySelector(selector);if(found)return found;}return null;}
  set innerHTML(html){
    this.children=[];this.text='';const stack=[this];
    for(const token of html.match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){stack.pop();continue;}
      if(token.startsWith('<')){const match=/^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token);if(!match)continue;
        const node=new Element(match[1]);for(const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))node.setAttribute(attribute[1],attribute[2]??'');
        stack[stack.length-1].append(node);if(!['br','input','hr','img','meta','link'].includes(match[1]))stack.push(node);
      }else stack[stack.length-1].text+=token;
    }
  }
}
test('warning UI keeps record-only rescue available after full backup fails and clears no save error',async()=>{
  const head=new Element('head'),body=new Element('body'),modal=new Element('div'),backup=new Element('details');backup.id='sentlogBackupSection';modal.append(backup);body.append(modal);
  let subscriber,chosen=0,retries=0,backups=0;
  const store={failed:false,issues:[],recordFailureDetails:null,subscribe(fn){subscriber=fn;},retry:async()=>{retries++;}};
  const context={window:null,document:{head,body,createElement:tag=>new Element(tag),querySelector:s=>s==='#sentlogSettingsModal .modal-card'?modal:null,
    getElementById:id=>body.querySelector('#'+id)},SentlogRecords:store,navigator:{},addEventListener(){},
    exportSentlogBackup:async options=>{assert.equal(options.allowPending,true);backups++;throw Error('synthetic database open failure');}};
  context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(ROOT,'sentlog/storage-ui.js'),'utf8'),context);
  const warning=body.querySelector('#sentlogStorageWarning'),details=warning.querySelector('.failure-details');
  assert.equal(warning.hidden,true);assert.equal(details.hidden,true);assert.equal(details.open,false);
  store.failed=true;store.issues=[['records','QuotaExceededError']];store.recordFailureDetails={version:1,errorName:'QuotaExceededError',phase:'request',
    store:LOG,operation:'add',requestedRecords:3,recordsToWrite:2,recordsToDelete:1,recordValueBytes:12345};subscriber();
  assert.equal(warning.hidden,false);assert.equal(details.hidden,false);assert.equal(details.open,false);
  assert.match(details.querySelector('.failure-stage').textContent,/変更履歴の保存先/);
  assert.match(details.querySelector('.failure-size').textContent,/書込み 2 件、削除 1 件/);
  assert.match(details.querySelector('.failure-size').textContent,/12,345 B/);
  assert.match(details.textContent,/UTF-8換算/);assert.match(details.textContent,/実際の使用量や必要な空き容量/);
  assert.match(warning.querySelector('.record-rescue-note').textContent,/PDF・写真画像そのものは含まれません/);
  await warning.querySelector('.rescue').onclick();assert.equal(backups,1);
  const result=warning.querySelector('.rescue-result');assert.equal(result.hidden,false);assert.match(result.textContent,/記録だけを案件ごとに書き出す/);
  subscriber();assert.equal(result.hidden,false,'storage notifications must not erase a failed-export explanation');
  // Rescue loads later than the storage panel in the assembled application.
  context.SentlogRecordRescue={chooseProject(){chosen++;}};await warning.querySelector('.record-rescue').onclick();
  assert.equal(chosen,1);assert.equal(retries,0);assert.equal(store.failed,true);assert.equal(warning.hidden,false);
  assert.equal(warning.querySelector('.record-rescue').disabled,false);
  store.recordFailureDetails={...store.recordFailureDetails,phase:'commit',store:null,operation:null,recordValueBytes:null};subscriber();
  assert.match(details.querySelector('.failure-stage').textContent,/個別書込みの完了後/);assert.match(details.querySelector('.failure-size').textContent,/測定できません/);
  details.open=true;store.failed=false;store.issues=[];store.recordFailureDetails=null;subscriber();
  assert.equal(warning.hidden,true);assert.equal(details.hidden,true);assert.equal(details.open,false);assert.equal(result.hidden,true);
});
test('after a connection close the rescue UI exports bounded historical diagnostics without opening storage or retrying',async()=>{
  const head=new Element('head'),body=new Element('body'),modal=new Element('div'),backup=new Element('details');backup.id='sentlogBackupSection';modal.append(backup);body.append(modal);
  const first={sequence:1,observedAt:'2026-01-01T00:00:00.000Z',kind:'record-save-failed',errorName:'QuotaExceededError',nativeMessageClass:'quota-mentioned',
    detail:{version:1,errorName:'QuotaExceededError',phase:'commit',store:null,operation:null,requestedRecords:9,recordsToWrite:9,recordsToDelete:0,recordValueBytes:4098583}};
  const history={version:1,scope:'current-page-memory',capacity:16,droppedEvents:0,firstRecordFailure:first,latestRecordFailure:first,
    current:{connection:'unexpected-close',recordsFailed:true},events:[first,{sequence:2,observedAt:'2026-01-01T00:02:00.000Z',kind:'database-unexpected-close',reason:'not-reported'}]};
  let subscriber,retries=0,backups=0,clicks=0,io=0,failDownload=false;const blobs=[],revoked=[];
  const store={failed:true,pending:true,issues:[['records','Synthetic connection closed']],recordFailureDetails:null,
    get recordFailureHistory(){return JSON.parse(JSON.stringify(history));},subscribe(fn){subscriber=fn;},retry(){retries++;}};
  const context={window:null,document:{head,body,createElement:tag=>{const node=new Element(tag);if(tag==='a'){
    node.click=()=>{if(failDownload)throw Error('/private/path/sensitive-download-error');clicks++;assert.equal(node.download,'sentlog-storage-failure-history.json');};
    node.remove=()=>{if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);};}return node;},
    querySelector:s=>s==='#sentlogSettingsModal .modal-card'?modal:null,getElementById:id=>body.querySelector('#'+id)},
    SentlogRecords:store,navigator:{},Blob,URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:synthetic';},revokeObjectURL:url=>revoked.push(url)},
    setTimeout:fn=>{fn();return 1;},addEventListener(){},exportSentlogBackup(){backups++;}};
  for(const key of ['indexedDB','localStorage'])Object.defineProperty(context,key,{get(){io++;throw Error('History export must not access storage');}});
  context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(ROOT,'sentlog/storage-ui.js'),'utf8'),context);
  const warning=body.querySelector('#sentlogStorageWarning'),area=warning.querySelector('.failure-history'),button=warning.querySelector('.failure-history-export');
  assert(area&&button,'A close warning needs a separate historical export while current quota details are hidden');
  assert.equal(warning.children.filter(node=>node.matches('.failure-details')).length,1,'The existing native rescue detail selector must stay unique');
  assert.equal(warning.querySelector('.failure-details').hidden,true);assert.equal(area.hidden,false);
  assert.match(area.textContent,/この画面/);assert.match(area.textContent,/記録本文/);assert.match(area.textContent,/控えではありません/);
  await button.onclick();assert.equal(clicks,1);assert.equal(blobs.length,1);assert.equal(revoked.length,1);
  assert.deepEqual(JSON.parse(await blobs[0].text()),history);assert.equal(button.disabled,false);
  assert.equal(io,0);assert.equal(retries,0);assert.equal(backups,0);assert.equal(store.failed,true);assert.equal(store.pending,true);
  assert.match(warning.querySelector('.failure-history-result').textContent,/保存を開始/);
  failDownload=true;await button.onclick();assert.equal(button.disabled,false);assert.equal(revoked.length,2);
  assert.match(warning.querySelector('.failure-history-result').textContent,/開始できません/);
  assert(!warning.textContent.includes('/private/path'));assert.equal(io,0);assert.equal(retries,0);assert.equal(backups,0);
  subscriber();assert.equal(warning.hidden,false);assert.equal(area.hidden,false);
});
(async()=>{for(const [name,run]of cases){await run();console.log('PASS '+name);}console.log(cases.length+' record save diagnostic cases passed');})()
  .catch(error=>{console.error(error);process.exitCode=1;});

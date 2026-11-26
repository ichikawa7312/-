'use strict';
// Disposable IndexedDB only. These tests exercise the real writer, its durable
// journal and cross-context races. They do not read or alter user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const scope={ownerId:'owner',projectId:'cloud',deviceId:'device'},localProjectId='project';
const code=fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8');
function point(){let resolve;return {promise:new Promise(r=>resolve=r),resolve};}
function photo(text,type='image/jpeg'){return new Blob([text],{type});}
async function fixture({factory=new IDBFactory(),local=new Map(),activate=true,initializeBinding=true}={}){
  if(!(await factory.databases()).length){
    const meta={id:'drawing',name:'Synthetic',fileName:'',sourceType:null,pageCount:1};
    local.set(WS,JSON.stringify({projects:[{id:localProjectId,name:'Synthetic',drawings:[meta]}]}));
    local.set(DRAW+'drawing',JSON.stringify({fileName:'',sourceType:null,pageCount:1,shapes:[{id:'record',photos:[]}],collabDeletedRecords:[]}));
  }
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const ctx={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,setTimeout,clearTimeout,structuredClone,crypto:webcrypto};ctx.window=ctx;
  vm.createContext(ctx);vm.runInContext(code,ctx);const records=ctx.SentlogRecords;await records.init();
  if(initializeBinding){
    await records.deltaJournal.begin({scope,localProjectId,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'},serverRevision:1});
    if(activate)await records.deltaJournal.activate({scope,localProjectId,baselineId:'base'});
  }
  async function rows(store='files'){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readonly'),s=tx.objectStore(store);let keys,values;
      s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;
      tx.oncomplete=()=>resolve(new Map(keys.map((key,i)=>[key,values[i]])));tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  async function file(key){return (await rows()).get(key);}
  return {factory,local,records,rows,file,context:ctx};
}
function heldSlice(blob){
  const entered=point(),release=point(),slice=blob.slice.bind(blob);let first=true;
  blob.slice=(start,end)=>{const part=slice(start,end);if(first){first=false;const read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{entered.resolve();await release.promise;return read();};}return part;};
  return {entered,release};
}
function watchWaits(context,signal,fast=false){
  const timers=new Set(),listeners=new Set();
  context.setTimeout=(fn,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},fast?Math.min(delay,25):delay);timers.add(timer);return timer;};
  context.clearTimeout=timer=>{timers.delete(timer);clearTimeout(timer);};
  if(signal){
    const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
    signal.addEventListener=(type,listener,options)=>{if(type==='abort')listeners.add(listener);return add(type,listener,options);};
    signal.removeEventListener=(type,listener,options)=>{if(type==='abort')listeners.delete(listener);return remove(type,listener,options);};
  }
  return {timers,listeners};
}
const cases=[];function test(name,fn){cases.push([name,fn]);}
test('the executed writer advertises deduplication before any storage initialization',async()=>{
  const context={window:null,Blob,structuredClone,crypto:webcrypto};context.window=context;
  for(const key of ['indexedDB','localStorage'])Object.defineProperty(context,key,{get(){throw Error('capability probe accessed '+key);}});
  vm.createContext(context);vm.runInContext(code,context);
  assert.equal(context.SentlogRecords.ready,false);
  assert.equal(context.SentlogRecords.getFileWriteCapabilities().fileWriteDedupVersion,1);
  assert.equal(context.SentlogRecords.ready,false);
});
test('the mobile boot guard stops a stale executed writer before init or dependency fetching',async()=>{
  const builder=fs.readFileSync(path.join(__dirname,'../scripts/build_storage_diagnostics.py'),'utf8');
  const guard=JSON.parse(/WRITER_BOOT_CHECK = ("[^\n]+")/.exec(builder)[1]);
  let html=fs.readFileSync(path.join(__dirname,'../sentlog/index.html'),'utf8');
  if(!html.includes(guard))html=html.replace('await window.SentlogRecords.init();',guard+'await window.SentlogRecords.init();');
  const boot=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
  for(const capability of [undefined,null,{}, {fileWriteDedupVersion:0},{fileWriteDedupVersion:1}]){
    let initialized=0,fetched=0;const saved=new Map([['existing-record','preserved']]),nodes=[];
    const records={init(){initialized++;saved.set('existing-record','initialization ran');throw Error('CURRENT_WRITER_INIT');}};
    if(capability!==undefined)records.getFileWriteCapabilities=()=>capability;
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    const current=capability?.fileWriteDedupVersion===1;
    assert.equal(initialized,current?1:0);assert.equal(fetched,0);
    assert.equal(saved.get('existing-record'),current?'initialization ran':'preserved');
    assert(nodes.some(node=>node.textContent?.includes(current?'CURRENT_WRITER_INIT':'保存処理の最新版')));
  }
});
test('repeated identical photo and PDF writes do not multiply durable file histories',async()=>{
  const f=await fixture();
  for(const [key,type]of [['photo:drawing:p','image/jpeg'],['background:drawing','application/pdf']]){
    await f.records.writeFile(key,photo('same bytes',type));
    const before=await f.records.readFileStates([key]);
    for(let i=0;i<20;i++)await f.records.writeFile(key,photo('same bytes',type));
    assert.deepEqual(await f.records.readFileStates([key]),before);
  }
  const rows=[...(await f.rows(LOG)).values()];assert.equal(rows.length,2);
  assert.equal(await (await f.file('photo:drawing:p')).text(),'same bytes');
});
test('same-size changed content retains both versions and a repeat then does nothing',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  await f.records.writeFile(key,photo('other'));await f.records.writeFile(key,photo('other'));
  const rows=[...(await f.rows(LOG)).values()];assert.equal(rows.length,2);
  assert.equal(await rows[1].files[0].before.text(),'first');assert.equal(await rows[1].files[0].after.text(),'other');
});
test('a changed MIME type remains a real file change',async()=>{
  const f=await fixture(),key='background:drawing';await f.records.writeFile(key,photo('same','application/pdf'));
  await f.records.writeFile(key,photo('same','application/octet-stream'));
  assert.equal((await f.rows(LOG)).size,2);assert.equal((await f.file(key)).type,'application/octet-stream');
});
test('identical empty Blobs are safely suppressed',async()=>{
  const f=await fixture(),key='photo:drawing:empty';await f.records.writeFile(key,photo(''));await f.records.writeFile(key,photo(''));
  assert.equal((await f.rows(LOG)).size,1);
});
test('onlyIfMissing keeps its existing collision contract and never compares bytes',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const incoming=photo('other');incoming.slice=()=>{throw Error('must not read');};
  const result=await f.records.writeFile(key,incoming,{onlyIfMissing:true});
  assert.equal(result.written,false);assert.equal(await result.value.text(),'first');assert.equal((await f.rows(LOG)).size,1);
});
test('a guard rejection is not bypassed by identical bytes',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  await assert.rejects(f.records.writeFile(key,photo('first'),{validate:()=>false}),e=>e.code==='FILE_WRITE_GUARD');
  assert.equal((await f.rows(LOG)).size,1);assert.equal(f.records.pending,false);
});
test('guard invalidation while comparing prevents the write',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));let current=true;
  const incoming=photo('first'),hold=heldSlice(incoming),task=f.records.writeFile(key,incoming,{validate:()=>current});
  await hold.entered.promise;current=false;hold.release.resolve();
  await assert.rejects(task,e=>e.code==='FILE_WRITE_GUARD');assert.equal((await f.rows(LOG)).size,1);
});
test('another context changing the file invalidates the comparison and its bytes survive in history',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const other=await fixture({factory:f.factory,local:f.local,initializeBinding:false});
  const incoming=photo('first'),hold=heldSlice(incoming),task=f.records.writeFile(key,incoming);
  await hold.entered.promise;await other.records.writeFile(key,photo('other'));hold.release.resolve();await task;
  const rows=[...(await f.rows(LOG)).values()];assert.equal(rows.length,3);
  assert.equal(await rows[2].files[0].before.text(),'other');assert.equal(await rows[2].files[0].after.text(),'first');
});
test('a cross-context deletion invalidates a completed byte comparison',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const other=await fixture({factory:f.factory,local:f.local,initializeBinding:false});
  const incoming=photo('first'),hold=heldSlice(incoming),task=f.records.writeFile(key,incoming);
  await hold.entered.promise;await other.records.removeFiles([key]);hold.release.resolve();await task;
  const rows=[...(await f.rows(LOG)).values()];assert.equal(rows.length,3);
  assert.equal(rows[2].files[0].before,null);assert.equal(await (await f.file(key)).text(),'first');
});
test('identical legacy PDF receive still obeys the durable staging handover guard',async()=>{
  const f=await fixture({activate:false}),key='background:drawing';await f.records.writeFile(key,photo('pdf','application/pdf'));
  await assert.rejects(f.records.writeFile(key,photo('pdf','application/pdf'),{operation:'legacy-pdf-receive',context:{projectId:scope.projectId},validate:()=>true}),e=>e.code==='JOURNAL_PDF_HANDOVER');
  assert.equal((await f.rows(LOG)).size,1);
});
test('an explicit restore preserves its binding transition even when file bytes match',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const bindingKey='binding:'+localProjectId,binding=(await f.rows(CONTROL)).get(bindingKey);
  const db=await f.records.openFilesDatabase();
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(CONTROL,'readwrite');tx.objectStore(CONTROL).put({...binding,phase:'detached'},bindingKey);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  const result=await f.records.writeFile(key,photo('first'),{operation:'restore'});
  assert.equal(result.written,true);assert.equal((await f.rows(LOG)).size,2);
  assert.equal((await f.rows(CONTROL)).get(bindingKey).phase,'active');
});
test('large candidates use bounded slices and never read the whole incoming Blob',async()=>{
  const f=await fixture(),key='photo:drawing:large',size=5*1024*1024+17;
  const make=()=>new Blob([new Uint8Array(size).fill(23)],{type:'image/jpeg'});
  await f.records.writeFile(key,make());const incoming=make(),slice=incoming.slice.bind(incoming),reads=[];
  incoming.arrayBuffer=()=>{throw Error('whole-file read');};
  incoming.slice=(start,end)=>{reads.push(end-start);return slice(start,end);};
  const result=await f.records.writeFile(key,incoming,{validate:()=>true});
  assert.equal(result.written,false);assert.equal(result.unchanged,true);
  assert.equal(reads.reduce((sum,n)=>sum+n,0),size);assert(reads.every(n=>n<=2*1024*1024));assert.equal((await f.rows(LOG)).size,1);
});
test('optional byte-read failure keeps the original write behavior',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const incoming=photo('first'),slice=incoming.slice.bind(incoming);
  incoming.slice=(start,end)=>{const part=slice(start,end);part.arrayBuffer=()=>Promise.reject(Error('native Blob read failure'));return part;};
  await f.records.writeFile(key,incoming);assert.equal((await f.rows(LOG)).size,2);assert.equal(await (await f.file(key)).text(),'first');
});
test('abort rejects promptly even while a comparison read is stalled',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const incoming=photo('first'),hold=heldSlice(incoming),abort=new AbortController();
  const waits=watchWaits(f.context,abort.signal);
  const task=f.records.writeFile(key,incoming,{signal:abort.signal});
  await hold.entered.promise;abort.abort();await assert.rejects(task,e=>e.code==='FILE_WRITE_ABORTED');hold.release.resolve();
  assert.equal((await f.rows(LOG)).size,1);assert.equal(f.records.pending,false);
  assert.equal(waits.timers.size,0);assert.equal(waits.listeners.size,0);
});
test('a stalled optional comparison times out, cleans up, and ignores its late completion',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));
  const incoming=photo('first'),hold=heldSlice(incoming),abort=new AbortController();
  const waits=watchWaits(f.context,abort.signal,true);
  const task=f.records.writeFile(key,incoming,{signal:abort.signal});await hold.entered.promise;
  const result=await task;assert.equal(result.written,true);assert.equal((await f.rows(LOG)).size,2);
  assert.equal(waits.timers.size,0);assert.equal(waits.listeners.size,0);assert.equal(f.records.pending,false);
  hold.release.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.rows(LOG)).size,2);assert.equal(await (await f.file(key)).text(),'first');
});
test('a guard lost during a stalled comparison rejects instead of saving on timeout',async()=>{
  const f=await fixture(),key='photo:drawing:p';await f.records.writeFile(key,photo('first'));let current=true;
  const incoming=photo('first'),hold=heldSlice(incoming),waits=watchWaits(f.context,null,true);
  const task=f.records.writeFile(key,incoming,{validate:()=>current});await hold.entered.promise;current=false;
  await assert.rejects(task,e=>e.code==='FILE_WRITE_GUARD');hold.release.resolve();
  assert.equal((await f.rows(LOG)).size,1);assert.equal(waits.timers.size,0);assert.equal(f.records.pending,false);
});
(async()=>{for(const [name,fn]of cases){await fn();console.log('PASS '+name);}console.log('Passed '+cases.length+' focused file-write tests.');})().catch(error=>{console.error(error);process.exitCode=1;});


'use strict';
// A rescue must remain available when the durable writer itself cannot commit.
// Only disposable records are used; no network, production browser or files.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const PREFIX='__sentlog_record__:';
const writer=fs.readFileSync('sentlog/record-store.js','utf8');
const modules=[['record-rescue','SentlogRecordRescue','sentlog-record-rescue'],
  ['project-rescue','SentlogProjectRescue','sentlog-project-rescue']];
const codes=new Map(modules.map(([name])=>[name,fs.readFileSync('sentlog/'+name+'.js','utf8')]));
function fixture(){
  const local=new Map(),downloads=[];
  const elements=new Map();
  const ctx={console,JSON,Date,Blob,File,DOMException,queueMicrotask,structuredClone,
    indexedDB:new IDBFactory(),IDBKeyRange,navigator:{canShare:()=>false},setTimeout:()=>{},
    URL:{createObjectURL:file=>{downloads.push(file);return 'blob:synthetic-rescue';},revokeObjectURL(){}},
    localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i]??null,
      getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)},
    document:{querySelector:()=>null,getElementById:id=>elements.get(id)||null,
      body:{append(){}},head:{append(){}},createElement:tag=>({tag,style:{},setAttribute(){},append(){},remove(){},click(){}})},
    alert(){},sentlogAppReady:Promise.resolve()};
  ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(writer,ctx);
  for(const [name] of modules)vm.runInContext(codes.get(name),ctx);
  return {ctx,records:ctx.SentlogRecords,downloads};
}
async function disk(f){
  const db=await f.records.openFilesDatabase();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readonly'),s=tx.objectStore('files');let keys,values;
    s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;
    tx.oncomplete=()=>resolve(new Map(keys.map((k,i)=>[k,values[i]])));tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
  await test('failed atomic save can still export the exact current record snapshot',async()=>{
    const f=fixture();await f.records.init();
    const workspace={projects:[{id:'p1',name:'Synthetic project A',drawings:[{id:'d1'},{id:'d2'}]},
      {id:'p2',name:'Synthetic project B',drawings:[{id:'other'}]}]};
    const initial={shapes:[{id:'s1',memo:'saved value',photos:[{id:'photo-ref'}]}],collabDeletedRecords:[]};
    f.records.batch([[WS,JSON.stringify(workspace)],[DRAW+'d1',JSON.stringify(initial)],
      [DRAW+'d2',JSON.stringify({shapes:[]})],[DRAW+'other',JSON.stringify({shapes:[{id:'unrelated'}]})]]);
    await f.records.settled();
    const before=await disk(f),put=IDBObjectStore.prototype.put;
    const quota=new DOMException('synthetic record write quota','QuotaExceededError');
    IDBObjectStore.prototype.put=function(value,key){
      if(this.name==='files'&&key===PREFIX+DRAW+'d1')throw quota;
      return put.apply(this,arguments);
    };
    const current={...initial,shapes:[{...initial.shapes[0],memo:'unsaved revision',
      photos:[{id:'photo-ref'},{id:'pending-photo-ref'}],points:[{x:0,y:1},{x:2,y:3}]}]};
    try{
      f.records.setItem(DRAW+'d1',JSON.stringify(current));
      await assert.rejects(f.records.settled(),error=>error===quota);
      assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
      const issues=JSON.stringify(f.records.issues);
      for(const [,api,format] of modules){
        const result=await f.ctx[api].build('p1');
        assert.equal(result.payload.format,format);
        assert.deepEqual(JSON.parse(JSON.stringify(result.payload.drawingStates.d1)),current);
        assert.deepEqual(Object.keys(result.payload.drawingStates).sort(),['d1','d2']);
        assert.deepEqual(JSON.parse(JSON.stringify(result.payload.workspace.projects)),[workspace.projects[0]]);
        assert.equal(result.stats.shapes,1);assert.equal(result.stats.photos,2);
        assert.equal(result.stats.unsaved,true);
        assert.equal(result.payload.recovery.pendingOrFailedStorage,true);
        assert.equal(result.payload.recovery.includesFileData,false);
        assert.equal('files' in result.payload,false);
        await f.ctx[api].save('p1');
        const download=JSON.parse(await f.downloads.at(-1).text());
        assert.deepEqual(download.drawingStates.d1,current);
        assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
        assert.equal(JSON.stringify(f.records.issues),issues,'export must not clear the save failure');
      }
      assert.deepEqual(await disk(f),before,'rescue must not retry, modify or delete the durable database');
      assert.equal(f.records.getItem(DRAW+'d1'),JSON.stringify(current));
    }finally{IDBObjectStore.prototype.put=put;}
    await f.records.retry();assert.equal(f.records.failed,false);
    assert.equal((await disk(f)).get(PREFIX+DRAW+'d1'),JSON.stringify(current));
  });
  await test('a pending file transfer cannot block record-only rescue',async()=>{
    const f=fixture();await f.records.init();
    f.records.batch([[WS,JSON.stringify({projects:[{id:'p',name:'Fixture',drawings:[{id:'d'}]}]})],
      [DRAW+'d',JSON.stringify({shapes:[{id:'s',photos:[]}]})]]);await f.records.settled();
    let calls=0;
    f.records.settled=()=>{calls++;return new Promise(()=>{});};
    f.records.assertSafe=()=>{throw Error('synthetic unrelated file failure');};
    f.records.report('file:synthetic','synthetic file failure');
    for(const [,api]of modules){
      const result=await Promise.race([f.ctx[api].build('p'),new Promise((_,reject)=>setTimeout(()=>reject(Error('rescue waited for file storage')),250))]);
      assert.equal(result.stats.shapes,1);assert.equal(result.stats.unsaved,true);
    }
    assert.equal(calls,0);
  });
  await test('uninitialized, missing or malformed records never become a successful empty rescue',async()=>{
    const f=fixture();
    for(const [,api]of modules)await assert.rejects(f.ctx[api].build('p'),/準備/);
    await f.records.init();
    for(const [,api]of modules)await assert.rejects(f.ctx[api].build('missing'),/案件が見つかりません/);
    f.records.batch([[WS,JSON.stringify({projects:[{id:'p',drawings:[{id:'d'}]}]})],[DRAW+'d','broken-json']]);
    for(const [,api]of modules)await assert.rejects(f.ctx[api].build('p'),/Unexpected token/);
    await f.records.settled();
    assert.equal(f.downloads.length,0);
  });
  await test('an unavailable drawing state is disclosed without discarding the recoverable records',async()=>{
    const f=fixture();await f.records.init();
    f.records.batch([[WS,JSON.stringify({projects:[{id:'p',drawings:[{id:'available'},{id:'unavailable'}]}]})],
      [DRAW+'available',JSON.stringify({shapes:[{id:'s',memo:'recoverable content',photos:[]}]})]]);
    await f.records.settled();
    for(const [,api]of modules){
      const result=await f.ctx[api].build('p');
      assert.equal(result.stats.drawings,1);assert.equal(result.stats.missingDrawingStateCount,1);
      assert.equal(result.payload.recovery.missingDrawingStateCount,1);
      assert.equal(result.payload.workspace.projects[0].drawings.length,2);
      assert.equal(result.payload.drawingStates.available.shapes[0].memo,'recoverable content');
      assert.equal(result.payload.recovery.pendingOrFailedStorage,false);
    }
  });
  console.log('PASS record rescue under save failure:',passed,'scenarios');
})().catch(error=>{console.error(error);process.exitCode=1;});

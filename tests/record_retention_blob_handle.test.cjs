'use strict';
// Execute the real writer/replay/ACK. Defer only the optional compact calls
// while preparing an acknowledged WAL, then exercise its actual transaction.
// FakeIndexedDB verifies representation and rollback; native WebKit lifetime
// is covered separately by storage_blob_lifetime_diagnostic.py.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {IDBCursor,IDBDatabase}=require('fake-indexeddb');
const source=path.join(__dirname,'delta_app_journal.test.cjs');
const fixture=fs.readFileSync(source,'utf8').split('let passed=0;async function test(')[0]
  .replace("fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8')",
    "fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||path.join(__dirname,'../sentlog/record-store.js'),'utf8')");
const {app,bind,LOG,CONTROL,scope,localProjectId}=new Function('require','__dirname',fixture+
  '\nreturn {app,bind,LOG,CONTROL,scope,localProjectId};')(createRequire(source),__dirname);
const KEY='photo:drawing-1:retention',jpeg=byte=>new Blob([new Uint8Array(128*1024).fill(byte)],{type:'image/jpeg'});
async function fingerprint(value){
  if(value instanceof Blob)return {blob:true,size:value.size,type:value.type,name:value.name??null,lastModified:value.lastModified??null,
    sha256:createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')};
  if(value instanceof Map)return Promise.all([...value].map(async([key,item])=>[key,await fingerprint(item)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await fingerprint(item)])));
  return value;
}
async function snapshot(f){return fingerprint({files:await f.disk(),journal:await f.disk(LOG),controls:await f.disk(CONTROL)});}
async function acknowledged(values){
  const f=await app();Object.assign(f.ctx,{File,setTimeout,clearTimeout});const e=await bind(f,{metadata:true});
  for(const value of values)if(value===null)await f.records.removeFiles([KEY]);else await f.records.writeFile(KEY,value);
  const compact=f.records.deltaJournal.compact,c=e.controller();let deferred=0;
  f.records.deltaJournal.compact=async()=>{deferred++;return {fixtureDeferred:true};};
  try{await c.controller.drain();}finally{c.close();f.records.deltaJournal.compact=compact;}
  assert(deferred>0,'Real replay must reach optional retention cleanup');
  const rows=[...(await f.disk(LOG)).values()],binding=(await f.disk(CONTROL)).get('binding:'+localProjectId);
  assert.equal(rows.length,values.length);assert(rows.every(row=>row.kind==='sentlog-app-intent'&&row.seq<=binding.ackedSeq));
  assert.equal(binding.lastProof.kind,'durable-replay-proof');
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  return {f,e,rows};
}
async function modifyRows(f,change){const db=await f.records.openFilesDatabase();try{await new Promise((resolve,reject)=>{
  const tx=db.transaction(LOG,'readwrite'),store=tx.objectStore(LOG),q=store.openCursor();
  q.onsuccess=()=>{const c=q.result;if(c){c.update(change(c.value));c.continue();}};
  tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
});}finally{db.close();}}
async function writeTransactions(run){
  const native=IDBDatabase.prototype.transaction,state={active:0,started:0};
  IDBDatabase.prototype.transaction=function(...args){const tx=native.apply(this,args);if(args[1]==='readwrite'){
    state.active++;state.started++;let finished=false;
    const finish=()=>{if(!finished){finished=true;state.active--;}};
    tx.addEventListener('complete',finish,{once:true});tx.addEventListener('abort',finish,{once:true});
  }return tx;};
  try{return await run(state);}finally{IDBDatabase.prototype.transaction=native;}
}
const cases=[],test=(name,fn)=>cases.push([name,fn]);

test('retention copies exact bytes outside write transactions and preserves preimages, receipts and nulls after reopening',async()=>{
  const {f,rows}=await acknowledged([jpeg(66),jpeg(65),null]);
  const receipt={version:1,kind:'sentlog-archived-copy',scope,localProjectId,file:{key:KEY,size:17,sha256:'b'.repeat(64)}};
  await modifyRows(f,row=>({...row,files:row.files.map(file=>({...file,
    ...(file.before===null?{releasedBefore:receipt}:{}),...(file.after===null?{releasedAfter:receipt}:{})}))}));
  const before=await f.disk(LOG),filesBefore=await fingerprint(await f.disk()),update=IDBCursor.prototype.update,read=Blob.prototype.arrayBuffer;
  let replacements=0,byteReads=0,readBytes=0,largestRead=0;
  IDBCursor.prototype.update=function(value){
    if((this.source.objectStore||this.source).name===LOG&&value.kind==='sentlog-file-retention'){
      const original=this.value;
      for(let index=0;index<value.files.length;index++)for(const side of ['before','after']){
        const old=original.files[index][side],next=value.files[index][side];
        if(old instanceof Blob){assert.notStrictEqual(next,old,'Never re-put the same database-backed Blob object');replacements++;}
        else assert.equal(next,old);
      }
    }
    return update.call(this,value);
  };
  try{await writeTransactions(async state=>{
    Blob.prototype.arrayBuffer=function(){assert.equal(state.active,0,'Source bytes must be copied outside every readwrite transaction');
      byteReads++;readBytes+=this.size;largestRead=Math.max(largestRead,this.size);return read.call(this);};
    const result=await f.records.deltaJournal.compact();assert.equal(result.retainedFiles,3);assert.equal(result.removed,0);
    assert.equal(result.copiedBytes,4*128*1024);assert.equal(state.started,1,'All prepared rows commit in one transaction');
  });}
  finally{IDBCursor.prototype.update=update;Blob.prototype.arrayBuffer=read;}
  assert.equal(replacements,4);assert.equal(byteReads,4);assert.equal(readBytes,4*128*1024);assert(largestRead<=2*1024*1024);
  const reopened=await app({factory:f.factory,local:f.local}),after=await reopened.disk(LOG);
  assert.deepEqual([...after.keys()],[...before.keys()]);
  for(const [seq,row]of after){assert.equal(row.kind,'sentlog-file-retention');assert.equal(row.id,before.get(seq).id);
    assert.equal(row.seq,seq);assert.equal(row.version,1);assert.deepEqual(row.projectIds,before.get(seq).projectIds);
    assert.deepEqual(await fingerprint(row.files),await fingerprint(before.get(seq).files));assert.equal(row.proofs[0].proof.kind,'durable-replay-proof');}
  assert.deepEqual(await fingerprint(await reopened.disk()),filesBefore);assert.equal(rows.length,after.size);
});

test('named Files retain name, MIME, lastModified, exact bytes and File representation',async()=>{
  const old=new File([new Uint8Array([0,255,17,128])],'旧写真 日本語.jpg',{type:'image/jpeg',lastModified:1660000000123});
  const next=new File([new Uint8Array([254,0,1,127])],'new photo.jpg',{type:'image/jpeg',lastModified:1660000000999});
  const {f}=await acknowledged([old,next]),before=await f.disk(LOG);
  const result=await f.records.deltaJournal.compact();assert.equal(result.retainedFiles,2);
  const reopened=await app({factory:f.factory,local:f.local}),after=await reopened.disk(LOG);
  for(const [seq,row]of after){assert.deepEqual(await fingerprint(row.files),await fingerprint(before.get(seq).files));
    for(const file of row.files)for(const side of ['before','after'])if(file[side]!==null)assert(file[side] instanceof File);}
  assert.deepEqual(await fingerprint((await reopened.disk()).get(KEY)),await fingerprint(next));
});

test('empty Blobs with an empty MIME are retained without inventing bytes or metadata',async()=>{
  const {f}=await acknowledged([new Blob([]),jpeg(65)]),before=await f.disk(LOG);
  await f.records.deltaJournal.compact();const after=await f.disk(LOG);
  for(const [seq,row]of after)assert.deepEqual(await fingerprint(row.files),await fingerprint(before.get(seq).files));
  assert.equal(after.get(1).files[0].after.size,0);assert.equal(after.get(1).files[0].after.type,'');
});

test('a constructor failure after an earlier prepared image starts no commit and keeps every ACKed WAL byte',async()=>{
  const {f}=await acknowledged([jpeg(66),jpeg(65)]),before=await snapshot(f),update=IDBCursor.prototype.update;let constructed=0,updated=0;
  f.ctx.Blob=new Proxy(Blob,{construct(target,args){if(++constructed===4)throw Object.assign(Error('synthetic Blob allocation failure'),{name:'QuotaExceededError'});return Reflect.construct(target,args);}});
  IDBCursor.prototype.update=function(value){if((this.source.objectStore||this.source).name===LOG)updated++;return update.call(this,value);};
  try{await assert.rejects(()=>f.records.deltaJournal.compact(),/synthetic Blob allocation failure/);}
  finally{f.ctx.Blob=Blob;IDBCursor.prototype.update=update;}
  assert.equal(updated,0,'No original row may be overwritten before all selected bytes are prepared');assert.equal(constructed,4);
  assert.deepEqual(await snapshot(f),before);assert.equal(f.records.failed,false);
  assert.equal((await f.records.deltaJournal.compact()).retainedFiles,2);
});

test('a changed File identity aborts instead of silently replacing the historical metadata',async()=>{
  const {f}=await acknowledged([new File(['old'],'原本.jpg',{type:'image/jpeg',lastModified:1000})]),before=await snapshot(f);
  f.ctx.File=class extends File{constructor(parts,name,options){super(parts,name,{...options,lastModified:options.lastModified+1});}};
  try{await assert.rejects(()=>f.records.deltaJournal.compact(),error=>error.code==='JOURNAL_RETENTION_BLOB');}
  finally{f.ctx.File=File;}
  assert.deepEqual(await snapshot(f),before);assert.equal(f.records.failed,false);
  assert.equal((await f.records.deltaJournal.compact()).retainedFiles,1);
});

test('native cursor update failure rolls back prior converted rows and preserves live files and controls',async()=>{
  const {f}=await acknowledged([jpeg(66),jpeg(65)]),before=await snapshot(f),update=IDBCursor.prototype.update;let calls=0;
  IDBCursor.prototype.update=function(value){if((this.source.objectStore||this.source).name===LOG&&++calls===2)throw Error('synthetic native retention update failure');return update.call(this,value);};
  try{await assert.rejects(()=>f.records.deltaJournal.compact(),/synthetic native retention update failure/);}
  finally{IDBCursor.prototype.update=update;}
  assert.equal(calls,2);assert.deepEqual(await snapshot(f),before);assert.equal(f.records.failed,false);
  assert.equal((await f.records.deltaJournal.compact()).retainedFiles,2);
});

test('unacknowledged and claimed history never enters the Blob conversion path',async()=>{
  for(const claimed of [false,true]){
    const f=await app();f.ctx.File=File;await bind(f,{metadata:true});await f.records.writeFile(KEY,jpeg(66));
    if(claimed)assert(await f.records.deltaJournal.claim({scope,localProjectId}));
    const before=await fingerprint(await f.disk(LOG));let conversions=0;
    f.ctx.Blob=new Proxy(Blob,{construct(){conversions++;throw Error('Unacknowledged Blob conversion is forbidden');}});
    try{const result=await f.records.deltaJournal.compact();assert.equal(result.retainedFiles,0);assert.equal(result.removed,0);}
    finally{f.ctx.Blob=Blob;}
    assert.equal(conversions,0);assert.deepEqual(await fingerprint(await f.disk(LOG)),before);
  }
});

test('unreadable native backing and short byte reads leave the complete pass unchanged without a write transaction',async()=>{
  for(const short of [false,true]){
    const {f}=await acknowledged([jpeg(66),jpeg(65)]),before=await snapshot(f),read=Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer=function(){return short?Promise.resolve(new ArrayBuffer(1)):
      Promise.reject(Object.assign(Error('synthetic native backing missing'),{name:'NotFoundError'}));};
    try{await writeTransactions(async state=>{
      await assert.rejects(()=>f.records.deltaJournal.compact(),short?error=>error.code==='JOURNAL_RETENTION_BYTES':/synthetic native backing missing/);
      assert.equal(state.started,0);
    });}finally{Blob.prototype.arrayBuffer=read;}
    assert.deepEqual(await snapshot(f),before);assert.equal(f.records.failed,false);
  }
});

test('a concurrent file write invalidates the copied pass while preserving the new live file and its original preimage',async()=>{
  const {f}=await acknowledged([jpeg(66),jpeg(65)]),before=await f.disk(LOG),other=await app({factory:f.factory,local:f.local}),read=Blob.prototype.arrayBuffer;let once=true;
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;await other.records.writeFile(KEY,jpeg(67));}return read.call(this);};
  try{await assert.rejects(()=>f.records.deltaJournal.compact(),error=>error.code==='JOURNAL_RETENTION_CHANGED');}
  finally{Blob.prototype.arrayBuffer=read;}
  const after=await f.disk(LOG);for(const [seq,row]of before)assert.deepEqual(await fingerprint(after.get(seq)),await fingerprint(row));
  assert.equal(after.size,before.size+1);const latest=[...after.values()].at(-1);assert.equal(latest.kind,'sentlog-app-intent');
  assert.deepEqual(await fingerprint(latest.files[0].before),await fingerprint(jpeg(65)));
  assert.deepEqual(await fingerprint(latest.files[0].after),await fingerprint(jpeg(67)));
  assert.deepEqual(await fingerprint((await f.disk()).get(KEY)),await fingerprint(jpeg(67)));
});

test('a claim created while bytes are copied invalidates the pass and pins the unsent history',async()=>{
  const {f}=await acknowledged([jpeg(66),jpeg(65)]);await f.records.writeFile(KEY,jpeg(67));
  const before=await fingerprint(await f.disk(LOG)),read=Blob.prototype.arrayBuffer;let once=true,claim;
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;claim=await f.records.deltaJournal.claim({scope,localProjectId});assert(claim);}return read.call(this);};
  try{await assert.rejects(()=>f.records.deltaJournal.compact(),error=>error.code==='JOURNAL_RETENTION_CHANGED');}
  finally{Blob.prototype.arrayBuffer=read;}
  assert.deepEqual(await fingerprint(await f.disk(LOG)),before);
  assert.equal((await f.disk(CONTROL)).get('claim:'+localProjectId).id,claim.id);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).claimId,claim.id);
});

test('large old workspace and record bodies are not serialized or retained in the compaction descriptor',async()=>{
  const {f}=await acknowledged([jpeg(66),jpeg(65)]),long='x'.repeat(9*1024*1024);
  await modifyRows(f,row=>({...row,workspaceBefore:long,workspaceAfter:long,
    changes:[{key:'historical-synthetic',before:long,after:long}]}));
  const liveBefore=await fingerprint(await f.disk());let fullRows=0;
  f.ctx.JSON=new Proxy(JSON,{get(target,key){if(key!=='stringify')return target[key];return function(value,...args){
    if(value&&typeof value==='object'&&(Object.hasOwn(value,'workspaceBefore')||Object.hasOwn(value,'workspaceAfter')||Object.hasOwn(value,'changes'))){fullRows++;throw Error('Whole historical WAL serialization is forbidden');}
    return JSON.stringify(value,...args);
  };}});
  try{assert.equal((await f.records.deltaJournal.compact()).retainedFiles,2);}
  finally{delete f.ctx.JSON;}
  assert.equal(fullRows,0);assert.deepEqual(await fingerprint(await f.disk()),liveBefore);
  assert([...(await f.disk(LOG)).values()].every(row=>row.kind==='sentlog-file-retention'&&!('changes'in row)&&!('workspaceBefore'in row)));
});

(async()=>{for(const [name,run]of cases){await run();console.log('PASS',name);}console.log(`${cases.length} retention Blob handle tests passed`);})()
  .catch(error=>{console.error(error);process.exitCode=1;});

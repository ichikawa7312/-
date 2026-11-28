'use strict';
// Read-only iPhone startup proof on the real writer + fake IndexedDB. No cloud,
// no deletion or mutation of protected PDF/photo bytes to free memory.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {IDBObjectStore,IDBIndex}=require('fake-indexeddb');
const fixturePath=path.join(__dirname,'delta_app_journal.test.cjs');
const fixture=fs.readFileSync(fixturePath,'utf8').split('let passed=0;async function test(')[0];
assert(fixture.includes('navigator:{}'), 'The fixture platform changed');
const mobile=fixture.replace('navigator:{}', "navigator:{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'}");
const {app,bind,edit,scope,localProjectId,WS,DRAW,CONTROL}=
  new Function('require','__dirname',mobile+'\nreturn {app,bind,edit,scope,localProjectId,WS,DRAW,CONTROL};')
  (createRequire(fixturePath),__dirname);
const hash=async blob=>createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const copy=structuredClone;
async function audit(run){
  let cutoffCursor=0,cutoffGet=0;
  const originals=[];
  for(const proto of [IDBObjectStore.prototype,IDBIndex.prototype])for(const name of ['openCursor','get']){
    const old=proto[name];if(typeof old!=='function')continue;
    originals.push([proto,name,old]);
    proto[name]=function(...args){
      const store=this.objectStore?.name||this.name,request=old.apply(this,args);
      if(store===CONTROL){
        if(name==='get'&&typeof args[0]==='string'&&args[0].startsWith('cutoff-file:'))cutoffGet++;
        if(name==='openCursor')request.addEventListener('success',()=>{
          const key=request.result?.primaryKey;
          if(typeof key==='string'&&key.startsWith('cutoff-file:'))cutoffCursor++;
        });
      }
      return request;
    };
  }
  try{const value=await run();return {value,cutoffCursor,cutoffGet};}
  finally{for(const [proto,name,old]of originals)proto[name]=old;}
}

async function main(){
  const f=await app();
  assert.equal(f.records.lazyStartup,true,'iPhone must use the cold-record path');
  const pdf=new Blob([new Uint8Array(2048*1024).fill(0x53)],{type:'application/pdf'});
  const jpeg=new Blob([new Uint8Array(768*1024).fill(0x7b)],{type:'image/jpeg'});
  const originalHashes=[await hash(pdf),await hash(jpeg)];
  await f.records.writeFile('background:drawing-1',pdf);
  await f.records.writeFile('photo:drawing-1:held-original',jpeg);
  await f.records.settled();
  const cutoff=await f.records.deltaJournal.begin({scope,localProjectId,
    actor:{deviceId:scope.deviceId,deviceName:'iPhone現場端末'},serverRevision:9});
  const originalFiles=cutoff.files.filter(x=>x.value instanceof Blob);
  assert(originalFiles.length>=2,'cutoff must contain two real saved originals');
  assert(originalFiles.some(x=>x.key==='background:drawing-1'));
  assert(originalFiles.some(x=>x.key==='photo:drawing-1:held-original'));
  const storedBefore=await f.disk(CONTROL);
  const physicalKeys=[...storedBefore.keys()].filter(k=>typeof k==='string'&&k.startsWith('cutoff-file:'));
  assert(physicalKeys.length>=2);
  const {value:opened,cutoffCursor,cutoffGet}=await audit(()=>app({factory:f.factory,local:f.local}));
  assert.equal(cutoffCursor,0,'opening the normal iPhone app read cutoff-file Blob cursor values');
  assert.equal(cutoffGet,0,'opening the normal iPhone app fetched protected PDF/photo copies');
  assert.equal(opened.records.deltaJournal.bindingStateFor(localProjectId).phase,'staging');
  assert.throws(()=>opened.records.deltaJournal.bindingFor(localProjectId),
    error=>error.code==='JOURNAL_CUTOFF_REF','unhydrated cutoff cannot be mistaken for a complete copy');
  const light=await audit(()=>opened.records.deltaJournal.readBindingState(localProjectId));
  assert.equal(light.value.phase,'staging');
  assert.equal(light.cutoffGet,0,'read-only sync ownership checks must remain light');
  const full=await audit(()=>opened.records.deltaJournal.readCutoff({scope,localProjectId}));
  assert(full.cutoffGet>=physicalKeys.length,'explicit recovery must fetch its protected bytes');
  const recovered=full.value.files.filter(x=>x.value instanceof Blob);
  assert.equal(await hash(recovered.find(x=>x.key==='background:drawing-1').value),originalHashes[0]);
  assert.equal(await hash(recovered.find(x=>x.key==='photo:drawing-1:held-original').value),originalHashes[1]);
  assert.equal(opened.records.deltaJournal.bindingFor(localProjectId).cutoffSeq,cutoff.cutoffSeq);
  assert.equal(opened.records.evictProject(localProjectId),true);
  assert.equal(opened.records.deltaJournal.bindingStateFor(localProjectId).phase,'staging');
  assert.throws(()=>opened.records.deltaJournal.bindingFor(localProjectId),
    error=>error.code==='JOURNAL_CUTOFF_REF','idle cutoff bytes must leave RAM, not the database');
  const readAgain=await opened.records.deltaJournal.readCutoff({scope,localProjectId});
  assert.equal(await hash(readAgain.files.find(x=>x.key==='background:drawing-1').value),originalHashes[0]);
  const storedAfter=await opened.disk(CONTROL);
  assert.deepEqual([...storedAfter.keys()], [...storedBefore.keys()],'no stored row added or removed');
  for(const k of physicalKeys){
    assert.equal(await hash(storedBefore.get(k).value),await hash(storedAfter.get(k).value));
  }
  // A requested original disappearing must fail closed. The reader may show
  // the binding state but cannot manufacture recovered photo/PDF bytes.
  const db=await opened.records.openFilesDatabase();
  const missingKey=physicalKeys[0];
  await new Promise((resolve,reject)=>{const tx=db.transaction(CONTROL,'readwrite');
    tx.objectStore(CONTROL).delete(missingKey);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  await assert.rejects(opened.records.deltaJournal.readCutoff({scope,localProjectId}),
    error=>error.code==='JOURNAL_CUTOFF_REF');
  const beforeFailedBoot=await opened.disk(CONTROL);
  await assert.rejects(app({factory:f.factory,local:f.local}),
    error=>error.code==='JOURNAL_CUTOFF_REF',
    'missing protected PDF/photo key must stop normal startup rather than silently replacing it');
  const afterFailedBoot=await opened.disk(CONTROL);
  assert.deepEqual([...afterFailedBoot.keys()], [...beforeFailedBoot.keys()]);
  console.log('PASS iPhone: no global original-Blob read at launch, light scope checks, exact on-demand recovery, eviction without deletion, missing-proof startup refusal');

  const editor=await app(),bound=await bind(editor,{metadata:true});
  const c=bound.controller();let compactions=0,lastOptions=null;
  const journal=editor.records.deltaJournal,original=journal.compact;
  journal.compact=async options=>{compactions++;lastOptions=copy(options);return {removed:0}};
  try{
    await c.controller.drain();
    assert.equal(compactions,0,'unmodified iPhone polls must not reprocess all historical images');
    edit(editor,'一度保存した変更を確実に送る');
    await editor.records.settled();
    await c.controller.drain();
    assert.equal(compactions,1,'real ACK still schedules bounded retention work');
    assert.deepEqual(lastOptions,{limit:8,scanLimit:64});
  }finally{journal.compact=original;c.close();}
  console.log('PASS iPhone: empty sync does not compact WAL; verified new ACK uses a bounded retention scan');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
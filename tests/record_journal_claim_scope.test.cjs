'use strict';
// Compare the real scoped writer against the frozen v2.14 pending/claim readers
// on the same disposable IndexedDB. Reuse the established compaction fixture,
// including tests/fixtures/record_journal_readers_v214.cjs, without its runner.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const filename=path.join(__dirname,'record_journal_workspace_compaction.test.cjs');
const fixture=new Module(filename,module);fixture.filename=filename;fixture.paths=Module._nodeModulePaths(path.dirname(filename));
const source=fs.readFileSync(filename,'utf8'),boundary=source.indexOf('const cases=[]');
assert(boundary>0,'The existing journal fixture boundary must remain explicit');
fixture._compile(source.slice(0,boundary)+'\nmodule.exports={app,bind,edit,WS,DRAW,CONTROL,scope,pid,actor};',filename);
const {app,bind,edit,WS,DRAW,CONTROL,scope,pid,actor}=fixture.exports;
const json=JSON.stringify,clone=structuredClone;
async function bindOther(f){
  const otherScope={...scope,projectId:'other-cloud'};
  const cutoff=await f.records.deltaJournal.begin({scope:otherScope,localProjectId:'other-project',actor});
  await f.records.deltaJournal.activate({scope:otherScope,localProjectId:'other-project',baselineId:'other-baseline',baselineSnapshot:cutoff.snapshot});
}
async function changeWorkspace(f,change,operation='edit',extra=[]){
  const value=JSON.parse(f.records.getItem(WS));change(value.projects);
  f.records.batch([[WS,json(value)],...extra],{operation});await f.records.settled();
}
let passed=0;
async function claimEquivalent(label,change,validate){
  const f=await app({padding:''});await bind(f);await bindOther(f);await change(f);
  const currentPending=await f.records.deltaJournal.pending({scope,localProjectId:pid});
  const current=await f.records.deltaJournal.claim({scope,localProjectId:pid});assert(current,label+' current claim');validate(current);
  // Remove only the disposable claim so the old reader reconstructs from the
  // exact same immutable WAL and current raw records, rather than returning it.
  const db=await f.records.openFilesDatabase();
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(CONTROL,'readwrite');tx.objectStore(CONTROL).delete('claim:'+pid);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  const old=await app({factory:f.factory,local:f.local,legacyReader:true});
  const oldPending=await old.records.deltaJournal.pending({scope,localProjectId:pid});
  const prior=await old.records.deltaJournal.claim({scope,localProjectId:pid});
  const comparable=value=>{const result=clone(value);delete result.id;delete result.createdAt;return result;};
  assert.deepEqual(comparable(current),comparable(prior),label+' claim differs from frozen production reader');
  assert.deepEqual(clone(currentPending),clone(oldPending),label+' pending differs');passed++;console.log('PASS',label);
}
(async()=>{
  await claimEquivalent('moving a drawing out preserves its original before snapshot despite unrelated later edits',async f=>{
    await edit(f,'edited before move');await changeWorkspace(f,projects=>{projects[1].drawings.push(projects[0].drawings.pop());},'move');
    const value=JSON.parse(f.records.getItem(DRAW+'two'));value.shapes[0].memo='other project';
    f.records.setItem(DRAW+'two',json(value));await f.records.settled();
  },claim=>{assert.equal(claim.before.drawings[0].state.shapes[0].memo,'initial one');assert.equal(claim.after.drawings.length,0);assert.equal(claim.operation,'move');});
  await claimEquivalent('deleting a drawing preserves its deleted raw preimage and records current null as CAS',async f=>{
    await edit(f,'before deletion');await changeWorkspace(f,projects=>{projects[0].drawings=[];},'delete',[[DRAW+'one',null]]);
  },claim=>{assert.equal(claim.before.drawings.length,1);assert.equal(claim.after.drawings.length,0);assert.equal(claim.expectedRecords.find(([key])=>key===DRAW+'one')[1],null);});
  await claimEquivalent('moving an unchanged foreign drawing in fetches both endpoint records',async f=>{
    await changeWorkspace(f,projects=>{projects[0].drawings.push(projects[1].drawings.pop());},'move');
  },claim=>{assert.equal(claim.before.drawings.length,1);assert.equal(claim.after.drawings.length,2);assert.equal(claim.after.drawings[1].state.shapes[0].memo,'initial two');});
  await claimEquivalent('moving an intermediate drawing in then out matches old net snapshots',async f=>{
    await changeWorkspace(f,projects=>{projects[0].drawings.push(projects[1].drawings.pop());},'move');
    await changeWorkspace(f,projects=>{projects[1].drawings.push(projects[0].drawings.pop());},'move');
  },claim=>{assert.equal(claim.before.drawings.length,1);assert.equal(claim.after.drawings.length,1);});
  await claimEquivalent('restore boundary rolls back later deleted content and unrelated workspace edits',async f=>{
    await changeWorkspace(f,projects=>{projects[0].drawings.push(projects[1].drawings.pop());},'restore');
    // Mark only this synthetic restore boundary. The actual reader must stop at
    // it, reconstruct its deleted drawing, and leave subsequent changes pending.
    await f.alterRows(row=>({...row,archiveRestore:{version:1,localProjectId:pid,scope:clone(scope),jobId:'synthetic',certificate:{schema:1}}}));
    await changeWorkspace(f,projects=>{projects[0].drawings=projects[0].drawings.filter(d=>d.id!=='one');},'delete',[[DRAW+'one',null]]);
    await changeWorkspace(f,projects=>{projects[1].name='Unrelated later rename';});
  },claim=>{assert.equal(claim.before.drawings.length,1);assert.equal(claim.after.drawings.length,2);
    assert.equal(claim.after.drawings[0].state.shapes[0].memo,'initial one');
    assert.equal(claim.expectedRecords.find(([key])=>key===DRAW+'one')[1],null);assert.equal(claim.operation,'restore');});
  console.log(JSON.stringify({passed,total:5,actualWriter:true,frozenReaderVersion:'v2.14',disposableIndexedDB:true,nativeBrowserExecuted:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});

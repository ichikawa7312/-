'use strict';
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
globalThis.crypto=webcrypto;
const Audit=require('../sentlog/delta-sync-legacy-preflight.js');
const id='offline-project',drawing='drawing-1';
const enc=x=>JSON.stringify(x);
const photo={id:'photo-1',name:'near.jpg'};
const ws=()=>enc({projects:[{id,name:'テスト橋梁',drawings:[{id:drawing}]}]});
const st=()=>enc({shapes:[{id:'survey-1',type:'調査',memo:'圏外の所見',photos:[photo]}]});
function fixture(){
  const data=new Map([['surveyFieldNoteWorkspaceV1',ws()],
    ['surveyFieldNoteDrawingV1:'+drawing,st()]]);
  const files=new Map([['photo:'+drawing+':'+photo.id,new Blob(['photo-bytes'],{type:'image/jpeg'})]]);
  let writes=0,reads=0,pending=false,failed=false;
  const legacy={get ready(){return true;},get pending(){return pending;},get failed(){return failed;},
    uncommittedFiles:()=>[],getItem:k=>{reads++;return data.get(k)??null;},
    setItem:()=>{writes++;throw Error('audit must not write');},removeItem:()=>{writes++;throw Error('audit must not delete');}};
  return {data,files,legacy,readFile:async key=>files.get(key)||null,
    get writes(){return writes;},get reads(){return reads;},
    set pending(v){pending=v;},set failed(v){failed=v;}};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS',name);}
async function throws(fn,code){await assert.rejects(fn,e=>e.code===code);}
(async()=>{
 await test('verified photo and record counts without ever changing legacy DB',async()=>{
  const f=fixture(),a=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(a.recordCount,1);assert.equal(a.photoRefs,1);
  assert.equal(a.verifiedLocalFiles,1);assert.equal(a.needsPhotoRecovery,0);
  assert.equal(a.readyForStaging,true);assert.equal(a.readyForCloudSync,false);
  assert.equal(a.cloudComparisonRequired,true);assert.equal(f.writes,0);
  assert.deepEqual(JSON.parse(f.data.get('surveyFieldNoteDrawingV1:'+drawing)).shapes[0].photos,[photo]);
 });
 await test('stored records are never mistaken for confirmed cloud receipts',async()=>{
  const f=fixture();
  f.data.set('sentlogCloudProjectSyncV2:'+id,enc({revision:916,local_updated_at:1}));
  const r=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(r.readyForCloudSync,false);assert.equal(f.writes,0);
 });
 await test('offline unsaved changes block migration rather than resetting them',async()=>{
  const f=fixture();f.pending=true;
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id}),'LEGACY_AUDIT_PENDING');
  assert.equal(f.writes,0);
 });
 await test('storage errors block the audit and preserve the old state',async()=>{
  const f=fixture();f.failed=true;
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id}),'LEGACY_AUDIT_PENDING');
  assert.equal(f.writes,0);
 });
 await test('a missing photo keeps the record and produces a recovery list',async()=>{
  const f=fixture();f.files.clear();
  const result=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(result.recordCount,1);assert.equal(result.needsPhotoRecovery,1);
  assert.equal(result.problems[0].kind,'photo-recovery-required');
  assert.equal(result.readyForStaging,false);assert.equal(f.writes,0);
 });
 await test('same-size corrupt JPEG bytes do not count as verified',async()=>{
  const f=fixture(),bytes='photo-bytes';
  f.data.set('surveyFieldNoteDrawingV1:'+drawing,enc({shapes:[{id:'survey-1',photos:[{
    ...photo,size:bytes.length,sha256:'0'.repeat(64)
  }]}]}));
  const r=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(r.verifiedLocalFiles,0);assert.equal(r.problems[0].kind,'photo-content-mismatch');
  assert.equal(f.writes,0);
 });
 await test('duplicate record IDs do not silently overwrite a second user record',async()=>{
  const f=fixture();const a=JSON.parse(st()).shapes[0];
  f.data.set('surveyFieldNoteDrawingV1:'+drawing,enc({shapes:[a,{...a,memo:'他の記録'}]}));
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id}),'LEGACY_DUPLICATE_RECORD');
  assert.equal(f.writes,0);
 });
 await test('two different photographs sharing one storage key are not confused',async()=>{
  const f=fixture();const a=JSON.parse(st()).shapes[0];
  f.data.set('surveyFieldNoteDrawingV1:'+drawing,enc({shapes:[a,{id:'other',photos:[{
    ...photo,name:'other-photo.jpg'
  }]}]}));
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id}),'LEGACY_PHOTO_COLLISION');
 });
 await test('missing drawing state is reported rather than silently zeroed',async()=>{
  const f=fixture();f.data.delete('surveyFieldNoteDrawingV1:'+drawing);
  const r=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(r.recordCount,0);assert.equal(r.readyForStaging,false);
  assert(r.problems.some(x=>x.kind==='missing-drawing-state'));
 });
 await test('unreadable JSON retains the exact old string for manual rescue',async()=>{
  const f=fixture();f.data.set('surveyFieldNoteDrawingV1:'+drawing,'{unreadable');
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id}),'LEGACY_UNREADABLE');
  assert.equal(f.data.get('surveyFieldNoteDrawingV1:'+drawing),'{unreadable');
 });
 await test('a concurrent edit during reading refuses the result without deleting data',async()=>{
  const f=fixture(),before=f.data.get('surveyFieldNoteWorkspaceV1');
  const reader=async key=>{
    f.data.set('surveyFieldNoteWorkspaceV1',before.replace('テスト橋梁','テスト橋梁 編集中'));
    return f.readFile(key);
  };
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:reader,projectId:id}),'LEGACY_AUDIT_CHANGED');
  assert.equal(f.writes,0);
 });
 await test('unknown project cannot be treated as an empty fully migrated project',async()=>{
  const f=fixture();
  await throws(()=>Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:'wrong-project'}),'LEGACY_PROJECT_MISSING');
 });
 await test('large record arrays keep count stable without making a cloud-success claim',async()=>{
  const f=fixture(),shapes=Array.from({length:1002},(_,i)=>({id:'record-'+i,memo:'記録',photos:[]}));
  f.data.set('surveyFieldNoteDrawingV1:'+drawing,enc({shapes}));
  const report=await Audit.inspect({legacy:f.legacy,readFile:f.readFile,projectId:id});
  assert.equal(report.recordCount,1002);assert.equal(report.readyForCloudSync,false);
  assert.equal(f.writes,0);
 });
 console.log('PASS legacy read-only migration preflight:',count,'cases (no source edits, no cloud writes)');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

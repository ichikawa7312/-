'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{execFileSync}=require('node:child_process'),path=require('node:path');
const Capacity=require('../sentlog/delta-sync-capacity.js'),C=require('../sentlog/archive-core.js');
const copy=x=>structuredClone(x),WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOCAL='sentlogArchiveLocalV1';
function fixture({delta=true,missing=false}={}){
 const project={id:'local-project',name:'Project',drawings:[{id:'drawing',name:'Drawing'}]},state={shapes:[],pageSettings:{1:{scale:100}},currentPage:3,width:1200,labelSize:18};
 const payload={project:copy(project),drawings:[{meta:copy(project.drawings[0]),state:{...copy(state),currentPage:1,width:900,labelSize:12}}]};
 const cp={id:'server-project',client_key:project.id,status:'archived'},certificate={schema:1,projectId:cp.id,headSeq:7,revision:8,payloadSha256:'a'.repeat(64)};
 const info={job:{id:'job',project_id:cp.id,revision:8,payload,...(delta?{delta_checkpoint:certificate}:{})},files:[{key:'background:drawing'}]};
 const memory=new Map([[WS,JSON.stringify({projects:missing?[]:[project]})],...(missing?[]:[[DRAW+'drawing',JSON.stringify(state)]])]);
 let scope={ownerId:'owner',deviceId:'device'},generation=2,sequence=9,proofVersion=1,proofCalls=0,validateCalls=0,readHook=null;
 const records={ready:true,getItem:key=>memory.get(key)??null,settled:async()=>{},assertSafe:()=>{},writerState:()=>({generation,pending:0,failed:false}),
  readFileStates:async keys=>{if(readHook)await readHook();return keys.map(key=>({key,sequence}));}};
 const archiveProof=async()=>{proofCalls++;const version=proofVersion;return {schema:1,pending:0,headSeq:7,cursor:missing?null:7,revision:8,payloadSha256:'a'.repeat(64),...(missing?{absent:true}:{}),validate:async()=>{validateCalls++;if(version!==proofVersion)throw Object.assign(Error('replica changed'),{code:'REPLICA_CHANGED'});}};};
 const options={records,cloudProject:cp,info,archiveProof,getScope:()=>scope,snapshotText:C.snapshotText};
 return {options,records,memory,info,cp,get proofCalls(){return proofCalls;},get validateCalls(){return validateCalls;},scope:next=>scope=next,
  localFileChange(){generation++;sequence++;},otherTabFileChange(){sequence++;},replicaChange(){proofVersion++;},readHook(fn){readHook=fn;}};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
 await test('certified delta proof accepts local view differences and captures exact drawing rows',async()=>{
  const f=fixture();assert.notEqual(C.snapshotText({project:JSON.parse(f.memory.get(WS)).projects[0],drawings:[{meta:f.info.job.payload.drawings[0].meta,state:JSON.parse(f.memory.get(DRAW+'drawing'))}]}),C.snapshotText(f.info.job.payload));
  const proof=await Capacity.createProof({...f.options,snapshotText:()=>{throw Error('legacy comparison must not run');}});assert.equal(proof.delta,true);assert.equal(f.proofCalls,1);assert(proof.expectedRecords.some(([key])=>key===DRAW+'drawing'));assert(proof.expectedRecords.some(([key])=>key===LOCAL));assert.deepEqual(proof.expectedFileStates,[{key:'background:drawing',sequence:9}]);assert.equal(await proof.validate(),true);
 });
 await test('legacy archive still requires matching snapshot bytes',async()=>{
  const f=fixture({delta:false});await assert.rejects(()=>Capacity.createProof(f.options),{code:'DELTA_CAPACITY_CHANGED'});
  f.memory.set(DRAW+'drawing',JSON.stringify(f.info.job.payload.drawings[0].state));const proof=await Capacity.createProof(f.options);assert.equal(proof.delta,false);assert.equal(f.proofCalls,0);
 });
 await test('a drawing-only edit is caught even if workspace bytes never change',async()=>{
  const f=fixture(),proof=await Capacity.createProof(f.options),raw=f.memory.get(WS);const state=JSON.parse(f.memory.get(DRAW+'drawing'));state.pageSettings['1'].scale=200;f.memory.set(DRAW+'drawing',JSON.stringify(state));assert.equal(f.memory.get(WS),raw);assert.throws(()=>proof.validateSync(),{code:'DELTA_CAPACITY_CHANGED'});
 });
 await test('same-size local file replacement during hashing invalidates the synchronous deletion guard',async()=>{
  const f=fixture(),proof=await Capacity.createProof(f.options);f.localFileChange();assert.throws(()=>proof.validateSync(),{code:'DELTA_CAPACITY_CHANGED'});await assert.rejects(()=>proof.validate(),{code:'DELTA_CAPACITY_CHANGED'});
 });
 await test('another tab file replacement invalidates durable generation proof without an in-memory change',async()=>{
  const f=fixture(),proof=await Capacity.createProof(f.options);f.otherTabFileChange();assert.equal(proof.validateSync(),true);await assert.rejects(()=>proof.validate(),{code:'DELTA_CAPACITY_CHANGED'});assert.equal(proof.expectedFileStates[0].sequence,9);
 });
 await test('late delta revisions and account changes each prevent capacity writes',async()=>{
  const f=fixture(),proof=await Capacity.createProof(f.options);f.replicaChange();await assert.rejects(()=>proof.validate(),{code:'REPLICA_CHANGED'});
  const g=fixture(),other=await Capacity.createProof(g.options);g.scope({ownerId:'foreign',deviceId:'device'});assert.throws(()=>other.validateSync(),{code:'DELTA_CAPACITY_SCOPE'});
 });
 await test('project restore guards absent target drawing rows and existing capacity state',async()=>{
  const f=fixture({missing:true});f.memory.set(LOCAL,JSON.stringify({'server-project':{mode:'project',job_id:'job'}}));const proof=await Capacity.createProof({...f.options,mode:'restore-project'});
  assert.equal(proof.p,null);assert(proof.expectedRecords.some(([key,value])=>key===DRAW+'drawing'&&value===null));f.memory.set(DRAW+'drawing',JSON.stringify({shapes:[]}));assert.throws(()=>proof.validateSync(),{code:'DELTA_CAPACITY_CHANGED'});
 });
 await test('cleanup never treats an absent project proof as permission to remove data',async()=>{
  const f=fixture({missing:true});await assert.rejects(()=>Capacity.createProof(f.options),{code:'DELTA_CAPACITY_PROOF'});
 });
 await test('retained drawing IDs cannot overlap another project during cleanup or restore',async()=>{
  const f=fixture(),ws=JSON.parse(f.memory.get(WS));ws.projects[0].deltaMetadata={retainedDrawings:[{meta:{id:'other'},state:{}}]};ws.projects.push({id:'foreign',drawings:[{id:'other'}]});f.memory.set(WS,JSON.stringify(ws));await assert.rejects(()=>Capacity.createProof(f.options),{code:'DELTA_CAPACITY_IDENTITY'});
 });
 await test('file-state validation rejects incomplete or duplicate durable proofs',async()=>{
  const f=fixture();f.records.readFileStates=async()=>[];await assert.rejects(()=>Capacity.createProof(f.options),{code:'DELTA_CAPACITY_FILES'});
 });
 await test('actual capacity builder awaits proofs, repeats hash checks and passes transactional record/file guards',async()=>{
  const root=path.resolve(__dirname,'..'),base=fs.readFileSync(path.join(root,'sentlog/archive-capacity.js'),'utf8');let built;
  if(base.includes('SentlogDeltaCapacity.createProof'))built=base;
  else {
   const program="from pathlib import Path\nroot=Path.cwd()\ntext=(root/'sentlog/archive-capacity.js').read_text()\ntext=text.replace('expectedWorkspace:before.raw});',\"expectedWorkspace:before.raw,origin:'device'});\").replace('expectedWorkspace:wsText});',\"expectedWorkspace:wsText,origin:'device'});\")\ndef change(path,old,new,count=1):\n global text\n assert text.count(old)==count,old\n text=text.replace(old,new)\nbuilder=(root/'scripts/build_delta_sync.py').read_text()\nexec(builder[builder.index(\"capacity = 'sentlog/archive-capacity.js'\"):builder.index('\\nmodules = ')])\nprint(text)";
   built=execFileSync('python',['-c',program],{cwd:root,encoding:'utf8'});
  }
  new vm.Script(built);assert(built.includes('expectedRecords:before.expectedRecords'));assert(built.includes('expectedFileStates:before.expectedFileStates'));assert(built.includes('validate:before.validateSync'));assert(built.includes('await before.validate()'));assert(built.includes('const restoredFiles=await countLocal(info.files)'));assert(built.includes('expectedRecords:restoreProof.expectedRecords'));assert(built.includes('expectedFileStates:restoreProof.expectedFileStates'));
 });
 console.log('PASS delta capacity: '+count+' checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

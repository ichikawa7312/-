'use strict';
// The production-built renderer and actual IndexedDB writer must agree about
// committed text. A semantic no-op may retain legacy JSON bytes while the
// incoming payload uses another object-key order. Never weaken the UI fence
// against an edit that lands after the projection transaction has completed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(process.env.SENTLOG_BUILT_ROOT||path.join(__dirname,'..'));
const view=fs.readFileSync(path.join(root,'sentlog/sync-view.js'),'utf8');
assert(view.includes('mergeOptions.deltaProjection')&&view.includes('projectionNavigationBarrier'),
  'Run this integration regression against the complete production build');
const fixturePath=path.join(root,'tests/record_projection_noop.test.cjs');
const fixtureSource=fs.readFileSync(fixturePath,'utf8').split('let passed=0;')[0];
const {fixture:writerFixture,observe,scope,localProjectId,metadata,WS,DRAW,PREFIX,LOG,reverseKeys}=
  new Function('require','__dirname',fixtureSource+
    '\nreturn {fixture,observe,scope,localProjectId,metadata,WS,DRAW,PREFIX,LOG,reverseKeys};')
    (createRequire(fixturePath),path.dirname(fixturePath));
const copy=structuredClone,json=JSON.stringify;
async function fixture({third=false,afterProjection}={}){
  const f=await writerFixture(),initial=f.input();
  // Establish the same persisted view fields that the real renderer preserves.
  // This setup uses the actual remote-projection transaction, not direct DB writes.
  for(const entry of initial.writes)if(entry[0].startsWith(DRAW)){
    const state=JSON.parse(entry[1]);Object.assign(state,{currentPage:1,pageCount:1,width:1200,height:800,pdfPageInfo:{},sourceType:'pdf',fileName:entry[0]+'.pdf'});
    entry[1]=json(state);
  }
  if(third){const workspace=JSON.parse(initial.writes[0][1]);workspace.projects.find(p=>p.id===localProjectId).drawings.push({id:'drawing-3',name:'Three'});
    initial.writes[0][1]=json(workspace);const state=JSON.parse(initial.writes[1][1]);state.shapes=[];state.fileName=DRAW+'drawing-3.pdf';
    initial.writes.push([DRAW+'drawing-3',json(state)]);initial.expectedRecords.push([DRAW+'drawing-3',null]);}
  assert.equal((await f.records.deltaJournal.applyProjection(initial)).applied,true);
  const workspace=JSON.parse(f.records.getItem(WS)),own=workspace.projects.find(p=>p.id===localProjectId),calls=[];
  let lists=0,renders=0;
  const el={textContent:'',scrollTop:0,classList:{contains:()=>false,toggle:()=>{}}};
  const context={window:null,console,JSON,Map,Set,Date,Number,Promise,
    document:{hidden:false,activeElement:null,querySelector:()=>null},SentlogRecords:f.records,
    WORKSPACE_KEY:WS,drawingStorageKey:id=>DRAW+id,workspace:copy(workspace),currentView:'projects',activeProjectId:null,activeDrawingId:null,
    state:JSON.parse(f.records.getItem(DRAW+'drawing-1')),selected:null,drawing:null,panStart:null,labelDrag:null,activeTouches:new Map(),
    loading:{style:{display:'none'}},empty:{style:{display:'none'}},addPhotosToSelected:async()=>{},persist(){},saveWorkspace(){},
    freshDrawingState:()=>({shapes:[]}),getProject:()=>own,getDrawingMeta:()=>own.drawings[0],clearAllHistory(){},clearSelection(){},selectShape(){},
    updatePageUI(){},render(){renders++;},renderSelectedPhotos(){},renderProjects(){lists++;},renderDrawings(){lists++;},$:()=>el,
    openDrawing(){},createDrawingFromFile(){},showProjects(){context.currentView='projects';},showDrawings(){context.currentView='drawings';}};
  context.window=context;vm.runInNewContext(view,context);
  const native=f.records.deltaJournal.applyProjection.bind(f.records.deltaJournal);
  f.records.deltaJournal.applyProjection=async options=>{
    const result=await native(options);calls.push({writes:copy([...options.writes]),result:copy(result)});
    if(afterProjection)await afterProjection(f,result);return result;
  };
  function payload(){const project=JSON.parse(f.records.getItem(WS)).projects.find(p=>p.id===localProjectId);
    return {project:copy(project),drawings:project.drawings.map(meta=>({meta:copy(meta),state:JSON.parse(f.records.getItem(DRAW+meta.id))}))};}
  function commit(value=reverseKeys(payload())){
    const local=JSON.parse(f.records.getItem(WS)).projects.find(p=>p.id===localProjectId);
    const keys=new Set([WS,...local.drawings.map(d=>DRAW+d.id),...value.project.drawings.map(d=>DRAW+d.id)]);
    const expectedRecords=[...keys].map(key=>[key,f.records.getItem(key)]);
    return context.sentlogSyncView.commit({id:scope.projectId,client_key:localProjectId},{payload:value},json(local),
      {expectedRecords,extraWrites:[],deltaProjection:{scope,localProjectId,expectedRecords,metadataRecords:copy(metadata),validate:()=>true}});
  }
  return {...f,context,calls,payload,commit,get lists(){return lists;},get renders(){return renders;}};
}
function changedPayload(f){const payload=reverseKeys(f.payload());
  payload.project.drawings=payload.project.drawings.filter(d=>d.id!=='drawing-2');
  payload.drawings=payload.drawings.filter(d=>d.meta.id!=='drawing-2');
  payload.drawings.find(d=>d.meta.id==='drawing-1').state.pageSettings[1].scale=250;
  return payload;
}
const tests=[],test=(name,run)=>tests.push([name,run]);
test('actual renderer accepts semantic no-ops while retaining every durable raw byte and performing no writes',async()=>{
  const f=await fixture(),before=await f.snapshot(),prior=await f.disk();
  const observed=await observe(async()=>{for(let n=0;n<3;n++){
    const result=await f.commit();assert.equal(result.applied,true,'Equivalent JSON must not keep the normal photo worker deferred');
  }});
  assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);assert.equal(f.lists,3);
  for(const call of f.calls){assert.equal(call.result.unchanged,true);assert.equal(call.result.deferredUI,false);
    assert(call.writes.some(([key,value])=>value!==prior.get(PREFIX+key)),'Exercise the old strict incoming-text mismatch');
    assert.equal(call.result.committedRecords.length,call.writes.length);
    for(const [key,value]of call.result.committedRecords)assert.equal(value,prior.get(PREFIX+key));}
});
for(const settled of [false,true])test('local input after the projection commit still defers the renderer ('+(settled?'already durable':'pending')+')',async()=>{
  let called=false;
  const f=await fixture({afterProjection:async(f,result)=>{
    assert.equal(result.applied,true);assert.equal(result.deferredUI,false);called=true;
    const state=JSON.parse(f.records.getItem(DRAW+'drawing-1'));state.shapes[0].memo='Synthetic input after projection commit';
    f.records.setItem(DRAW+'drawing-1',json(state));if(settled)await f.records.settled();
  }}),beforeWorkspace=f.context.workspace;
  const result=await f.commit();assert.equal(called,true);assert.equal(result.applied,false);assert.equal(result.deferred,true);assert.equal(result.reason,'local-edit');
  assert.equal(f.context.workspace,beforeWorkspace);assert.equal(f.lists,0,'Do not install a stale renderer state');
  await f.records.settled();assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'Synthetic input after projection commit');
  const committed=new Map(f.calls[0].result.committedRecords);assert.notEqual(f.records.getItem(DRAW+'drawing-1'),committed.get(DRAW+'drawing-1'));
  assert.equal(f.records.failed,false);
});
test('a changed and deleted drawing can commit beside unchanged legacy JSON without a false UI deferral',async()=>{
  const f=await fixture({third:true}),prior=await f.disk(),unchanged=prior.get(PREFIX+DRAW+'drawing-3');
  const observed=await observe(()=>f.commit(changedPayload(f)));assert.equal(observed.result.applied,true);
  assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).pageSettings[1].scale,250);assert.equal(f.records.getItem(DRAW+'drawing-2'),null);
  assert.equal(f.records.getItem(DRAW+'drawing-3'),unchanged);assert.equal(f.records.getItem(DRAW+'other-drawing'),prior.get(PREFIX+DRAW+'other-drawing'));
  const committed=new Map(f.calls[0].result.committedRecords);
  assert.deepEqual([...committed.keys()].sort(),[WS,DRAW+'drawing-1',DRAW+'drawing-2',DRAW+'drawing-3'].sort());
  assert.equal(committed.get(DRAW+'drawing-2'),null);assert.equal(committed.get(DRAW+'drawing-3'),unchanged);
  for(const [key,value]of committed)assert.equal(f.records.getItem(key),value);
  assert(!observed.writes.some(write=>write.key===PREFIX+DRAW+'drawing-3'),'Unchanged drawing must not be rewritten to make the UI succeed');
  assert.equal(await (await f.disk()).get('photo:drawing-1:photo-1').text(),'Synthetic original file bytes');assert.equal((await f.disk(LOG)).size,0);
  assert.equal(f.lists,1);
});
test('an already-saved edit to the unchanged drawing after a mixed projection remains protected',async()=>{
  const f=await fixture({third:true,afterProjection:async(f,result)=>{
    assert.equal(result.applied,true);const state=JSON.parse(f.records.getItem(DRAW+'drawing-3'));state.pageSettings[1].scale=777;
    f.records.setItem(DRAW+'drawing-3',json(state));await f.records.settled();
  }}),beforeWorkspace=f.context.workspace;
  const result=await f.commit(changedPayload(f));assert.equal(result.applied,false);assert.equal(result.reason,'local-edit');
  assert.equal(f.records.pending,false,'Strict committed-text fence must work even after the later edit has saved');
  assert.equal(f.context.workspace,beforeWorkspace);assert.equal(f.lists,0);
  assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).pageSettings[1].scale,250);assert.equal(f.records.getItem(DRAW+'drawing-2'),null);
  assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-3')).pageSettings[1].scale,777);assert.equal(f.records.failed,false);
});
(async()=>{let passed=0,failed=0;for(const [name,run]of tests)try{await run();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}
  console.log(JSON.stringify({passed,failed,total:tests.length,actualWriter:true,actualBuiltRenderer:true,nativeBrowserExecuted:false}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

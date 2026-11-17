const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../sentlog/sync-view.js'),'utf8');

function fixture(){
  const WS='surveyFieldNoteWorkspaceV1',DRAW=id=>'surveyFieldNoteDrawingV1:'+id;
  const activeMeta={id:'d1',name:'作業図面',fileName:'plan.pdf',sourceType:'pdf',pageCount:1,updatedAt:1};
  const otherMeta={id:'d2',name:'別のシート',fileName:'side.pdf',sourceType:'pdf',pageCount:1,updatedAt:1};
  const shape={id:'s1',type:'腐食',no:'',member:'',memo:'',strokeWidth:1.2,photos:[]};
  const localActive={sourceType:'pdf',fileName:'plan.pdf',pageCount:1,currentPage:1,width:1200,height:800,shapes:[shape]};
  const localOther={sourceType:'pdf',fileName:'side.pdf',pageCount:1,currentPage:1,width:1200,height:800,shapes:[]};
  const project={id:'p',name:'現地調査',updatedAt:1,drawings:[activeMeta,otherMeta]};
  const copy=x=>JSON.parse(JSON.stringify(x));
  const store=new Map([[WS,JSON.stringify({projects:[project]})],[DRAW('d1'),JSON.stringify(localActive)],[DRAW('d2'),JSON.stringify(localOther)]]);
  let commits=0,renders=0;
  const records={
    getItem:key=>store.get(key)??null,
    setItem:(key,value)=>store.set(key,value),
    batch:map=>{for(const [k,v] of map)store.set(k,v)},
    async archiveAtomic({writes,deleteFiles,expectedWorkspace,expectedRecords}){
      assert.deepEqual(deleteFiles,[]);
      assert.equal(store.get(WS),expectedWorkspace,'workspace revision is protected');
      for(const [k,v] of expectedRecords)assert.equal(store.get(k)??null,v,'saved record revision is protected');
      for(const [k,v] of writes)store.set(k,v);
      commits++;
    },
    async flush(){}
  };
  const formValues={damageType:'腐食',damageNo:'',member:'',memo:'',lineWidth:'1.2'};
  const inspector={classList:{contains:()=>false,toggle:()=>{}}};
  const elements={inspector,headerTitle:{textContent:''},projectNameView:{textContent:''},drawingNameView:{textContent:''}};
  for(const [id,value] of Object.entries(formValues))elements[id]={value};
  const context={
    console,JSON,Map,Set,Date,Number,
    document:{hidden:false,activeElement:{id:'damageNo',matches:()=>true,isContentEditable:false},querySelector:()=>null},
    SentlogRecords:records,
    drawingStorageKey:DRAW,
    WORKSPACE_KEY:WS,
    activeProjectId:'p',activeDrawingId:'d1',currentView:'editor',
    state:copy(localActive),workspace:{projects:[copy(project)]},
    selected:'s1',drawing:null,panStart:null,labelDrag:null,activeTouches:new Map(),
    loading:{style:{display:'none'}},
    empty:{style:{display:'none'}},
    addPhotosToSelected:async()=>{},
    persist:()=>{},
    getProject:()=>context.workspace.projects.find(p=>p.id===context.activeProjectId),
    getDrawingMeta:()=>context.workspace.projects.find(p=>p.id===context.activeProjectId)?.drawings.find(d=>d.id===context.activeDrawingId),
    saveWorkspace:()=>{store.set(WS,JSON.stringify(context.workspace))},
    freshDrawingState:()=>({shapes:[]}),
    clearAllHistory:()=>{},
    clearSelection:()=>{context.selected=null},
    selectShape:id=>{context.selected=id},
    updatePageUI:()=>{},
    render:()=>{renders++},
    renderSelectedPhotos:()=>{},
    $:id=>elements[id]||null
  };
  context.window=context;
  context.SentlogShapeMove={isEditing:()=>false};
  context.SentlogPolygonDimensions={isEditing:()=>false};
  vm.runInNewContext(code,context);
  const incoming=(active=copy(localActive),other=copy(localOther))=>({
    payload:{project:copy(project),drawings:[{meta:copy(activeMeta),state:active},{meta:copy(otherMeta),state:other}]}
  });
  async function commit(pack){
    const expectedLocal=JSON.stringify(JSON.parse(store.get(WS)).projects[0]);
    const expectedRecords=[[WS,store.get(WS)],[DRAW('d1'),store.get(DRAW('d1'))],[DRAW('d2'),store.get(DRAW('d2'))]];
    return await context.window.sentlogSyncView.mergeCommit({client_key:'p'},pack,expectedLocal,{expectedRecords,extraWrites:[]});
  }
  return {copy,context,store,records,localActive,localOther,shape,incoming,commit,DRAW,
    setValue:(id,v)=>{elements[id].value=v},
    get commits(){return commits},
    get renders(){return renders}};
}

(async()=>{
  {
    const f=fixture(),other=f.copy(f.localOther);
    other.shapes.push({id:'remote2',photos:[]});
    const result=await f.commit(f.incoming(undefined,other));
    assert.equal(result.applied,true,'a settled editor can receive a safely merged different sheet');
    assert.equal(f.commits,1);
    assert.equal(JSON.parse(f.store.get(f.DRAW('d2'))).shapes.length,1);
    assert.equal(f.context.state.shapes.length,1,'editor state remains untouched');
    assert.equal(f.context.selected,'s1');
  }
  {
    const f=fixture();
    f.setValue('damageNo','まだ反映していない入力');
    const result=await f.commit(f.incoming());
    assert.equal(result.applied,false,'an unsaved inspector field blocks merge');
    assert.equal(f.commits,0);
    assert.equal(f.context.state.shapes[0].no,'');
  }
  {
    const f=fixture(),active=f.copy(f.localActive);
    active.shapes[0].memo='他端末の変更';
    const result=await f.commit(f.incoming(active));
    assert.equal(result.applied,false,'do not overwrite the selected record while inspecting it');
    assert.equal(f.commits,0);
    assert.equal(f.context.state.shapes[0].memo,'');
  }
  {
    const f=fixture(),active=f.copy(f.localActive);
    active.shapes.push({id:'remote-independent',type:'腐食',photos:[]});
    const result=await f.commit(f.incoming(active));
    assert.equal(result.applied,true,'a different shape may merge when the editor is idle');
    assert.equal(f.context.state.shapes.length,2);
    assert.equal(f.context.state.shapes[0].id,'s1');
    assert.equal(f.context.selected,'s1','inspector selection is retained');
    assert.equal(f.renders,1);
  }
  {
    const f=fixture();
    f.context.document.activeElement={id:'customDraft',matches:()=>true,isContentEditable:false};
    const result=await f.commit(f.incoming());
    assert.equal(result.applied,false,'unknown or unsaved input control remains protected');
  }
  assert(!code.includes("if(mergeOptions && currentView==='editor')return {applied:false,reason:'close-drawing'};"),
    'the unconditional editor merge rejection must be removed');
  console.log('PASS editor live sync: idle input, guarded background merge, selected-record safety, unsaved text and unknown-input protection');
})().catch(error=>{console.error(error);process.exitCode=1});

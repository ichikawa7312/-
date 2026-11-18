const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../sentlog/sync-view.js'),'utf8');

function fixture({record={},savePhotos=async()=>{}}={}){
  const WS='surveyFieldNoteWorkspaceV1',DRAW=id=>'surveyFieldNoteDrawingV1:'+id;
  const activeMeta={id:'d1',name:'作業図面',fileName:'plan.pdf',sourceType:'pdf',pageCount:1,updatedAt:1};
  const otherMeta={id:'d2',name:'別のシート',fileName:'side.pdf',sourceType:'pdf',pageCount:1,updatedAt:1};
  const shape={id:'s1',type:'腐食',no:'',member:'',memo:'',strokeWidth:1.2,photos:[],...record};
  const localActive={sourceType:'pdf',fileName:'plan.pdf',pageCount:1,currentPage:1,width:1200,height:800,shapes:[shape]};
  const localOther={sourceType:'pdf',fileName:'side.pdf',pageCount:1,currentPage:1,width:1200,height:800,shapes:[]};
  const project={id:'p',name:'現地調査',updatedAt:1,drawings:[activeMeta,otherMeta]};
  const copy=x=>JSON.parse(JSON.stringify(x));
  const store=new Map([[WS,JSON.stringify({projects:[project]})],[DRAW('d1'),JSON.stringify(localActive)],[DRAW('d2'),JSON.stringify(localOther)]]);
  let commits=0,renders=0;
  const records={
    getItem:key=>store.get(key)??null,
    setItem:(key,value)=>store.set(key,value),
    batch:(map,options)=>{assert.equal(options?.origin,'remote','incoming metadata uses remote origin');for(const [k,v] of map)store.set(k,v);commits++;},
    async archiveAtomic({writes,deleteFiles,expectedWorkspace,expectedRecords}){
      assert.equal(deleteFiles.length,0,'merge never deletes photos or PDF files');
      assert.equal(store.get(WS),expectedWorkspace,'workspace revision is protected');
      for(const [k,v] of expectedRecords)assert.equal(store.get(k)??null,v,'saved record revision is protected');
      for(const [k,v] of writes)store.set(k,v);
      commits++;
    },
    async flush(){}
  };
  // Ordinary inspector fields deliberately keep their previous damage-record
  // values when a field record is selected; those hidden controls are not drafts.
  const formValues={damageType:'腐食',damageNo:'',member:'',memo:'',lineWidth:'1.2',frRecordMemo:shape.memo};
  const inspector={classList:{contains:()=>false,toggle:()=>{}}};
  const elements={inspector,headerTitle:{textContent:''},projectNameView:{textContent:''},drawingNameView:{textContent:''}};
  for(const [id,value] of Object.entries(formValues))elements[id]={id,value,readOnly:false};
  const context={
    console,JSON,Map,Set,Date,Number,
    document:{hidden:false,activeElement:{id:shape.recordKind==='field-record'?'frRecordMemo':'memo',matches:()=>true,isContentEditable:false},querySelector:()=>null},
    SentlogRecords:records,
    drawingStorageKey:DRAW,
    WORKSPACE_KEY:WS,
    activeProjectId:'p',activeDrawingId:'d1',currentView:'editor',
    state:copy(localActive),workspace:{projects:[copy(project)]},
    selected:'s1',drawing:null,panStart:null,labelDrag:null,activeTouches:new Map(),
    loading:{style:{display:'none'}},
    empty:{style:{display:'none'}},
    addPhotosToSelected:savePhotos,
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
  context.SentlogFieldRecords={isMemoEditing:()=>false};
  const instrumented=code.replace('  function localView(incoming,old){',`  window.__syncLiveBusyDebug=()=>({focus:document.activeElement?.id,selected,
    selectedRecord:state.shapes.find(x=>x.id===selected),formMemo:$('memo')?.value,
    busy:busy(),busyBody:busy.toString()});
  function localView(incoming,old){`);
  vm.runInNewContext(instrumented,context);
  const incoming=(active=copy(localActive),other=copy(localOther))=>({
    payload:{project:copy(project),drawings:[{meta:copy(activeMeta),state:active},{meta:copy(otherMeta),state:other}]}
  });
  async function commit(pack,merge=true){
    const expectedLocal=JSON.stringify(JSON.parse(store.get(WS)).projects[0]);
    if(!merge)return await context.window.sentlogSyncView.commit({client_key:'p'},pack,expectedLocal);
    const expectedRecords=[[WS,store.get(WS)],[DRAW('d1'),store.get(DRAW('d1'))],[DRAW('d2'),store.get(DRAW('d2'))]];
    return await context.window.sentlogSyncView.mergeCommit({client_key:'p'},pack,expectedLocal,{expectedRecords,extraWrites:[]});
  }
  return {copy,context,store,records,localActive,localOther,shape,incoming,commit,DRAW,
    receive:pack=>commit(pack,false),
    setValue:(id,v)=>{elements[id].value=v},setReadOnly:(id,value)=>{elements[id].readOnly=value},getValue:id=>elements[id].value,
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
    f.setValue('memo','まだ反映していない入力');
    const result=await f.commit(f.incoming());
    assert.equal(result.applied,false,'an unsaved inspector field blocks merge: '+JSON.stringify(f.context.__syncLiveBusyDebug()));
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
  if(code.includes('These are metadata-only writes.')){
    const f=fixture(),ws='surveyFieldNoteWorkspaceV1';
    const expectedLocal=JSON.stringify(JSON.parse(f.store.get(ws)).projects[0]);
    const expectedRecords=[[ws,f.store.get(ws)],[f.DRAW('d1'),f.store.get(f.DRAW('d1'))],[f.DRAW('d2'),f.store.get(f.DRAW('d2'))]];
    const newer=f.copy(f.localOther);newer.shapes.push({id:'newer-local',photos:[]});
    f.store.set(f.DRAW('d2'),JSON.stringify(newer));
    const result=await f.context.sentlogSyncView.mergeCommit({client_key:'p'},f.incoming(),expectedLocal,{expectedRecords,extraWrites:[['checkpoint','stale']]});
    assert.equal(result.applied,false,'metadata commit rechecks every record immediately before its synchronous batch');
    assert.equal(result.reason,'local-edit');
    assert.equal(f.commits,0,'neither records nor checkpoint is partially committed');
    assert.equal(f.store.has('checkpoint'),false);
    assert.equal(JSON.parse(f.store.get(f.DRAW('d2'))).shapes[0].id,'newer-local');
  }
  if(code.includes('isCapturedFieldDraft')){
    const enable=(f,pending={})=>{
      f.context.SentlogCollaboration={onRemote(){},isDraftElement:()=>false,
        isCapturedFieldDraft:(field,record)=>record.id==='s1'&&Object.hasOwn(pending,field.id)&&pending[field.id]===field.value,
        captureEditor:()=>Object.fromEntries(['member','damageType'].map(id=>[id,f.getValue(id)])),
        restoreEditor:values=>{for(const [id,value] of Object.entries(values||{}))f.setValue(id,value);}};
    };
    {
      const f=fixture({record:{memo:'保存済みの変状コメント'}});enable(f);f.setReadOnly('memo',true);
      const active=f.copy(f.localActive);active.shapes[0].memo+='\n\n他端末の追記';
      assert.equal(f.context.__syncLiveBusyDebug().busy,false,'stale readonly damage memo is a mirror after collaboration editor installs');
      assert.equal((await f.commit(f.incoming(active))).applied,true,'normal damage comments receive in place while hidden legacy memo remains stale');
      assert.match(f.context.state.shapes[0].memo,/他端末の追記/);assert.equal(f.getValue('memo'),'');assert.equal(f.context.__syncLiveBusyDebug().busy,false);
    }
    {
      const f=fixture();enable(f);f.setValue('memo','実際に編集中の旧メモ');
      assert.equal((await f.commit(f.incoming())).applied,false,'an editable legacy memo is still protected even with collaboration installed');
    }
    for(const id of ['member','damageType']){
      const value=id==='member'?'主桁':'ひび割れ',f=fixture(),pending={[id]:value};enable(f,pending);f.setReadOnly('memo',true);f.setValue(id,value);
      const active=f.copy(f.localActive);active.shapes[0].memo='確認ダイアログを開いている間の受信';
      assert.equal((await f.commit(f.incoming(active))).applied,true,'a durably captured '+id+' decision permits incoming comments');
      assert.equal(f.getValue(id),value,'captured decision proposal survives the state update');
      assert.equal(f.context.state.shapes[0][id==='member'?'member':'type'],id==='member'?'':'腐食','unconfirmed scalar value is not applied by receipt');
      f.setValue(id,value+'・未保存の追加');
      assert.equal((await f.commit(f.incoming(active))).applied,false,'new uncaptured '+id+' input remains protected');
    }
    {
      const f=fixture();enable(f);f.setValue('member','未確定の部材');
      assert.equal((await f.commit(f.incoming())).applied,false,'a proposal without a durable captured decision still blocks receipt');
    }
    console.log('PASS collaboration inspector guards: stale readonly memo, captured member/type decisions, preserved proposals and protected uncaptured input');
  }
  const survey={kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',memo:'iPadで入力済みのコメント',surveyItems:[]};
  const photo={id:'iphone-photo',name:'近接.jpg',createdAt:1794978000000};
  {
    const f=fixture({record:survey}),active=f.copy(f.localActive);
    active.shapes[0].photos.push(photo);
    const result=await f.receive(f.incoming(active));
    assert.equal(result.applied,true,'a saved field memo can receive photos while its textarea stays focused');
    assert.equal(f.context.document.activeElement.id,'frRecordMemo');
    assert.equal(f.context.selected,'s1','receiving the photo retains the selected survey point');
    assert.equal(f.context.state.shapes[0].memo,survey.memo,'a stale hidden damage memo must not replace the field memo');
    assert.deepEqual(f.context.state.shapes[0].photos,[photo]);
    const saved=JSON.parse(f.store.get(f.DRAW('d1'))).shapes[0];
    assert.equal(saved.memo,survey.memo);
    assert.deepEqual(saved.photos,[photo]);
  }
  {
    const f=fixture({record:survey}),other=f.copy(f.localOther);
    other.shapes.push({id:'remote-field-update',photos:[]});
    const result=await f.commit(f.incoming(undefined,other));
    assert.equal(result.applied,true,'settled field memo and stale hidden standard controls do not block an independent merge');
    assert.equal(f.commits,1);
    assert.equal(f.context.state.shapes[0].memo,survey.memo);
  }
  for(const focused of [true,false]){
    const f=fixture({record:survey}),active=f.copy(f.localActive);
    f.setValue('frRecordMemo','まだ保存されていない追記');
    if(!focused)f.context.document.activeElement={matches:()=>false};
    active.shapes[0].photos.push(photo);
    const before=f.store.get(f.DRAW('d1'));
    const result=await f.receive(f.incoming(active));
    assert.equal(result.applied,false,'uncommitted field memo remains protected even after focus moves');
    assert.equal(result.reason,'editing');
    assert.equal(f.store.get(f.DRAW('d1')),before,'pending text prevents any snapshot replacement');
    assert.equal(f.context.state.shapes[0].memo,survey.memo);
    assert.equal(f.context.state.shapes[0].photos.length,0);
  }
  {
    const f=fixture({record:survey}),active=f.copy(f.localActive);
    active.shapes[0].photos.push(photo);
    f.context.SentlogFieldRecords.isMemoEditing=()=>true;
    const result=await f.receive(f.incoming(active));
    assert.equal(result.applied,false,'IME composition blocks receive even when the visible value still equals saved text');
    assert.equal(result.reason,'editing');
    assert.equal(f.context.state.shapes[0].photos.length,0);
    f.context.SentlogFieldRecords.isMemoEditing=()=>false;
    assert.equal((await f.receive(f.incoming(active))).applied,true,'receive resumes after composition commits');
    assert.equal(f.context.state.shapes[0].memo,survey.memo);
  }
  {
    let finishPhoto;
    const photoReady=new Promise(resolve=>{finishPhoto=resolve;});
    const f=fixture({record:survey,savePhotos:()=>photoReady}),active=f.copy(f.localActive);
    active.shapes[0].photos.push(photo);
    const processing=f.context.addPhotosToSelected([]);
    const result=await f.receive(f.incoming(active));
    assert.equal(result.applied,false,'photo capture processing continues to block snapshot replacement');
    assert.equal(result.reason,'editing');
    assert.equal(f.context.state.shapes[0].photos.length,0);
    finishPhoto();await processing;
    assert.equal((await f.receive(f.incoming(active))).applied,true,'photo processing releases its receive guard after settling');
    assert.equal(f.context.state.shapes[0].memo,survey.memo);
  }
  assert(!code.includes("if(mergeOptions && currentView==='editor')return {applied:false,reason:'close-drawing'};"),
    'the unconditional editor merge rejection must be removed');
  console.log('PASS editor live sync: field memo/photo receive, hidden inspector isolation, IME and draft protection, capture guard, selected-record safety');
})().catch(error=>{console.error(error);process.exitCode=1});

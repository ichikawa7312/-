const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../sentlog/sync-view.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x)),WS='surveyFieldNoteWorkspaceV1',DRAW=id=>'surveyFieldNoteDrawingV1:'+id;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
 const meta=id=>({id,name:id,fileName:id+'.pdf',sourceType:'pdf',pageCount:1});
 const saved=(id,version)=>({sourceType:'pdf',fileName:id+'.pdf',currentPage:1,pageCount:1,width:1200,height:800,shapes:[{id:'same-record-id',memo:id+'-'+version,photos:[]}]});
 const metas=['a','b','c'].map(meta),p={id:'p',name:'test',drawings:metas};
 const ws={projects:[p]},store=new Map([[WS,JSON.stringify(ws)],...metas.map(m=>[DRAW(m.id),JSON.stringify(saved(m.id,'old'))])]);
 const entered=deferred(),completed=deferred();let written=0,opens=[],renders=0,lists=0;
 const records={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),pending:0,flush:async()=>{},
  batch(writes){for(const [k,v]of writes)store.set(k,v);},
  deltaJournal:{async applyProjection(options){
    assert(options.validate());entered.resolve(options);
    const mode=await completed.promise;
    if(mode==='defer')return {applied:false,deferred:true};
    if(mode==='reject')throw Error('synthetic transaction failure');
    for(const [k,v]of options.writes)store.set(k,v);written++;
    return {applied:true,deferredUI:false};
  }}};
 const el={textContent:'',scrollTop:0,classList:{contains:()=>false,toggle:()=>{}}};
 const context={console,JSON,Map,Set,Date,Number,Promise,
  window:null,document:{hidden:false,activeElement:null,querySelector:()=>null},
  SentlogRecords:records,WORKSPACE_KEY:WS,drawingStorageKey:DRAW,
  activeProjectId:'p',activeDrawingId:'a',currentView:'editor',workspace:copy(ws),state:saved('a','old'),
  selected:null,drawing:null,panStart:null,labelDrag:null,activeTouches:new Map(),loading:{style:{display:'none'}},empty:{style:{display:'none'}},
  addPhotosToSelected:async()=>{},persist(){store.set(DRAW(context.activeDrawingId),JSON.stringify(context.state));},
  saveWorkspace(){},freshDrawingState:()=>({shapes:[]}),getProject:()=>p,getDrawingMeta:()=>metas.find(m=>m.id===context.activeDrawingId),
  clearAllHistory(){},clearSelection(){context.selected=null;},selectShape(id){context.selected=id;},updatePageUI(){},render(){renders++;},renderSelectedPhotos(){},renderProjects(){lists++;},renderDrawings(){lists++;},$:()=>el,
  openDrawing(pid,id){opens.push(id);context.activeProjectId=pid;context.activeDrawingId=id;context.currentView='editor';context.state=JSON.parse(store.get(DRAW(id)));return true;},
  createDrawingFromFile(file){opens.push('create:'+file);context.activeDrawingId='new';context.currentView='editor';context.state=saved('new','created');return true;},
  showProjects(){context.currentView='projects';context.activeProjectId=context.activeDrawingId=null;},
  showDrawings(){context.currentView='drawings';context.activeDrawingId=null;}
 };
 context.window=context;vm.runInNewContext(code,context);
 function commit(){return context.sentlogSyncView.commit({client_key:'p'},{payload:{project:copy(p),drawings:metas.map(m=>({meta:m,state:saved(m.id,'remote')}))}},JSON.stringify(p),
  {extraWrites:[],expectedRecords:[...store],deltaProjection:{validate:()=>true}});}
 return {context,store,entered,completed,commit,opens,get written(){return written},get lists(){return lists},get renders(){return renders}};
}
(async()=>{
 {
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  const open=c.openDrawing('p','b');
  // Before the fix this synchronously changed the ID while the pending
  // commit still held the incoming state for drawing a.
  assert.equal(c.activeDrawingId,'a','new drawing must wait for the local projection transaction');
  assert.deepEqual(f.opens,[]);
  f.completed.resolve('commit');assert.equal((await commit).applied,true);
  assert.equal(await open,true);assert.equal(c.activeDrawingId,'b');
  assert.equal(c.state.shapes[0].memo,'b-remote');c.persist();
  assert.equal(JSON.parse(f.store.get(DRAW('a'))).shapes[0].memo,'a-remote');
  assert.equal(JSON.parse(f.store.get(DRAW('b'))).shapes[0].memo,'b-remote','never persist drawing a contents under drawing b');
 }
 {
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  const b=c.openDrawing('p','b'),d=c.openDrawing('p','c');
  f.completed.resolve('commit');await commit;assert.equal(await b,false);assert.equal(await d,true);
  assert.deepEqual(f.opens,['c']);assert.equal(c.state.shapes[0].memo,'c-remote');
 }
 for(const leave of ['showProjects','showDrawings']){
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  const b=c.openDrawing('p','b');c[leave]();const view=c.currentView;
  f.completed.resolve('commit');assert.equal((await commit).applied,true);assert.equal(await b,false);
  assert.equal(c.currentView,view);assert.equal(c.activeDrawingId,null);assert.equal(f.renders,0);assert.equal(f.lists,1);
 }
 for(const mode of ['defer','reject']){
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  const b=c.openDrawing('p','b');f.completed.resolve(mode);
  if(mode==='reject')await assert.rejects(commit,/synthetic transaction failure/);else assert.equal((await commit).applied,false);
  assert.equal(await b,true,'a failed projection must release navigation');assert.equal(c.state.shapes[0].memo,'b-old');
 }
 {
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  const creation=c.createDrawingFromFile('new.pdf');
  assert.deepEqual(f.opens,[]);f.completed.resolve('commit');await commit;assert.equal(await creation,true);
  assert.equal(c.activeDrawingId,'new');assert.equal(c.state.shapes[0].memo,'new-created');
 }
 {
  const f=fixture(),c=f.context,commit=f.commit();await f.entered.promise;
  // A direct assignment bypassing the ordinary navigation entry point must
  // still not install the captured editor data from a different sheet.
  c.activeDrawingId='b';c.state=JSON.parse(f.store.get(DRAW('b')));
  const sentinel=c.state;f.completed.resolve('commit');
  const result=await commit;assert.equal(result.applied,false);assert.equal(result.reason,'view-changed');
  assert.equal(c.state,sentinel);assert.equal(c.state.shapes[0].memo,'b-old');
 }
 console.log('PASS delta projection navigation: delayed open, rapid switch, cancelled navigation, project/drawing list, rejected/deferred transaction, create drawing, unexpected view change; no cross-drawing writes');
})().catch(e=>{console.error(e);process.exitCode=1;});

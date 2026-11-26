const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const camera=require('../sentlog/camera-return.js');
const {KEY,MAX_AGE_MS,checkpoint,targetAvailable,createController,sessionOwner,ownerTransition}=camera;
const copy=value=>JSON.parse(JSON.stringify(value));
const saved={version:1,projectId:'p',drawingId:'d',recordId:'r',ownerId:'owner',page:2,savedAt:100000000,
  inspectorOpen:true,viewport:{scale:1.8,x:20,y:-40,width:1200,height:800,stageWidth:900,stageHeight:600}};
const session=id=>JSON.stringify({user:{id},access_token:'synthetic-unused'});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const records=()=>({workspace:{projects:[{id:'p',drawings:[{id:'d'}]}]},drawing:{pageCount:3,shapes:[{id:'r',page:2,photos:[{id:'existing'}]}]}});
function store(map=new Map()){
  return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
}
function fixture(){
  const storage=store(),data=records(),original=copy(data),events=[];
  let identity={known:true,id:'owner'},page=1,view='projects',target=true,gate=null,redirect=false;
  const c=createController({storage,now:()=>saved.savedAt,owner:()=>identity,
    canBegin:()=>view==='projects',target:s=>target&&targetAvailable(s,data),sameDrawing:()=>view==='editor',page:()=>page,
    async open(s,claim){events.push(['open',s.drawingId]);if(gate)await gate.promise;if(claim.current())view='editor';},
    async showPage(s){events.push(['page',s.page]);page=redirect?1:s.page;},
    select:s=>events.push(['select',s.recordId]),applyView:s=>events.push(['view',s.viewport])});
  const remember=()=>c.remember(saved);
  return {c,storage,data,original,events,remember,setOwner:value=>identity=value,setView:value=>view=value,
    delay:value=>gate=value,removeTarget:()=>target=false,redirect:()=>redirect=true};
}

// Runtime fixture includes early bootstrap, later wrappers, and delayed opening.
function runtime({gate=null,checkpointValue=saved}={}){
  const listeners=new Map(),documentListeners=new Map(),sessionStorage=store(),localStorage=store();
  if(checkpointValue)sessionStorage.setItem(KEY,JSON.stringify(checkpointValue));
  localStorage.setItem('sentlogCloudSessionV1',session('owner'));
  const data=records(),recordStore=new Map([
    ['surveyFieldNoteWorkspaceV1',JSON.stringify(data.workspace)],
    ['surveyFieldNoteDrawingV1:d',JSON.stringify(data.drawing)]
  ]),calls=[];
  const classes=new Set(),element={clientWidth:900,clientHeight:600,classList:{
    contains:key=>classes.has(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}}};
  const root={console,Date:class extends Date{static now(){return saved.savedAt;}},Promise,Set,Map,WeakSet,Number,JSON,Object,
    sessionStorage,localStorage,document:{readyState:'loading',hidden:false,
      getElementById:()=>element,addEventListener(type,fn){documentListeners.set(type,[...(documentListeners.get(type)||[]),fn]);}},
    addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},
    currentView:'projects',activeProjectId:null,activeDrawingId:null,selected:null,state:{...copy(data.drawing),currentPage:1,width:1200,height:800},scale:1,tx:0,ty:0,
    SentlogRecords:{getItem:key=>recordStore.get(key)??null},
    showProjects(){root.currentView='projects';root.activeProjectId=root.activeDrawingId=null;},
    showDrawings(pid){root.currentView='drawings';root.activeProjectId=pid;root.activeDrawingId=null;},
    async openDrawing(pid,did){calls.push(['open',did]);root.currentView='editor';root.activeProjectId=pid;root.activeDrawingId=did;root.selected=null;},
    createDrawingFromFile(){root.currentView='editor';root.activeDrawingId='new';},
    selectShape(id){root.selected=id;calls.push(['select',id]);},clearSelection(){root.selected=null;},
    async renderPdfPage(page){root.state.currentPage=page;calls.push(['page',page]);},
    applyTransform(){calls.push(['transform']);},persist(){throw Error('Existing record must not be written by checkpoint');}
  };
  root.window=root;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sentlog/camera-return.js'),'utf8'),root);
  root.SentlogCameraReturn.installNavigation();
  root.sentlogAppReady=Promise.resolve().then(()=>root.SentlogCameraReturn.initialView(root.showProjects));
  // Model a wrapper installed after the early fence (e.g. sync-view).
  const original=root.openDrawing;
  root.openDrawing=async function(...args){if(gate)await gate.promise;return original.apply(this,args);};
  root.SentlogFieldRecords={selectRecord:id=>{root.selected=id;calls.push(['field',id]);}};
  const emit=(list,type,event={})=>{for(const fn of list.get(type)||[])fn(event);};
  return {root,calls,sessionStorage,localStorage,recordStore,
    async boot(){await root.sentlogAppReady;emit(documentListeners,'DOMContentLoaded');await Promise.resolve();return root.SentlogCameraReturn.ready;},
    event:(type,event)=>emit(listeners,type,event),input:(type,event)=>emit(documentListeners,type,event)};
}

(async()=>{
  assert.deepEqual(checkpoint({...saved,blob:'must not persist',access_token:'must not persist'}),null,'real clock rejects stale synthetic timestamp');
  assert.deepEqual(checkpoint({...saved,blob:'not retained',access_token:'not retained'},saved.savedAt),saved);
  for(const change of [{savedAt:saved.savedAt-MAX_AGE_MS-1},{savedAt:saved.savedAt+60001},{page:0},{page:1.5},{recordId:''},{version:2}])
    assert.equal(checkpoint({...saved,...change},saved.savedAt),null);
  assert.equal(checkpoint({...saved,viewport:{...saved.viewport,scale:Infinity}},saved.savedAt).viewport,undefined);
  assert.deepEqual(sessionOwner(null),{known:true,id:''});assert.deepEqual(sessionOwner('{}'),{known:false});
  assert.equal(ownerTransition(session('owner'),JSON.stringify({user:{id:'owner'},access_token:'new-unused'})),false);
  for(const pair of [[session('owner'),null],[null,session('owner')],[session('a'),session('b')],['{',session('owner')]])
    assert.equal(ownerTransition(...pair),true);

  for(const mutate of [x=>x.workspace.projects=[],x=>x.workspace.projects[0].deletedAt=1,
    x=>x.workspace.projects[0].drawings[0].deletedAt=1,x=>x.drawing.shapes=[],x=>x.drawing.shapes[0].deletedAt=1,
    x=>x.drawing.shapes[0].page=1,x=>x.drawing.pageCount=1,x=>x.drawing.pageStates={'2':{hidden:true}},
    x=>x.archive={status:'archived'},x=>x.archive={status:'active',checking:true},x=>x.archive={status:'active',retired:true},
    x=>x.model={isDeleted:()=>true}]){
    const data=records();mutate(data);assert.equal(targetAvailable(saved,data),null);
  }
  {
    const f=fixture();assert.equal(f.remember(),true);assert.deepEqual(await f.c.restore(),{restored:true});
    assert.deepEqual(f.events.map(x=>x[0]),['open','page','select','view']);assert(f.storage.getItem(KEY));
    assert.deepEqual(f.data,f.original,'return helper must not mutate stored records/photos');
  }
  {
    const f=fixture();f.remember();f.setOwner({known:false});assert.equal((await f.c.restore()).reason,'owner-unavailable');
    assert(f.storage.getItem(KEY),'unknown owner must not be mistaken for anonymous logout');
    f.setOwner({known:true,id:'other'});assert.equal((await f.c.restore()).restored,false);assert.equal(f.storage.getItem(KEY),null);
  }
  {
    const f=fixture();f.remember();const gate=deferred();f.delay(gate);const restore=f.c.restore();
    f.c.cancel();f.setView('drawings');gate.resolve();assert.equal((await restore).restored,false);
    assert(!f.events.some(x=>x[0]==='select'));assert.equal(f.storage.getItem(KEY),null);
  }
  {
    const f=fixture();f.remember();const gate=deferred();f.delay(gate);const restore=f.c.restore();
    f.c.accountChanged('');f.c.accountChanged('owner');gate.resolve();assert.equal((await restore).restored,false);
    assert(!f.events.some(x=>x[0]==='select'),'logout/login ABA must cancel');
  }
  {
    const f=fixture();f.remember();const gate=deferred();f.delay(gate);const restore=f.c.restore();
    f.removeTarget();gate.resolve();assert.equal((await restore).restored,false);assert.equal(f.storage.getItem(KEY),null);
  }
  {
    const f=fixture();f.remember();f.redirect();assert.equal((await f.c.restore()).reason,'page-changed');
    assert(!f.events.some(x=>x[0]==='select'),'must not select a hidden-page record on another page');
  }
  {
    const f=fixture();f.remember();f.storage.setItem=()=>{throw Error('quota');};
    assert.equal(f.c.remember({...saved,recordId:'new'}),false);assert.equal(f.storage.getItem(KEY),null,'failed checkpoint must not retain older destination');
  }
  {
    const a=fixture(),b=fixture();a.remember();assert.equal((await b.c.restore()).reason,'no-checkpoint','session storage isolates tabs');
  }
  {
    const f=runtime();assert.equal((await f.boot()).restored,true);assert.equal(f.root.selected,'r');assert.equal(f.root.state.currentPage,2);
    assert(f.sessionStorage.getItem(KEY),'startup showProjects must preserve checkpoint');
    f.root.selectShape('r');await f.root.renderPdfPage(2);assert(f.sessionStorage.getItem(KEY),'same-record repaint must preserve checkpoint');
    f.event('storage',{key:'sentlogCloudSessionV1',oldValue:session('owner'),newValue:JSON.stringify({user:{id:'owner'},access_token:'refresh-unused'})});
    assert(f.sessionStorage.getItem(KEY),'same-owner token refresh must preserve checkpoint');
    f.root.selectShape('another');assert.equal(f.sessionStorage.getItem(KEY),null,'deliberate selection changes clear old return point');
  }
  {
    const f=runtime();await f.boot();f.event('storage',{key:'sentlogCloudSessionV1',oldValue:session('owner'),newValue:null});
    f.event('storage',{key:'sentlogCloudSessionV1',oldValue:null,newValue:session('owner')});assert.equal(f.sessionStorage.getItem(KEY),null);
  }
  for(const action of [root=>root.showProjects(),root=>root.showDrawings('p'),root=>root.selectShape('other')]){
    const gate=deferred(),f=runtime({gate});const boot=f.boot();await f.root.sentlogAppReady;await Promise.resolve();await Promise.resolve();
    action(f.root);gate.resolve();assert.equal((await boot).restored,false);assert(!f.calls.some(x=>x[0]==='select'&&x[1]==='r'));
    assert(!f.calls.some(x=>x[0]==='open'),'stale restore claim must not execute after an async wrapper');
  }
  {
    const f=runtime({checkpointValue:null});await f.boot();f.root.currentView='editor';f.root.activeProjectId='p';f.root.activeDrawingId='d';f.root.selected='r';f.root.state.currentPage=2;
    f.root.SentlogCameraReturn.beforeCapture();assert.equal(f.root.SentlogCameraReturn.remember(saved),true);
    const before=f.recordStore.get('surveyFieldNoteDrawingV1:d');f.root.SentlogCameraReturn.beforeCapture();
    assert.equal(f.recordStore.get('surveyFieldNoteDrawingV1:d'),before);
    f.root.SentlogCameraReturn.accountChanged('');f.root.SentlogCameraReturn.accountChanged('owner');assert.equal(f.sessionStorage.getItem(KEY),null);
  }
  console.log('PASS camera return: tab scope, bounded minimal checkpoint, existing records unchanged, bootstrap preservation, PDF/record restoration, same-selection sync, token refresh, logout ABA, invalid/deleted/archived targets, quota and async navigation cancellation');
})().catch(error=>{console.error(error);process.exitCode=1;});

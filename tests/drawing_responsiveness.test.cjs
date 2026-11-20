'use strict';
// Exercise production PDF/open/viewport handlers with controlled rendering tasks.
// No browser or real project data is required for these lifecycle assertions.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const parts=fs.readFileSync('sentlog/part09.txt','utf8');
const openFileSource=parts.slice(parts.indexOf('let drawingFileOpenSequence='),parts.indexOf('\nasync function renderPdfPage('));
const viewportSource=parts.slice(parts.indexOf('let cameraViewportPending='),parts.indexOf("if('serviceWorker' in navigator"));

function fixture(){
  const events=new Map(),timers=new Map(),renders=[],surfaces=[],writes=[],files=[];
  let serial=0,refits=0,transforms=0,camera=false;
  const stage={children:[],insertBefore(value){this.children.push(value);}};
  const wrap={dataset:{},getBoundingClientRect:()=>({width:390,height:650})};
  function canvas(){
    const result={width:1,height:1,style:{},setAttribute(){},remove(){stage.children=stage.children.filter(x=>x!==result);}};
    result.getContext=()=>({clearRect(){},drawImage(){},canvas:result});surfaces.push(result);return result;
  }
  const page={rotate:0,getViewport:({scale})=>({width:1200*scale,height:800*scale}),render(options){
    let resolve,reject;const task={options,cancelled:false,promise:new Promise((a,b)=>{resolve=a;reject=b;}),
      cancel(){this.cancelled=true;reject(Object.assign(Error('cancelled'),{name:'RenderingCancelledException'}));},finish:()=>resolve()};
    renders.push(task);if(!context.holdRender)queueMicrotask(resolve);return task;
  }};
  const doc={numPages:2,getPage:async()=>page,destroyCalls:0,destroy(){this.destroyCalls++;return Promise.resolve();}};
  const context={console,File,Blob,ArrayBuffer,Uint8Array,Promise,Math,queueMicrotask,
    state:{sourceType:'pdf',width:1200,height:800,currentPage:1,pageCount:2,pageRotations:{},
      shapes:[{id:'record',memo:'kept',photos:[{id:'photo'}]}]},
    activeDrawingId:'drawing',currentView:'editor',pdfDoc:null,scale:.2,tx:0,ty:0,
    activeTouches:new Map(),panStart:null,labelDrag:null,selected:null,drawing:null,devicePixelRatio:2,
    empty:{style:{}},canvas:canvas(),svg:{setAttribute(){}},
    setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    addEventListener(name,fn){const handlers=events.get(name)||[];handlers.push(fn);events.set(name,handlers);},
    document:{hidden:false,addEventListener(){},createElement:tag=>tag==='canvas'?canvas():{style:{}},
      getElementById:id=>({stage,stageWrap:wrap}[id]||null)},
    normalizeRotation:value=>value,getPageRotation:()=>0,resetTouchGesture(){},
    setLoading(value){context.loading=value;},showError(value){context.error=value;},
    fit(){refits++;context.scale=.2;context.tx=0;context.ty=0;context.applyTransform();},
    applyTransform(){transforms++;},updatePageUI(){},updateScaleStatus(){},updateRotationUI(){},render(){},renderSelectedPhotos(){},
    persist(){writes.push(JSON.stringify(context.state));},setupStage(){},openDrawing(){},showProjects(){context.currentView='projects';},showDrawings(){context.currentView='drawings';},
    renderPdfPage(){},renderImage(){},saveBackgroundFile:async file=>{files.push(file);},$:()=>({textContent:''}),
    SentlogContinuousCamera:{isOpen:()=>camera},pdfjsLib:{getDocument:()=>({promise:Promise.resolve(doc)})}
  };
  context.ctx=context.canvas.getContext('2d');context.window=context;
  vm.createContext(context);vm.runInContext(openFileSource,context);
  vm.runInContext(fs.readFileSync('sentlog/pdf-quality.js','utf8'),context);
  // The real page-visibility wrapper must forward render options even when it
  // redirects an opening view away from a hidden original page.
  const manager=fs.readFileSync('sentlog/page-management.js','utf8');
  context.ensure=()=>{};context.hidden=number=>number===2;context.nearestVisible=()=>1;
  vm.runInContext('{'+manager.slice(manager.indexOf('  const baseRenderPdfPage='),manager.indexOf('\n  async function go('))+'}',context);
  vm.runInContext(viewportSource,context);
  const flush=async()=>{
    const batch=[...timers.values()];timers.clear();for(const callback of batch)callback();
    for(let i=0;i<8;i++)await Promise.resolve();
  };
  const event=(name,detail)=>{for(const fn of events.get(name)||[])fn({detail});};
  const setCamera=value=>{camera=value;event('sentlog-camera-visibility',{open:value});};
  return {context,doc,renders,surfaces,writes,files,stage,wrap,flush,event,setCamera,
    get refits(){return refits;},get transforms(){return transforms;}};
}

(async()=>{
  const fit=fixture(),records=JSON.stringify(fit.context.state.shapes);
  fit.context.state.currentPage=2; // Opening a hidden page redirects through page-management.
  await fit.context.openFile(new File(['synthetic-pdf'],'drawing.pdf',{type:'application/pdf'}),false);
  await fit.flush();
  assert.equal(fit.context.state.currentPage,1);assert.equal(fit.writes.length,1,
    'opening a PDF persists its final state once, including redirected page and dimensions');
  assert.equal(fit.renders.length,1,'a fitted sheet needs no second PDF render when the base already supplies every requested pixel');
  assert.equal(JSON.stringify(fit.context.state.shapes),records);
  assert.equal(fit.context.loading,false);
  await fit.context.renderPdfPage(1);await fit.flush();
  assert.equal(fit.writes.length,2,'ordinary page navigation still persists');
  assert.equal(fit.renders.length,2);
  fit.context.scale=2;fit.context.applyTransform();await fit.flush();
  assert.equal(fit.renders.length,3,'zoom beyond base resolution still renders real PDF detail');
  assert.equal(fit.stage.children.length,1);
  const front=fit.stage.children[0],originalRefits=fit.refits;
  fit.setCamera(true);assert.equal(front.width*front.height,1);assert.equal(fit.stage.children.length,0);
  const renderCount=fit.renders.length,surfaceCount=fit.surfaces.length,transformCount=fit.transforms;
  for(let i=0;i<10;i++){fit.event('resize');fit.event('orientationchange');await fit.flush();}
  assert.equal(fit.renders.length,renderCount);assert.equal(fit.surfaces.length,surfaceCount);
  assert.equal(fit.transforms,transformCount);assert.equal(fit.refits,originalRefits);
  fit.setCamera(false);await fit.flush();
  assert.equal(fit.refits,originalRefits+1,'covered rotations are fitted once after closing');
  assert.equal(fit.renders.length,renderCount,'a fitted close can reuse the base raster');
  fit.context.scale=2;fit.context.applyTransform();await fit.flush();
  const noRotationRefits=fit.refits;fit.setCamera(true);fit.setCamera(false);await fit.flush();
  assert.equal(fit.refits,noRotationRefits);assert.equal(fit.context.scale,2,'plain camera close preserves zoom');
  assert.equal(JSON.stringify(fit.context.state.shapes),records);
  assert.equal(fit.writes.length,2,'background resize/rotation never creates record writes');
  console.log('PASS PDF opening: one final persistence and one sufficient base render; zoom detail remains full resolution');
  console.log('PASS camera-covered rotation: zero drawing renders/allocations, one deferred fit, plain close keeps zoom and records');

  const pending=fixture();pending.context.pdfDoc=pending.doc;await pending.context.renderPdfPage(1);await pending.flush();
  pending.context.holdRender=true;pending.context.scale=2;pending.context.applyTransform();await pending.flush();
  const inFlight=pending.renders.at(-1),buffer=inFlight.options.canvasContext.canvas;
  pending.setCamera(true);await pending.flush();
  assert(inFlight.cancelled,'opening the camera cancels a pending PDF detail render');
  assert.equal(buffer.width*buffer.height,1,'the cancelled back buffer is released');
  assert.equal(pending.stage.children.length,0,'a late render cannot attach behind the camera');
  pending.context.holdRender=false;pending.setCamera(false);await pending.flush();
  assert.equal(pending.stage.children.length,1,'closing retries the latest viewport after cancellation');
  console.log('PASS pending PDF detail cancels and releases memory before capture; close renders the latest viewport');

  assert.equal(fit.doc.destroyCalls,0,'page changes and camera use retain the active document worker');
  fit.context.showProjects();assert.equal(fit.doc.destroyCalls,1);assert.equal(fit.context.pdfDoc,null);
  fit.context.showDrawings();assert.equal(fit.doc.destroyCalls,1,'the same old worker is destroyed once');
  const save=fixture(),file=new File(['saved-original-pdf'],'saved.pdf',{type:'application/pdf'});
  await save.context.openFile(file,true);await save.flush();
  assert.equal(save.files.length,1);assert.equal(save.files[0],file);assert.equal(await save.files[0].text(),'saved-original-pdf');
  assert.equal(save.writes.length,1);
  const failed=fixture();failed.doc.getPage=async()=>{throw Error('synthetic decode failure');};
  const originalRecords=JSON.stringify(failed.context.state.shapes);
  await failed.context.openFile(file,false);
  assert.equal(failed.context.loading,false);assert.match(failed.context.error,/synthetic decode failure/);
  assert.equal(failed.writes.length,0);assert.equal(failed.doc.destroyCalls,1);assert.equal(failed.context.pdfDoc,null);
  assert.equal(JSON.stringify(failed.context.state.shapes),originalRecords);
  console.log('PASS PDF worker lifecycle: page turns retain it, closed/failed documents release once, and original save stays byte-identical');

  const stale=fixture();let releaseOld,releaseDestroy;
  const staleDoc={...stale.doc,destroyCalls:0,destroy(){this.destroyCalls++;return new Promise(resolve=>{releaseDestroy=resolve;});}};
  let first=true;
  stale.context.pdfjsLib.getDocument=()=>({promise:first?(first=false,new Promise(resolve=>{releaseOld=()=>resolve(staleDoc);})):Promise.resolve(stale.doc)});
  const oldOpen=stale.context.openFile(file,false);
  while(!releaseOld)await Promise.resolve();
  stale.context.activeDrawingId='replacement';
  await stale.context.openFile(file,false);await stale.flush();
  const after=JSON.stringify(stale.context.state),writes=stale.writes.length;
  releaseOld();while(!releaseDestroy)await Promise.resolve();
  assert.equal(stale.context.pdfDoc,stale.doc);assert.equal(stale.doc.destroyCalls,0);
  releaseDestroy();await oldOpen;
  assert.equal(staleDoc.destroyCalls,1);assert.equal(stale.context.pdfDoc,stale.doc);
  assert.equal(JSON.stringify(stale.context.state),after);assert.equal(stale.writes.length,writes);
  assert.equal(stale.context.loading,false,'late old work cannot change the current loading state');
  console.log('PASS stale PDF open releases only its own worker and cannot replace, persist, hide or destroy a newer drawing');

  const same=fixture();let resolveSame;
  same.context.pdfjsLib.getDocument=()=>({promise:new Promise(resolve=>{resolveSame=resolve;})});
  const sameOpening=same.context.openFile(file,false);
  while(!resolveSame)await Promise.resolve();
  same.context.showDrawings();same.context.openDrawing('project','drawing');
  same.context.currentView='editor'; // Background bytes for the reopened drawing have not arrived yet.
  resolveSame(same.doc);await sameOpening;
  assert.equal(same.doc.destroyCalls,1);assert.equal(same.context.pdfDoc,null);assert.equal(same.writes.length,0);
  console.log('PASS leave/reopen of the same drawing invalidates an older PDF before the replacement background read completes');

  const paging=fixture();paging.context.holdRender=true;
  const initial=paging.context.openFile(file,false);
  while(!paging.renders.length)await Promise.resolve();
  paging.context.hidden=()=>false;
  const replacement=paging.context.renderPdfPage(2);
  while(paging.renders.length<2)await Promise.resolve();
  await initial;
  assert.equal(paging.doc.destroyCalls,0);assert.equal(paging.context.pdfDoc,paging.doc);
  assert.equal(paging.context.loading,true,'a cancelled opening must not hide a newer page load');
  assert.equal(paging.writes.length,0,'a cancelled opening cannot persist the unfinished newer page');
  paging.renders[1].finish();await replacement;
  assert.equal(paging.context.loading,false);assert.equal(paging.context.state.currentPage,2);
  assert.equal(paging.writes.length,1);assert.equal(paging.doc.destroyCalls,0);
  console.log('PASS a newer page render during file opening keeps its worker, loading indicator and one final durable view');

  const parsing=fixture();let failedTasks=0;
  parsing.context.pdfjsLib.getDocument=()=>({promise:Promise.reject(Error('synthetic parse failure')),
    async destroy(){failedTasks++;}});
  await parsing.context.openFile(file,false);
  assert.equal(failedTasks,1);assert.equal(parsing.context.loading,false);assert.equal(parsing.writes.length,0);
  assert.match(parsing.context.error,/synthetic parse failure/);
  console.log('PASS a rejected PDF parse releases its loading worker and leaves records unsaved and unchanged');

  const source=fs.readFileSync('sentlog/part07.txt','utf8');
  const pendingFiles=[],openedFiles=[],fileErrors=[],recoveries=[];
  const drawer={console:{warn(){}},Promise,JSON,Map,
    activeProjectId:null,activeDrawingId:null,currentView:'projects',state:{},
    getProject:id=>({id,name:id}),getDrawingMeta:(_project,id)=>({id,fileName:id+'.pdf'}),
    freshDrawingState:()=>({shapes:[]}),drawingStorageKey:id=>id,
    SentlogRecords:{getItem:()=>null},selected:null,drawing:null,panStart:null,labelDrag:null,pdfDoc:null,
    clearAllHistory(){},showEditor(){drawer.currentView='editor';},$:()=>({}),
    syncLeaderMarkerUI(){},rebuildNumberingState(){},empty:{style:{}},svg:{innerHTML:''},
    ctx:{clearRect(){}},canvas:{width:1,height:1},updatePageUI(){},render(){},renderSelectedPhotos(){},
    getBackgroundFile:id=>new Promise((resolve,reject)=>pendingFiles.push({id,resolve,reject})),
    openFile:async file=>{openedFiles.push(file.name);drawer.state.fileName=file.name;},
    showError:error=>fileErrors.push(error),
    sentlogRequestDrawingRecovery:id=>recoveries.push(id),sentlogCheckPdfRecovery:()=>recoveries.push('check')};
  drawer.window=drawer;vm.createContext(drawer);
  vm.runInContext(source.slice(source.indexOf('let drawingOpenSequence='),source.indexOf('\nasync function migrateLegacyIfNeeded(')),drawer);
  const backgroundOld=drawer.openDrawing('project','old');
  const backgroundNew=drawer.openDrawing('project','new');
  pendingFiles[1].resolve({name:'new.pdf'});await backgroundNew;
  pendingFiles[0].resolve({name:'old.pdf'});await backgroundOld;
  assert.deepEqual(openedFiles,['new.pdf']);assert.equal(drawer.state.fileName,'new.pdf');
  const sameBackgroundOld=drawer.openDrawing('project','same');
  const sameBackgroundNew=drawer.openDrawing('project','same');
  pendingFiles[3].resolve({name:'same-new.pdf'});await sameBackgroundNew;
  pendingFiles[2].resolve({name:'same-stale.pdf'});await sameBackgroundOld;
  assert.deepEqual(openedFiles,['new.pdf','same-new.pdf']);
  const backgroundFailure=drawer.openDrawing('project','failed');
  const currentBackground=drawer.openDrawing('project','current');
  pendingFiles[5].resolve({name:'current.pdf'});await currentBackground;
  pendingFiles[4].reject(Error('stale file read failed'));await backgroundFailure;
  assert.deepEqual(fileErrors,[]);assert.deepEqual(recoveries,[]);
  const left=drawer.openDrawing('project','closed');
  drawer.currentView='projects';drawer.activeDrawingId=null;drawer.activeProjectId=null;
  pendingFiles[6].resolve({name:'closed.pdf'});await left;
  assert.deepEqual(openedFiles,['new.pdf','same-new.pdf','current.pdf']);
  const missing=drawer.openDrawing('project','missing');pendingFiles[7].resolve(null);await missing;
  assert.equal(fileErrors.length,1);assert.deepEqual(recoveries,['missing'],'the current missing drawing still requests recovery');
  console.log('PASS delayed background reads cannot open an old drawing, replace a newer same-drawing file, show stale errors or recover a closed view');

  // A network-first service worker can temporarily combine a newer renderer
  // with cached core fragments. The previous core has no invalidation hook.
  for(const method of ['showProjects','showDrawings','openDrawing']){
    const mixed=fixture();mixed.context.pdfDoc=mixed.doc;
    await mixed.context.renderPdfPage(1);await mixed.flush();
    mixed.context.invalidateDrawingFileOpen=undefined;
    assert.equal(vm.runInContext('typeof invalidateDrawingFileOpen',mixed.context),'undefined');
    await mixed.context[method]('project','drawing');
    assert.equal(mixed.doc.destroyCalls,1,method+' still releases the old PDF worker');
    assert.equal(mixed.context.pdfDoc,null);assert.equal(mixed.writes.length,1);
  }
  console.log('PASS mixed-version update: newer PDF navigation safely supports a cached core without the optional invalidation hook');
})().catch(error=>{console.error(error);process.exitCode=1;});

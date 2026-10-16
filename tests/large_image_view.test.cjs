'use strict';
// Simulate a constrained canvas without allocating hundreds of MB in the test.
// Exercise the legacy renderer, replacement renderer and actual openFile handler.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const part=fs.readFileSync('sentlog/part09.txt','utf8');
const legacy=part.slice(part.indexOf('async function renderImage('),part.indexOf('\nfunction updatePageUI()'));
const open=part.slice(part.indexOf('async function openFile('),part.indexOf('\nasync function renderPdfPage('));
const setup=fs.readFileSync('sentlog/part07.txt','utf8').match(/function setupStage\(w,h\)\{[^\n]+/)[0];

function fixture({patched=true,naturalWidth=11575,naturalHeight=8031}={}){
  const allocations=[],draws=[],timers=new Map(),revoked=[],created=[],errors=[];
  let counter=0,fits=0,persists=0;
  const context={console:{warn(){},error(){}},File,Blob,Math,Promise,queueMicrotask,
    state:{sourceType:'image',fileName:'02.jpg',width:11575,height:8031,pdfPageInfo:{},
      pageSettings:{'1':{scaleDenom:100,paperSize:'A3'}},shapes:[{id:'shape',x:9980,y:7200,photos:[{id:'photo'}]}]},
    currentView:'editor',activeDrawingId:'drawing',activeBlobUrl:null,
    empty:{style:{display:'grid'}},loading:{style:{display:'none'}},
    scale:.05,tx:0,ty:0,activeTouches:new Map(),panStart:null,labelDrag:null,devicePixelRatio:3,
    setTimeout:fn=>{const id=++counter;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    addEventListener(){},URL:{createObjectURL:file=>{created.push(file);return 'blob:'+created.length;},revokeObjectURL:url=>revoked.push(url)},
    fit(){fits++;context.scale=.05;context.tx=5;context.ty=10;},render(){},persist(){persists++;},
    updateScaleStatus(){},updatePageUI(){},showError:error=>errors.push(error),setLoading:on=>{context.loading.style.display=on?'grid':'none';},
    saveBackgroundFile:async()=>{},applyTransform(){},openDrawing:async()=>{},showProjects(){context.currentView='projects';},showDrawings(){context.currentView='drawings';},
    Image:class{
      naturalWidth=naturalWidth;naturalHeight=naturalHeight;
      set src(url){if(url)queueMicrotask(()=>this.onload());}
    },
  };
  function canvas(){
    const c={style:{},width:300,height:150,setAttribute(){},remove(){stage.children=stage.children.filter(x=>x!==c)}};
    for(const key of ['width','height']){
      let value=c[key];Object.defineProperty(c,key,{get:()=>value,set:n=>{
        value=n;allocations.push({width:c.width,height:c.height,pixels:c.width*c.height});
      }});
    }
    const drawingContext={clearRect(){},fillRect(){},drawImage(...args){
      if(context.failPaint)throw Error('synthetic drawing error');
      if(c.width*c.height<=16777216)draws.push({canvas:c,args});
    }};
    c.getContext=()=>context.denyContext || c.width*c.height>16777216?null:drawingContext;
    c.testContext=drawingContext;return c;
  }
  const stage={children:[],insertBefore(c){this.children.push(c)}},wrap={dataset:{},getBoundingClientRect:()=>({width:390,height:650})};
  const svg={attributes:{},setAttribute(k,v){this.attributes[k]=String(v)}};
  context.canvas=canvas();context.ctx=context.canvas.testContext;context.svg=svg;
  context.$=id=>id==='fileName'?{textContent:''}:null;
  context.document={hidden:false,addEventListener(){},getElementById:id=>({stage,stageWrap:wrap}[id]),createElement:tag=>{assert.equal(tag,'canvas');return canvas();}};
  context.window=context;vm.createContext(context);vm.runInContext(setup+'\n'+legacy+'\n'+open,context);
  if(patched)vm.runInContext(fs.readFileSync('sentlog/image-quality.js','utf8'),context);
  const file=new File(['synthetic-jpeg-bytes'],'02.jpg',{type:'image/jpeg'});
  const flush=()=>{const batch=[...timers.values()];timers.clear();for(const fn of batch)fn();};
  return {context,file,allocations,draws,stage,wrap,errors,revoked,created,flush,get fits(){return fits},get persists(){return persists}};
}

(async()=>{
  const before=fixture({patched:false});await before.context.renderImage(before.file);
  assert(before.allocations.some(x=>x.pixels===11575*8031));
  assert.equal(before.draws.length,0,'legacy renderer cannot paint within the simulated canvas limit');
  console.log('REPRODUCED legacy blank image: 11575x8031 backing canvas exceeds the constrained renderer');

  const f=fixture(),shape=JSON.stringify(f.context.state.shapes),calibration=JSON.stringify(f.context.state.pageSettings);
  await f.context.openFile(f.file,false);f.flush();
  assert.equal(f.errors.at(-1),'');assert.equal(f.context.empty.style.display,'none');
  assert.equal(f.context.loading.style.display,'none');
  assert(f.draws.some(x=>x.canvas===f.context.canvas),'base image must be painted');
  assert(f.context.canvas.width*f.context.canvas.height<=2200000);
  assert(f.allocations.every(x=>x.width<=4096 && x.height<=4096),'no transient oversize backing allocations');
  assert.deepEqual([f.context.state.width,f.context.state.height],[11575,8031]);
  assert.equal(f.context.svg.attributes.viewBox,'0 0 11575 8031');
  assert.equal(f.context.canvas.style.width,'11575px');
  assert.equal(JSON.stringify(f.context.state.shapes),shape);assert.equal(JSON.stringify(f.context.state.pageSettings),calibration);
  assert.equal(await f.file.text(),'synthetic-jpeg-bytes');assert.equal(f.fits,1);

  f.context.scale=.8;f.context.tx=-700;f.context.ty=-300;f.context.applyTransform();f.flush();
  assert.equal(f.stage.children.length,1);const detail=f.stage.children[0];
  assert(detail.width*detail.height<=6000000);
  assert.equal(f.wrap.dataset.imageQuality,'高精細');assert.equal(f.fits,1,'zoom detail must not refit');
  assert.deepEqual([f.context.scale,f.context.tx,f.context.ty],[.8,-700,-300]);
  assert.equal(f.created.length,1,'zoom detail must not reopen the file');
  f.context.tx=-1400;f.context.applyTransform();f.flush();assert.equal(f.stage.children.length,1,'detail canvas is replaced and released');
  assert.equal(JSON.stringify(f.context.state.shapes),shape);
  f.context.showProjects();assert.equal(f.stage.children.length,0,'leaving the editor releases image detail');
  console.log('PASS bounded image display and cropped zoom: original coordinates, calibration, annotations, photos, bytes and zoom retained');

  const reduced=fixture({naturalWidth:5788,naturalHeight:4016});
  await reduced.context.openFile(reduced.file,false);reduced.context.scale=1;reduced.context.tx=-1000;reduced.flush();
  assert.deepEqual([reduced.context.state.width,reduced.context.state.height],[11575,8031],
    'device-side decoding reduction cannot move existing annotations');
  const crop=reduced.draws.findLast(x=>x.canvas!==reduced.context.canvas);
  assert(crop.args[1]<1000,'detail source coordinates scale with decoded resolution');
  console.log('PASS reduced-resolution image decoding keeps the synced drawing coordinate frame');

  for(const failure of ['denyContext','failPaint']){
    const retry=fixture();retry.context[failure]=true;
    await retry.context.openFile(retry.file,false);
    assert.equal(retry.context.loading.style.display,'none','a render failure cannot leave a permanent loading screen');
    assert.equal(retry.context.empty.style.display,'grid');assert(retry.errors.at(-1).includes('読み込みに失敗'));
    assert(retry.revoked.length>0,'a failed image releases its URL');
    retry.context[failure]=false;await retry.context.openFile(retry.file,false);
    assert.equal(retry.context.empty.style.display,'none');
  }
  const stale=fixture(),pending=stale.context.renderImage(stale.file);stale.context.showProjects();await pending;
  assert.equal(stale.draws.length,0,'a late image decode cannot paint a closed drawing');
  console.log('PASS drawing failures clear loading, permit retry and release resources; stale loads cannot paint another view');
})().catch(error=>{console.error(error);process.exitCode=1;});

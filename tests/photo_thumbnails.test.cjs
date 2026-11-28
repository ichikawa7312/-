/* The real renderer with a small layout/decoder harness. No browser or stored-photo writes. */
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const order=require('../sentlog/photo-display-order.js');
const source=fs.readFileSync(require.resolve('../sentlog/photo-thumbnails.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

function fixture({observer=true}={}){
  const reads=[],draws=[],urls=new Map(),urlHistory=new Map(),originals=new Map(),dimensions=new WeakMap();
  const readGates=new Map(),decodeGates=new Map(),encodeGates=new Map(),failDecode=new Set();
  const listeners=new Map(),docListeners=new Map(),observers=[],calls=[],decoders=[];
  let nextUrl=0,activeSources=0,maxSources=0,writes=0;
  const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.parentElement=null;this.children=[];this._className='';this._text='';this.attributes={};this.computed={};this.scrollTop=0;}
    get className(){return this._className;}
    set className(value){this._className=value;}
    get classList(){const self=this;return {add(...names){self._className=[...new Set([...self._className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove(...names){self._className=self._className.split(/\s+/).filter(x=>!names.includes(x)).join(' ');},contains(name){return self._className.split(/\s+/).includes(name);}};}
    set textContent(value){this._text=String(value);}
    get textContent(){return this._text;}
    append(...items){for(const item of items)this.appendChild(item);}
    appendChild(item){if(item.parentElement)item.parentElement.children.splice(item.parentElement.children.indexOf(item),1);item.parentElement=this;this.children.push(item);return item;}
    set innerHTML(value){assert.equal(value,'');for(const child of this.children)child.parentElement=null;this.children=[];}
    get isConnected(){return this===html||!!this.parentElement?.isConnected;}
    removeAttribute(name){delete this.attributes[name];}
    querySelectorAll(selector){const found=[];const walk=node=>{for(const child of node.children){if(selector==='img'&&child.tagName==='IMG')found.push(child);walk(child);}};walk(this);return found;}
    getBoundingClientRect(){
      if(this===inspector)return rect(300,0,300,180);
      if(this===grid)return rect(300,-inspector.scrollTop,300,Math.ceil(this.children.length/3)*90);
      if(this.className==='photo-thumb'){
        const index=this.parentElement.children.indexOf(this);
        return rect(300+(index%3)*100,Math.floor(index/3)*90-inspector.scrollTop,90,75);
      }
      return rect(0,0,600,500);
    }
  }
  class FakeImage extends Element{
    constructor(){super('img');this._src='';this.sourceActive=false;this.complete=false;this.naturalWidth=0;this.naturalHeight=0;decoders.push(this);}
    get src(){return this._src;}
    set src(value){
      this.removeAttribute('src');this._src=String(value);this.attributes.src=this._src;
      if(!value)return;
      const blob=urls.get(value),info=dimensions.get(blob);
      assert(info,'Only fixture originals or generated previews may be decoded');
      this.info=info;this.complete=false;
      if(!info.preview){this.sourceActive=true;activeSources++;maxSources=Math.max(maxSources,activeSources);}
      const complete=()=>{
        if(this._src!==value)return;
        if(failDecode.has(info.key)&&!info.preview){this.onerror?.(new Error('fixture decode error'));return;}
        this.naturalWidth=info.width;this.naturalHeight=info.height;this.complete=true;this.onload?.();
      };
      if(!info.preview&&decodeGates.has(info.key))decodeGates.get(info.key).promise.then(complete);
      else queueMicrotask(complete);
    }
    removeAttribute(name){
      super.removeAttribute(name);
      if(name==='src'){
        this._src='';this.complete=false;
        if(this.sourceActive){this.sourceActive=false;activeSources--;}
      }
    }
  }
  class Canvas extends Element{
    constructor(){super('canvas');this.width=300;this.height=150;}
    getContext(){return {drawImage:(img,x,y,width,height)=>{
      assert(img.sourceActive,'drawImage must receive the single decoded original');
      this.input=img.info;draws.push({key:img.info.key,width,height,activeSources});
    }};}
    toBlob(callback,type){
      const info={...this.input,width:this.width,height:this.height,preview:true};
      const blob=new Blob([`preview:${info.key}:${this.width}x${this.height}`],{type});dimensions.set(blob,info);
      const complete=()=>callback(blob);
      if(encodeGates.has(info.key))encodeGates.get(info.key).promise.then(complete);else queueMicrotask(complete);
    }
  }
  const html=new Element('html'),body=new Element('body'),inspector=new Element('aside'),grid=new Element('div');
  html.append(body);body.append(inspector);inspector.append(grid);grid.id='photoGrid';
  inspector.computed.overflowY='auto';
  const elements={photoGrid:grid};
  for(const id of ['photoCount','photoEmpty','cameraBtn','photoAddBtn']){const item=new Element('div');item.id=id;body.append(item);elements[id]=item;}
  function add(map,name,fn){if(!map.has(name))map.set(name,[]);map.get(name).push(fn);}
  const document={hidden:false,visibilityState:'visible',documentElement:html,body,
    getElementById:id=>elements[id]||null,
    createElement:tag=>tag==='img'?new FakeImage():tag==='canvas'?new Canvas():new Element(tag),
    addEventListener:(name,fn)=>add(docListeners,name,fn)};
  const context={document,Image:FakeImage,Blob,console,Promise,Symbol,WeakMap,setTimeout,clearTimeout,
    innerWidth:600,innerHeight:500,SentlogPhotoDisplayOrder:order,
    addEventListener:(name,fn)=>add(listeners,name,fn),
    requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
    getComputedStyle:node=>({display:'block',visibility:'visible',overflowX:'visible',overflowY:'visible',...node.computed}),
    URL:{createObjectURL:blob=>{const url='blob:fixture/'+(++nextUrl);urls.set(url,blob);urlHistory.set(url,blob);return url;},revokeObjectURL:url=>urls.delete(url)},
    MutationObserver:class{constructor(){throw Error('Thumbnail rendering must not install a MutationObserver');}},
    __calls:calls,__reads:reads,__read:(id,drawingId)=>{
      const key=drawingId+':'+id;reads.push({id,drawingId});
      return readGates.get(key)?.promise||Promise.resolve(originals.get(key)||null);
    },
    putDBFile:()=>{writes++;throw Error('Preview must not write stored files');},
    savePhotoBlob:()=>{writes++;throw Error('Preview must not rewrite photos');},
    persist:()=>{writes++;throw Error('Preview must not persist metadata');}
  };
  if(observer)context.IntersectionObserver=class{
    constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();this.disconnected=false;observers.push(this);}
    observe(item){this.targets.add(item);}
    disconnect(){this.targets.clear();this.disconnected=true;}
    emit(items=[...this.targets]){this.callback(items.map(target=>({target,isIntersecting:true})));}
  };
  context.window=context;context.globalThis=context;vm.createContext(context);
  vm.runInContext(`
    let photoRenderSeq=0,photoThumbUrls=[],currentView='projects',activeDrawingId=null,selected=null,state={shapes:[]};
    function selectedShape(){return state.shapes.find(s=>s.id===selected)||null;}
    async function getPhotoBlob(id,drawingId=activeDrawingId){return __read(id,drawingId);}
    function revokePhotoThumbUrls(){photoThumbUrls.forEach(url=>URL.revokeObjectURL(url));photoThumbUrls=[];}
    async function renderSelectedPhotos(){throw Error('Legacy renderer must be replaced');}
    function removeSelectedPhoto(id){__calls.push(['delete',id]);}
    function openPhotoViewer(id,name){__calls.push(['viewer',id,name]);}
    function showProjects(){currentView='projects';activeDrawingId=null;__calls.push(['projects']);return 'projects-result';}
    function showDrawings(id){currentView='drawings';activeDrawingId=null;__calls.push(['drawings',id]);return 'drawings-result';}
    function openDrawing(project,id){currentView='editor';activeDrawingId=id;selected=null;__calls.push(['open',project,id]);return Promise.resolve('open-result');}
    function createDrawingFromFile(file){currentView='editor';activeDrawingId='new';selected=null;__calls.push(['create',file]);return Promise.resolve('create-result');}
  `,context);
  vm.runInContext(source,context);
  function select(photos,{drawingId='drawing',recordId='record',view='editor'}={}){
    context.__selection={photos,drawingId,recordId,view};
    vm.runInContext(`currentView=__selection.view;activeDrawingId=__selection.drawingId;selected=__selection.recordId;state={shapes:[{id:selected,photos:__selection.photos}]};`,context);
  }
  function addPhotos(count,{drawingId='drawing',prefix='p',width=4032,height=3024}={}){
    const photos=[];
    for(let index=0;index<count;index++){
      const id=prefix+index,key=drawingId+':'+id,blob=new Blob([`unchanged-original:${key}`],{type:'image/jpeg'});
      originals.set(key,blob);dimensions.set(blob,{key,width,height,preview:false});
      photos.push({id,name:id+'.jpg',createdAt:1000+index,type:blob.type,size:blob.size});
    }
    return photos;
  }
  function emit(map,name){for(const fn of map.get(name)||[])fn({type:name});}
  return {context,document,grid,inspector,elements,reads,draws,urls,urlHistory,originals,dimensions,readGates,decodeGates,encodeGates,failDecode,observers,calls,decoders,
    select,addPhotos,run:code=>vm.runInContext(code,context),render:()=>context.renderSelectedPhotos(),api:context.SentlogPhotoThumbnails,
    docEvent:name=>emit(docListeners,name),event:name=>emit(listeners,name),reinstall:()=>vm.runInContext(source,context),
    stats:()=>({activeSources,maxSources,writes,listeners:[...listeners.values(),...docListeners.values()].reduce((n,list)=>n+list.length,0)}),
    async flush(){for(let n=0;n<5;n++)await tick();},
    async hashes(){return Promise.all([...originals].map(async([key,blob])=>[key,crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')]));}
  };
}

test('startup with no selected record reads no photo, and double installation is inert',async()=>{
  const f=fixture();await f.flush();assert.equal(f.reads.length,0);assert.equal(f.api.status().slots,0);
  const renderer=f.context.renderSelectedPhotos,projects=f.context.showProjects,before=f.stats().listeners;
  f.reinstall();assert.equal(f.context.renderSelectedPhotos,renderer);assert.equal(f.context.showProjects,projects);
  assert.equal(f.stats().listeners,before);assert.equal(f.reads.length,0);
  assert.equal(f.run('renderSelectedPhotos===window.renderSelectedPhotos'),true,'window assignment replaces actual global function binding');
});

test('190 records keep every ordered placeholder but read only six visible photos, serially, without changing metadata or bytes',async()=>{
  const f=fixture(),photos=f.addPhotos(190);photos.reverse();freeze(photos);const metadata=JSON.stringify(photos),bytes=await f.hashes();
  f.select(photos);await f.render();
  assert.equal(f.grid.children.length,190);assert.equal(f.elements.photoCount.textContent,'190枚');
  assert.deepEqual(f.grid.children.map(item=>item.title),order.ordered(photos).map(p=>p.name));
  assert.deepEqual(f.reads.map(x=>x.id),['p0','p1','p2','p3','p4','p5']);
  assert(f.reads.every(x=>x.drawingId==='drawing'));
  assert.equal(f.stats().maxSources,1);assert.equal(f.stats().activeSources,0);
  assert.equal(f.api.status().maxDecoding,1);assert.equal(f.api.status().ready,6);assert.equal(f.urls.size,6);
  assert(f.draws.every(d=>d.width===384&&d.height===288&&d.activeSources===1));
  assert.equal(f.grid.children.filter(item=>item.children[0].src).length,6);
  assert.equal(JSON.stringify(photos),metadata);assert.deepEqual(await f.hashes(),bytes);assert.equal(f.stats().writes,0);
  assert.deepEqual(plain(f.observers[0].options),{root:null,rootMargin:'0px',threshold:0});
  f.api.release();assert.equal(f.urls.size,0);
});

test('scrolling releases offscreen previews and reuses the full list for the next and last photos',async()=>{
  const f=fixture();f.select(f.addPhotos(14));await f.render();const firstUrls=[...f.urls.keys()];
  f.inspector.scrollTop=180;f.observers[0].emit();await f.flush();
  assert.deepEqual(f.reads.slice(6).map(x=>x.id),['p6','p7','p8','p9','p10','p11']);
  assert(firstUrls.every(url=>!f.urls.has(url)));assert.equal(f.urls.size,6);
  assert(f.grid.children.slice(0,6).every(item=>!item.children[0].src));
  f.inspector.scrollTop=360;f.observers[0].emit();await f.flush();
  assert.deepEqual(f.reads.slice(12).map(x=>x.id),['p12','p13']);assert.equal(f.urls.size,2);
  f.inspector.scrollTop=0;f.observers[0].emit();await f.flush();
  assert.deepEqual(f.reads.slice(14).map(x=>x.id),['p0','p1','p2','p3','p4','p5']);assert.equal(f.urls.size,6);
  assert.equal(f.grid.children.length,14);assert.equal(f.stats().writes,0);f.api.release();
});

test('await render waits for initial visible decode but does not wait for an offscreen photo',async()=>{
  const f=fixture(),photos=f.addPhotos(9),gate=deferred();f.decodeGates.set('drawing:p0',gate);f.readGates.set('drawing:p8',deferred());
  f.select(photos);let completed=false;const pending=f.render().then(()=>{completed=true;});await f.flush();
  assert.equal(completed,false);assert.equal(f.reads.length,1);assert.equal(f.stats().activeSources,1);
  gate.resolve();await pending;assert.equal(completed,true);assert.equal(f.reads.length,6);assert.equal(f.api.status().ready,6);f.api.release();
});

test('delayed read from the same record ID in a different drawing is cancelled and never enters the new render',async()=>{
  const f=fixture(),a=f.addPhotos(1,{drawingId:'A'}),b=f.addPhotos(1,{drawingId:'B'}),gate=deferred();
  f.readGates.set('A:p0',gate);f.select(a,{drawingId:'A'});const previous=f.render();await f.flush();
  f.select(b,{drawingId:'B'});await f.render();await previous;
  assert.deepEqual(f.reads,[{id:'p0',drawingId:'A'},{id:'p0',drawingId:'B'}]);
  assert.deepEqual(f.draws.map(d=>d.key),['B:p0']);assert.equal(f.urls.size,1);
  gate.resolve(f.originals.get('A:p0'));await f.flush();assert.deepEqual(f.draws.map(d=>d.key),['B:p0']);assert.equal(f.urls.size,1);f.api.release();
});

test('leaving a visible area cancels a pending decode and its await, and the next source never overlaps',async()=>{
  const f=fixture(),photos=f.addPhotos(12),gate=deferred();f.decodeGates.set('drawing:p0',gate);f.select(photos);
  const previous=f.render();await f.flush();assert.equal(f.stats().activeSources,1);
  f.inspector.scrollTop=180;f.observers[0].emit();await previous;await f.flush();
  assert.equal(f.api.status().ready,6);assert.equal(f.stats().maxSources,1);assert.equal(f.stats().activeSources,0);
  assert.deepEqual(f.draws.map(d=>d.key),['drawing:p6','drawing:p7','drawing:p8','drawing:p9','drawing:p10','drawing:p11']);
  gate.resolve();await f.flush();assert.equal(f.urls.size,6);assert.equal(f.grid.children[0].children[0].src,'');f.api.release();
});

test('late small-blob encoding after cancellation cannot resurrect a released preview',async()=>{
  const f=fixture(),photos=f.addPhotos(1),gate=deferred();f.encodeGates.set('drawing:p0',gate);f.select(photos);
  const previous=f.render();await f.flush();assert.equal(f.stats().activeSources,0,'full original is already released before encoding');
  f.api.release();await previous;assert.equal(f.urls.size,0);gate.resolve();await f.flush();assert.equal(f.urls.size,0);assert.equal(f.grid.children[0].children[0].src,'');
});

test('navigation via bare global functions releases images and preserves the wrapped return values',async()=>{
  const f=fixture(),photos=f.addPhotos(7);f.select(photos);await f.render();
  assert.equal(f.run('showProjects()'),'projects-result');assert.equal(f.urls.size,0);assert.equal(f.api.status().active,false);
  assert.equal(f.grid.querySelectorAll('img').some(img=>img.src),false);assert.equal(f.observers[0].disconnected,true);
  f.select(photos);await f.render();assert.equal(f.run("showDrawings('project')"),'drawings-result');assert.equal(f.urls.size,0);
  f.select(photos);await f.render();assert.equal(await f.run("openDrawing('project','other')"),'open-result');assert.equal(f.urls.size,0);
  assert.deepEqual(plain(f.calls),[['projects'],['drawings','project'],['open','project','other']]);
});

test('background/pagehide releases every URL and decoder; returning to the editor restores only visible previews',async()=>{
  const f=fixture(),photos=f.addPhotos(8);f.select(photos);await f.render();
  f.document.hidden=true;f.document.visibilityState='hidden';f.docEvent('visibilitychange');
  assert.equal(f.urls.size,0);assert.equal(f.api.status().active,false);assert.equal(f.stats().activeSources,0);
  const reads=f.reads.length;await f.render();assert.equal(f.reads.length,reads);
  f.document.hidden=false;f.document.visibilityState='visible';f.docEvent('visibilitychange');await f.flush();assert.equal(f.api.status().ready,6);
  f.event('pagehide');assert.equal(f.urls.size,0);f.event('pageshow');await f.flush();assert.equal(f.api.status().ready,6);f.api.release();
});

test('collapsed inspector is not decoded; transition refresh and non-IntersectionObserver scrolling work',async()=>{
  const f=fixture({observer:false}),photos=f.addPhotos(12);f.inspector.computed.visibility='hidden';f.select(photos);await f.render();assert.equal(f.reads.length,0);
  f.inspector.computed.visibility='visible';f.docEvent('transitionend');await new Promise(resolve=>setTimeout(resolve,5));await f.flush();assert.equal(f.api.status().ready,6);
  f.inspector.scrollTop=180;f.docEvent('scroll');await new Promise(resolve=>setTimeout(resolve,5));await f.flush();
  assert.deepEqual(f.reads.slice(6).map(x=>x.id),['p6','p7','p8','p9','p10','p11']);assert.equal(f.urls.size,6);f.api.release();
});

test('viewer/delete controls retain metadata identity and small originals are not enlarged',async()=>{
  const f=fixture(),photos=f.addPhotos(1,{width:160,height:90});freeze(photos);f.select(photos);await f.render();
  const item=f.grid.children[0];item.onclick();let stopped=false;item.children[1].onclick({stopPropagation(){stopped=true;}});
  assert.equal(stopped,true);assert.deepEqual(plain(f.calls),[['viewer','p0','p0.jpg'],['delete','p0']]);
  assert.deepEqual(f.draws,[{key:'drawing:p0',width:160,height:90,activeSources:1}]);assert.equal(f.stats().writes,0);f.api.release();
});

test('failed decode releases the original without falling back to a full-sized DOM image or retry loop',async()=>{
  const f=fixture(),photos=f.addPhotos(1);f.failDecode.add('drawing:p0');f.select(photos);await f.render();
  assert.equal(f.grid.children[0].children[0].alt,'読込エラー');assert.equal(f.grid.children[0].children[0].src,'');
  assert.equal(f.urls.size,0);assert.equal(f.stats().activeSources,0);f.api.refresh();await f.flush();assert.equal(f.reads.length,1);f.api.release();
});

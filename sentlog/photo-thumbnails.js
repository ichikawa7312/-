/* Ephemeral, visible-only previews. Photo records and stored image bytes are read-only. */
(function(root){
  'use strict';
  if(root.SentlogPhotoThumbnails)return;
  const VERSION='20261128-visible-thumbnails-1',MAX_EDGE=384,CANCEL=Symbol('thumbnail-cancelled');
  let active=null,queue=[],running=null,pumping=false,frame=0,resumeFrame=0,decoded=0,maxDecoded=0;
  const el=id=>document.getElementById(id);
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
  const editor=()=>typeof currentView!=='undefined'&&currentView==='editor';
  const hidden=()=>document.hidden===true||document.visibilityState==='hidden';
  const cameraOpen=()=>root.SentlogContinuousCamera?.isOpen?.()===true||el('sentlogContinuousCamera')?.hidden===false;
  function current(context){
    return active===context&&!context.cancelled&&!hidden()&&!cameraOpen()&&editor()&&
      typeof activeDrawingId!=='undefined'&&activeDrawingId===context.drawingId&&
      typeof selected!=='undefined'&&selected===context.recordId&&
      typeof photoRenderSeq!=='undefined'&&photoRenderSeq===context.sequence&&
      context.grid.isConnected!==false;
  }
  function valid(job){return current(job.context)&&job.slot.visible&&job.slot.epoch===job.epoch&&!job.cancelled;}
  function settle(slot){if(slot.wait){slot.wait.resolve();slot.wait=null;}}
  function forgetUrl(url){
    if(!url)return;
    URL.revokeObjectURL(url);
    if(typeof photoThumbUrls!=='undefined'){
      const at=photoThumbUrls.indexOf(url);if(at!==-1)photoThumbUrls.splice(at,1);
    }
  }
  function releaseSlot(slot){
    slot.epoch++;slot.visible=false;slot.status='idle';
    slot.img.onload=null;slot.img.onerror=null;slot.img.style.visibility='hidden';slot.img.removeAttribute('src');
    forgetUrl(slot.url);slot.url=null;settle(slot);
    if(running&&running.slot===slot)running.cancel();
  }
  function release(){
    // Invalidate a legacy render too: it may still be waiting for IndexedDB.
    if(typeof photoRenderSeq!=='undefined')photoRenderSeq++;
    const previous=active;active=null;queue=[];
    if(frame){root.cancelAnimationFrame(frame);frame=0;}
    if(resumeFrame){root.cancelAnimationFrame(resumeFrame);resumeFrame=0;}
    if(previous){
      previous.cancelled=true;previous.cancel.resolve();
      if(previous.observer)previous.observer.disconnect();
      previous.slots.forEach(releaseSlot);
    }
    if(running)running.cancel();
    const grid=el('photoGrid');
    if(grid)grid.querySelectorAll('img').forEach(img=>img.removeAttribute('src'));
    if(typeof revokePhotoThumbUrls==='function')revokePhotoThumbUrls();
  }
  function clipRect(context){
    if(!current(context))return null;
    const clip={left:0,top:0,right:root.innerWidth||document.documentElement.clientWidth,
      bottom:root.innerHeight||document.documentElement.clientHeight};
    for(let node=context.grid;node&&node.nodeType===1;node=node.parentElement){
      const style=root.getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return null;
      const x=/(auto|scroll|hidden|clip)/.test(style.overflowX||style.overflow||'');
      const y=/(auto|scroll|hidden|clip)/.test(style.overflowY||style.overflow||'');
      if(x||y){
        const rect=node.getBoundingClientRect();
        if(x){clip.left=Math.max(clip.left,rect.left);clip.right=Math.min(clip.right,rect.right);}
        if(y){clip.top=Math.max(clip.top,rect.top);clip.bottom=Math.min(clip.bottom,rect.bottom);}
      }
    }
    return clip.right>clip.left&&clip.bottom>clip.top?clip:null;
  }
  function inRect(slot,clip){
    if(!clip||slot.item.isConnected===false)return false;
    const rect=slot.item.getBoundingClientRect();
    return rect.width>0&&rect.height>0&&rect.right>clip.left&&rect.left<clip.right&&
      rect.bottom>clip.top&&rect.top<clip.bottom;
  }
  function visible(slot,value,context){
    if(!value){if(slot.visible||slot.status!=='idle')releaseSlot(slot);return;}
    if(slot.visible)return;
    slot.visible=true;slot.status='queued';slot.wait=deferred();
    queue.push({context,slot,epoch:slot.epoch});
    pump();
  }
  function refresh(){
    const context=active;if(!context)return;
    if(!current(context)){release();return;}
    const clip=clipRect(context);
    for(const slot of context.slots)visible(slot,inRect(slot,clip),context);
  }
  function scheduleRefresh(){
    if(!active||frame)return;
    frame=root.requestAnimationFrame(()=>{frame=0;refresh();});
  }
  function abortable(job){
    const cancel=deferred();job.cancelled=false;job.aborters=[];job.cancelPromise=cancel.promise;
    job.cancel=()=>{
      if(job.cancelled)return;job.cancelled=true;
      for(const stop of job.aborters)stop();
      cancel.resolve(CANCEL);
    };
  }
  async function stage(job,promise){
    const result=await Promise.race([Promise.resolve(promise),job.cancelPromise]);
    if(result===CANCEL||!valid(job))throw CANCEL;
    return result;
  }
  async function thumbnail(job,blob){
    let inputUrl=null,image=null,canvas=null,counted=false;
    function disposeImage(){
      if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');image=null;}
      if(inputUrl){URL.revokeObjectURL(inputUrl);inputUrl=null;}
      if(counted){decoded--;counted=false;}
    }
    job.aborters.push(disposeImage);
    try{
      if(!valid(job))throw CANCEL;
      inputUrl=URL.createObjectURL(blob);image=new Image();image.decoding='async';
      decoded++;counted=true;maxDecoded=Math.max(maxDecoded,decoded);
      await stage(job,new Promise((resolve,reject)=>{
        image.onload=resolve;image.onerror=()=>reject(new Error('Photo preview decode failed'));
        image.src=inputUrl;
      }));
      const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
      if(!(width>0&&height>0))throw new Error('Photo preview dimensions are unavailable');
      // Already-small files need no canvas encoding. They obey the same pixel
      // bound and remain read-only; the decoder is still disposed in finally.
      if(width<=MAX_EDGE&&height<=MAX_EDGE)return blob;
      const ratio=Math.min(1,MAX_EDGE/Math.max(width,height));
      canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*ratio));
      canvas.height=Math.max(1,Math.round(height*ratio));
      const context=canvas.getContext('2d');if(!context)throw new Error('Photo preview canvas is unavailable');
      context.drawImage(image,0,0,canvas.width,canvas.height);
      // The only full-sized decoded image is discarded before encoding the small preview.
      disposeImage();
      const output=await stage(job,new Promise(resolve=>canvas.toBlob(resolve,
        blob.type==='image/jpeg'?'image/jpeg':'image/png',0.84)));
      if(!output)throw new Error('Photo preview encoding failed');
      return output;
    }finally{
      disposeImage();
      if(canvas){canvas.width=1;canvas.height=1;}
    }
  }
  async function load(job){
    const slot=job.slot;
    try{
      const blob=await stage(job,getPhotoBlob(slot.meta.id,job.context.drawingId));
      if(!blob){slot.img.alt='写真データなし';slot.img.style.visibility='visible';slot.status='error';return;}
      const preview=await thumbnail(job,blob);if(!valid(job))throw CANCEL;
      const url=URL.createObjectURL(preview);slot.url=url;
      if(typeof photoThumbUrls!=='undefined')photoThumbUrls.push(url);
      await stage(job,new Promise((resolve,reject)=>{
        slot.img.onload=resolve;slot.img.onerror=()=>reject(new Error('Photo preview display failed'));
        slot.img.src=url;
      }));
      slot.img.alt=slot.meta.name||'変状写真';slot.img.style.visibility='visible';slot.status='ready';
    }catch(error){
      if(error!==CANCEL&&valid(job)){
        slot.img.removeAttribute('src');forgetUrl(slot.url);slot.url=null;
        slot.img.alt='読込エラー';slot.img.style.visibility='visible';slot.status='error';
      }
    }finally{
      // A newer visibility cycle owns its own handlers and completion promise.
      if(slot.epoch===job.epoch){slot.img.onload=null;slot.img.onerror=null;settle(slot);}
    }
  }
  async function pump(){
    if(pumping)return;pumping=true;
    try{
      while(queue.length){
        const job=queue.shift();
        if(!valid(job))continue;
        abortable(job);running=job;job.slot.status='loading';
        await load(job);running=null;
      }
    }finally{running=null;pumping=false;}
  }
  async function render(){
    release();
    const grid=el('photoGrid');if(!grid)return;
    grid.innerHTML='';
    const shape=typeof selectedShape==='function'?selectedShape():null;
    const photos=root.SentlogPhotoDisplayOrder?.ordered(shape?.photos||[])||(shape?.photos||[]).slice();
    const count=el('photoCount'),empty=el('photoEmpty');if(count)count.textContent=`${photos.length}枚`;
    for(const name of ['cameraBtn','photoAddBtn']){const button=el(name);if(button)button.disabled=!shape;}
    if(!shape||!photos.length){
      if(empty){empty.textContent=shape?'写真はまだありません。':'変状を選択すると写真を登録できます。';empty.classList.remove('hidden');}
      return;
    }
    if(empty)empty.classList.add('hidden');
    if(!editor()||hidden()||cameraOpen()||typeof activeDrawingId==='undefined'||!activeDrawingId)return;
    const context={grid,drawingId:activeDrawingId,recordId:shape.id,sequence:photoRenderSeq,
      cancelled:false,cancel:deferred(),slots:[],observer:null};active=context;
    const byElement=new WeakMap();
    for(const meta of photos){
      const item=document.createElement('div');item.className='photo-thumb';item.title=meta.name||'変状写真';
      const img=document.createElement('img');img.alt=meta.name||'変状写真';img.decoding='async';img.style.visibility='hidden';
      const del=document.createElement('button');del.type='button';del.className='photo-del';del.textContent='×';del.title='この写真を外す';
      del.onclick=event=>{event.stopPropagation();if(current(context))removeSelectedPhoto(meta.id);};
      item.onclick=()=>{if(current(context))openPhotoViewer(meta.id,meta.name);};
      item.append(img,del);grid.appendChild(item);
      const slot={meta,item,img,visible:false,status:'idle',epoch:0,url:null,wait:null};
      context.slots.push(slot);byElement.set(item,slot);
    }
    if(typeof root.IntersectionObserver==='function'){
      context.observer=new root.IntersectionObserver(entries=>{
        if(!current(context))return;
        const clip=clipRect(context);
        for(const entry of entries){
          const slot=byElement.get(entry.target);if(!slot)continue;
          visible(slot,entry.isIntersecting&&inRect(slot,clip),context);
        }
      },{root:null,rootMargin:'0px',threshold:0});
      context.slots.forEach(slot=>context.observer.observe(slot.item));
    }
    refresh();
    // Preserve await renderSelectedPhotos(): wait for the initially visible images only.
    // Every visibility cancellation resolves its waiter, including an unfinished DB read.
    const initial=context.slots.filter(slot=>slot.visible).map(slot=>slot.wait?.promise||Promise.resolve());
    await Promise.race([Promise.all(initial),context.cancel.promise]);
  }
  root.renderSelectedPhotos=render;
  for(const name of ['showProjects','showDrawings','openDrawing','createDrawingFromFile']){
    const previous=root[name];if(typeof previous!=='function')continue;
    root[name]=function(){release();return previous.apply(this,arguments);};
  }
  document.addEventListener('visibilitychange',()=>{if(hidden())release();else render();});
  root.addEventListener('pagehide',release);
  root.addEventListener('pageshow',()=>{if(!hidden()&&editor())render();});
  root.addEventListener('sentlog-camera-visibility',event=>{
    if(event.detail?.open!==false){release();return;}
    // Camera completion invokes its deferred editor refresh synchronously.
    // Let that render cancel this single fallback frame, avoiding a second
    // decode pass. A camera closed without new photos still restores previews.
    if(resumeFrame)return;
    resumeFrame=root.requestAnimationFrame(()=>{
      resumeFrame=0;if(!hidden()&&!cameraOpen()&&editor())render();
    });
  });
  root.addEventListener('resize',scheduleRefresh);
  document.addEventListener('scroll',()=>{if(active&&!active.observer)scheduleRefresh();},true);
  // Drawer transforms/visibility can change without an intersection threshold crossing.
  document.addEventListener('transitionend',scheduleRefresh,true);
  document.addEventListener('click',scheduleRefresh,true);
  root.SentlogPhotoThumbnails={version:VERSION,maxEdge:MAX_EDGE,refresh,release,status:()=>({
    active:!!active,slots:active?.slots.length||0,visible:active?.slots.filter(s=>s.visible).length||0,
    ready:active?.slots.filter(s=>s.status==='ready').length||0,queued:queue.filter(valid).length,
    decoding:decoded,maxDecoding:maxDecoded,urls:active?.slots.filter(s=>!!s.url).length||0
  })};
  render();
})(window);

/* Sentlog v1.59: bounded image canvases, original drawing coordinates and bytes.
 * A 11575 x 8031 image must never allocate a full-size 93-megapixel canvas.
 * Zoom detail is drawn only for the visible region, below the annotation SVG.
 */
(function(){
  'use strict';
  const wrap=document.getElementById('stageWrap'),stage=document.getElementById('stage');
  if(!wrap || !stage || typeof renderImage!=='function')return;
  const MAX_EDGE=4096,BASE_PIXELS=2200000,DETAIL_PIXELS=6000000;
  let epoch=0,view=null,front=null,timer=0,detailKey='',openingSize=null;
  const dispose=element=>{if(element){element.remove();element.width=1;element.height=1;}};
  function invalidate(){
    epoch++;clearTimeout(timer);timer=0;detailKey='';
    if(view)view.image.src='';view=null;dispose(front);front=null;
    return epoch;
  }
  function bounded(w,h,density,budget){
    const d=Math.min(density,MAX_EDGE/w,MAX_EDGE/h,Math.sqrt(budget/(w*h)));
    return {width:Math.max(1,Math.floor(w*d)),height:Math.max(1,Math.floor(h*d))};
  }
  function current(v){
    return v && v.epoch===epoch && v.id===activeDrawingId &&
      currentView==='editor' && state.sourceType==='image';
  }
  function schedule(delay=180){
    if(!view)return;clearTimeout(timer);
    timer=setTimeout(()=>{timer=0;drawDetail();},delay);
  }
  function drawDetail(){
    const v=view;if(!current(v) || document.hidden || !(scale>0))return;
    if(activeTouches.size || panStart || labelDrag){schedule(120);return;}
    const r=wrap.getBoundingClientRect();if(r.width<1 || r.height<1)return;
    const pad=24/scale;
    const x=Math.max(0,-tx/scale-pad),y=Math.max(0,-ty/scale-pad);
    const right=Math.min(state.width,(r.width-tx)/scale+pad);
    const bottom=Math.min(state.height,(r.height-ty)/scale+pad);
    const w=right-x,h=bottom-y;if(w<=0 || h<=0)return;
    const pixels=bounded(w,h,Math.min(1,scale*Math.min(3,window.devicePixelRatio||1)),DETAIL_PIXELS);
    const key=[epoch,x,y,w,h,pixels.width,pixels.height].map(n=>Math.round(n*100)/100).join(':');
    if(key===detailKey)return;
    const buffer=document.createElement('canvas');buffer.width=pixels.width;buffer.height=pixels.height;
    let committed=false;
    try{
      const context=buffer.getContext('2d',{alpha:false});
      if(!context)throw Error('画像の拡大表示領域を確保できません');
      // Source rectangles remain in the image's coordinate system.
      const sx=v.image.naturalWidth/state.width,sy=v.image.naturalHeight/state.height;
      context.drawImage(v.image,x*sx,y*sy,w*sx,h*sy,0,0,pixels.width,pixels.height);
      if(!current(v))return;
      buffer.className='sentlog-image-detail';buffer.setAttribute('aria-hidden','true');
      buffer.style.cssText='position:absolute;pointer-events:none;transform-origin:0 0;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;';
      stage.insertBefore(buffer,svg);
      const old=front;front=buffer;committed=true;dispose(old);detailKey=key;
      wrap.dataset.imageQuality='高精細';
    }catch(error){
      if(current(v)){console.warn('Sentlog image detail',error);wrap.dataset.imageQuality='標準';}
    }finally{if(!committed)dispose(buffer);}
  }
  const oldTransform=applyTransform;
  applyTransform=function(){const result=oldTransform.apply(this,arguments);schedule();return result;};
  const oldOpen=openFile,oldOpenDrawing=openDrawing;
  openFile=async function(file,save=true){
    invalidate();
    // A receiver can decode a large image at reduced resolution. Keep the
    // existing drawing's logical coordinate frame even on that device.
    const size=!save && state.sourceType==='image' && state.width>0 && state.height>0 &&
      (!file.name || state.fileName===file.name)?
      {file,id:activeDrawingId,width:state.width,height:state.height}:null;
    openingSize=size;
    try{return await oldOpen.apply(this,arguments);}
    finally{if(openingSize===size)openingSize=null;}
  };
  openDrawing=async function(){invalidate();return oldOpenDrawing.apply(this,arguments);};
  const oldProjects=showProjects,oldDrawings=showDrawings,oldSetup=setupStage;
  showProjects=function(){invalidate();return oldProjects.apply(this,arguments);};
  showDrawings=function(){invalidate();return oldDrawings.apply(this,arguments);};
  setupStage=function(){invalidate();return oldSetup.apply(this,arguments);};

  renderImage=async function(file){
    const stamp=invalidate(),id=activeDrawingId,url=URL.createObjectURL(file);
    if(activeBlobUrl)URL.revokeObjectURL(activeBlobUrl);activeBlobUrl=url;
    const image=new Image();let committed=false;
    try{
      // Rendering happens after the load promise: drawing errors reject normally
      // and openFile can clear its loading state and show a retryable error.
      await new Promise((resolve,reject)=>{
        image.onload=resolve;image.onerror=()=>reject(Error('図面画像を読み取れません'));
        image.src=url;
      });
      if(stamp!==epoch || id!==activeDrawingId || currentView!=='editor')return;
      const size=openingSize?.file===file && openingSize.id===id?openingSize:null;
      const w=Math.round(size?.width||image.naturalWidth),h=Math.round(size?.height||image.naturalHeight);
      if(!(w>0 && h>0))throw Error('図面画像の大きさを確認できません');
      const pixels=bounded(w,h,1,BASE_PIXELS);
      // Preserve the same logical dimensions used by existing annotations and
      // scale calibration. Only the raster backing store is smaller.
      state.width=w;state.height=h;
      canvas.width=1;canvas.height=1;canvas.width=pixels.width;canvas.height=pixels.height;
      canvas.style.width=w+'px';canvas.style.height=h+'px';
      svg.setAttribute('width',w);svg.setAttribute('height',h);svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
      const context=canvas.getContext('2d',{alpha:false});
      if(!context)throw Error('図面画像の表示領域を確保できません。図面を開き直してください');
      context.clearRect(0,0,pixels.width,pixels.height);
      context.drawImage(image,0,0,pixels.width,pixels.height);
      state.pdfPageInfo=state.pdfPageInfo||{};delete state.pdfPageInfo['1'];
      view={epoch:stamp,id,image};committed=true;empty.style.display='none';
      wrap.dataset.imageQuality='標準';fit();render();updateScaleStatus();schedule(0);
    }finally{
      if(!committed){image.src='';URL.revokeObjectURL(url);if(activeBlobUrl===url)activeBlobUrl=null;}
    }
  };
  if('ResizeObserver' in window)new ResizeObserver(()=>schedule()).observe(wrap);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  window.addEventListener('pageshow',()=>schedule(0));
})();

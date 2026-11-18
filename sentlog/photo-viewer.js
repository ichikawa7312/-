/* Photo-only pinch/pan: never zoom the browser viewport or the drawing underneath.
 * The saved blob is read-only. One bounded canvas is reused, including on release.
 */
(function(){
  'use strict';
  const viewer=document.getElementById('photoViewer');
  const oldImage=document.getElementById('photoViewerImg');
  const closeButton=document.getElementById('photoViewerClose');
  const nameLabel=document.getElementById('photoViewerName');
  if(!viewer||!oldImage||!closeButton||!nameLabel||typeof getPhotoBlob!=='function')return;
  if(viewer.dataset.photoViewerVersion)return;
  viewer.dataset.photoViewerVersion='20261118';
  viewer.dataset.photoState='closed';
  viewer.setAttribute('role','dialog');
  viewer.setAttribute('aria-modal','true');
  viewer.setAttribute('aria-labelledby','photoViewerName');
  closeButton.setAttribute('aria-label','写真を閉じる');

  const style=document.createElement('style');
  style.textContent=`
    #photoViewer{padding:0;overflow:hidden;touch-action:none;overscroll-behavior:none;
      user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;isolation:isolate}
    #photoViewerImg{display:none!important}
    #photoViewerCanvas{position:absolute;inset:0;width:100%;height:100%;display:block;
      touch-action:none;border-radius:0;cursor:grab}
    #photoViewerCanvas:active{cursor:grabbing}
    #photoViewer .photo-viewer-close{z-index:3;right:max(12px,env(safe-area-inset-right));
      top:max(12px,env(safe-area-inset-top));touch-action:none}
    #photoViewer .photo-viewer-name{z-index:2;top:max(16px,env(safe-area-inset-top));
      bottom:auto;left:16px;right:68px;max-height:3em;overflow:hidden;overflow-wrap:anywhere;
      pointer-events:none}
    #photoViewerTools{position:absolute;z-index:3;bottom:max(18px,env(safe-area-inset-bottom));
      left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;white-space:nowrap}
    #photoViewerTools button{min-width:44px;min-height:44px;padding:8px 12px;border:0;
      border-radius:8px;background:#fff;color:#111827;font-size:16px;touch-action:none}
    #photoViewerTools button:disabled{opacity:.45}
    #photoViewerMessage{position:absolute;z-index:2;left:8%;right:8%;text-align:center;
      color:#fff;line-height:1.7;pointer-events:none}
    #photoViewerMessage[hidden]{display:none}
  `;
  document.head.appendChild(style);
  const surface=document.createElement('canvas');
  surface.id='photoViewerCanvas';surface.width=1;surface.height=1;
  surface.setAttribute('role','img');surface.setAttribute('aria-label','変状写真');
  viewer.insertBefore(surface,oldImage);
  const message=document.createElement('div');
  message.id='photoViewerMessage';message.setAttribute('role','status');
  message.setAttribute('aria-live','polite');viewer.appendChild(message);
  const controls=document.createElement('div');controls.id='photoViewerTools';
  controls.setAttribute('role','group');controls.setAttribute('aria-label','写真の拡大・縮小');
  function button(id,text,label){
    const b=document.createElement('button');b.id=id;b.type='button';b.textContent=text;
    b.setAttribute('aria-label',label);controls.appendChild(b);return b;
  }
  const minus=button('photoViewerZoomOut','−','写真を縮小');
  const reset=button('photoViewerReset','全体表示','写真を全体表示');
  const plus=button('photoViewerZoomIn','＋','写真を拡大');
  viewer.appendChild(controls);

  const MAX_EDGE=4096,SOURCE_PIXELS=4000000,VIEW_PIXELS=1500000,MAX_ZOOM=8;
  const points=new Map();
  let epoch=0,source=null,cancelLoad=null,frame=0,gesture=null,priorFocus=null;
  let width=0,height=0,fit=1,zoom=1,left=0,top=0,suppressClickUntil=0;
  const isOpen=()=>viewer.classList.contains('open');
  const stop=e=>{if(e.cancelable)e.preventDefault();e.stopImmediatePropagation();};
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function bounded(w,h,density,budget){
    const ratio=Math.min(density,MAX_EDGE/w,MAX_EDGE/h,Math.sqrt(budget/(w*h)));
    return {width:Math.max(1,Math.floor(w*ratio)),height:Math.max(1,Math.floor(h*ratio))};
  }
  function release(image){
    if(!image)return;
    if(typeof image.close==='function')image.close();
    else if(typeof image.getContext==='function'){image.width=1;image.height=1;}
    else {image.onload=null;image.onerror=null;image.removeAttribute('src');}
  }
  function clearPointers(){
    const ids=[...points.keys()];points.clear();gesture=null;
    for(const id of ids){try{if(viewer.hasPointerCapture(id))viewer.releasePointerCapture(id);}catch{}}
  }
  function clearResources(){
    clearPointers();cancelAnimationFrame(frame);frame=0;
    if(cancelLoad){const cancel=cancelLoad;cancelLoad=null;cancel();}
    release(source);source=null;oldImage.removeAttribute('src');
    if(typeof viewerPhotoUrl!=='undefined'&&viewerPhotoUrl){
      URL.revokeObjectURL(viewerPhotoUrl);viewerPhotoUrl=null;
    }
    surface.width=1;surface.height=1;surface.dataset.zoom='1';
    width=0;height=0;fit=1;zoom=1;left=0;top=0;
  }
  function status(state,text=''){
    viewer.dataset.photoState=state;message.textContent=text;message.hidden=!text;
    viewer.setAttribute('aria-busy',state==='loading'?'true':'false');
    minus.disabled=reset.disabled=plus.disabled=state!=='ready';
  }
  function constrain(){
    if(!source)return;
    const w=source.width*fit*zoom,h=source.height*fit*zoom;
    left=w<=width?(width-w)/2:clamp(left,width-w,0);
    top=h<=height?(height-h)/2:clamp(top,height-h,0);
  }
  function layout(resetView=false){
    const rect=viewer.getBoundingClientRect();
    if(rect.width<1||rect.height<1)return;
    const centerX=source?(width/2-left)/(fit*zoom):0;
    const centerY=source?(height/2-top)/(fit*zoom):0;
    const first=width===0||height===0;
    width=rect.width;height=rect.height;
    const size=bounded(width,height,Math.min(2,window.devicePixelRatio||1),VIEW_PIXELS);
    if(surface.width!==size.width||surface.height!==size.height){
      surface.width=1;surface.height=1;surface.width=size.width;surface.height=size.height;
    }
    if(source){
      fit=Math.min(width*.94/source.width,Math.max(1,height-144)/source.height);
      if(resetView||first){zoom=1;left=(width-source.width*fit)/2;top=(height-source.height*fit)/2;}
      else {left=width/2-centerX*fit*zoom;top=height/2-centerY*fit*zoom;}
      constrain();
    }
  }
  function draw(){
    frame=0;if(!isOpen()||!source)return;
    try{
      const context=surface.getContext('2d');
      if(!context)throw Error('写真の表示領域を確保できません');
      context.clearRect(0,0,surface.width,surface.height);
      const s=fit*zoom,rx=surface.width/width,ry=surface.height/height;
      const x=Math.max(0,-left/s),y=Math.max(0,-top/s);
      const w=Math.min(source.width,(width-left)/s)-x;
      const h=Math.min(source.height,(height-top)/s)-y;
      if(w>0&&h>0)context.drawImage(source,x,y,w,h,(left+x*s)*rx,(top+y*s)*ry,w*s*rx,h*s*ry);
      surface.dataset.zoom=String(zoom);
      reset.textContent=zoom===1?'全体表示':Math.round(zoom*100)+'% · 全体表示';
      minus.disabled=zoom<=1;plus.disabled=zoom>=MAX_ZOOM;
    }catch(error){status('error','写真を表示できませんでした。閉じて、もう一度写真を開いてください。');}
  }
  function schedule(){if(!frame&&source)frame=requestAnimationFrame(draw);}
  function local(e){const r=viewer.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  function rebase(){
    const entries=[...points.entries()];
    if(!source||!entries.length){gesture=null;return;}
    if(entries.length===1){
      gesture={ids:[entries[0][0]],x:entries[0][1].x,y:entries[0][1].y,left,top};return;
    }
    const [a,b]=entries,dist=Math.hypot(b[1].x-a[1].x,b[1].y-a[1].y);
    const x=(a[1].x+b[1].x)/2,y=(a[1].y+b[1].y)/2;
    gesture={ids:[a[0],b[0]],dist,zoom,worldX:(x-left)/(fit*zoom),worldY:(y-top)/(fit*zoom)};
  }
  function move(){
    if(!source||!gesture)return;
    const p=gesture.ids.map(id=>points.get(id));if(p.some(point=>!point))return;
    if(p.length===1){left=gesture.left+p[0].x-gesture.x;top=gesture.top+p[0].y-gesture.y;}
    else {
      const dist=Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y);
      // Rebase coincident contacts instead of multiplying a near-zero distance.
      if(gesture.dist<12){if(dist>=12)rebase();return;}
      zoom=clamp(gesture.zoom*dist/gesture.dist,1,MAX_ZOOM);
      left=(p[0].x+p[1].x)/2-gesture.worldX*fit*zoom;
      top=(p[0].y+p[1].y)/2-gesture.worldY*fit*zoom;
    }
    constrain();schedule();
  }
  function zoomAt(next,x=width/2,y=height/2){
    if(!source)return;
    const worldX=(x-left)/(fit*zoom),worldY=(y-top)/(fit*zoom);
    zoom=clamp(next,1,MAX_ZOOM);left=x-worldX*fit*zoom;top=y-worldY*fit*zoom;
    constrain();rebase();schedule();
  }
  function end(e){
    if(!isOpen()||!points.has(e.pointerId))return;
    stop(e);
    if(e.type==='pointerup'){points.set(e.pointerId,local(e));move();}
    points.delete(e.pointerId);rebase();
    try{if(viewer.hasPointerCapture(e.pointerId))viewer.releasePointerCapture(e.pointerId);}catch{}
    // No reload, refit, source decode or backing-store resize on finger release.
    suppressClickUntil=performance.now()+400;
  }
  viewer.addEventListener('pointerdown',e=>{
    if(!isOpen())return;
    // A fresh intentional button tap is not the synthetic click from a pinch.
    if(e.target.closest?.('button')&&!points.size){suppressClickUntil=0;return;}
    stop(e);if(e.pointerType==='mouse'&&e.button!==0)return;
    points.set(e.pointerId,local(e));
    try{viewer.setPointerCapture(e.pointerId);}catch{}
    rebase();
  },{capture:true,passive:false});
  viewer.addEventListener('pointermove',e=>{
    if(!isOpen()||!points.has(e.pointerId))return;
    stop(e);points.set(e.pointerId,local(e));move();
  },{capture:true,passive:false});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])viewer.addEventListener(type,end,{capture:true,passive:false});
  // Installed before the gesture starts; keeps Safari page zoom and scroll out
  // of this dialog. Elsewhere the browser's accessible page zoom stays enabled.
  for(const type of ['gesturestart','gesturechange','gestureend','touchmove','contextmenu','dragstart']){
    viewer.addEventListener(type,e=>{if(isOpen())stop(e);},{capture:true,passive:false});
  }
  viewer.addEventListener('touchstart',e=>{
    if(isOpen()&&e.touches.length>1)stop(e);
  },{capture:true,passive:false});
  viewer.addEventListener('click',e=>{
    if(isOpen()&&(!e.target.closest?.('button')||performance.now()<suppressClickUntil||points.size))stop(e);
  },{capture:true});
  viewer.addEventListener('wheel',e=>{
    if(!isOpen())return;stop(e);const p=local(e);
    zoomAt(zoom*Math.exp(-clamp(e.deltaY,-100,100)*.004),p.x,p.y);
  },{passive:false});
  plus.onclick=()=>zoomAt(zoom*1.5);minus.onclick=()=>zoomAt(zoom/1.5);
  reset.onclick=()=>{layout(true);rebase();schedule();};

  async function decode(blob,stamp){
    const url=URL.createObjectURL(blob);let image=new Image(),raster=null,bitmap=null;
    try{
      await new Promise((resolve,reject)=>{
        let settled=false;
        const finish=error=>{
          if(settled)return;settled=true;image.onload=null;image.onerror=null;
          if(cancelLoad===cancel)cancelLoad=null;
          error?reject(error):resolve();
        };
        const cancel=()=>{finish(Error('Photo viewer closed'));image.removeAttribute('src');};
        cancelLoad=cancel;image.onload=()=>finish();image.onerror=()=>finish(Error('写真を読み取れません'));
        image.src=url;
      });
      if(stamp!==epoch)return null;
      const w=image.naturalWidth,h=image.naturalHeight;
      if(!(w>0&&h>0))throw Error('写真の大きさを確認できません');
      const size=bounded(w,h,1,SOURCE_PIXELS);
      if(typeof createImageBitmap==='function'){
        try{bitmap=await createImageBitmap(image,{resizeWidth:size.width,resizeHeight:size.height,resizeQuality:'high'});}catch{}
        if(bitmap&&bitmap.width>0&&bitmap.height>0&&bitmap.width<=MAX_EDGE&&bitmap.height<=MAX_EDGE&&bitmap.width*bitmap.height<=SOURCE_PIXELS){
          const result=bitmap;bitmap=null;return result;
        }
        release(bitmap);bitmap=null;
      }
      if(stamp!==epoch)return null;
      raster=document.createElement('canvas');raster.width=size.width;raster.height=size.height;
      const context=raster.getContext('2d');if(!context)throw Error('写真の表示領域を確保できません');
      context.drawImage(image,0,0,size.width,size.height);
      context.getImageData(0,0,1,1);
      const result=raster;raster=null;return result;
    }finally{release(bitmap);release(raster);release(image);URL.revokeObjectURL(url);}
  }
  openPhotoViewer=async function(photoId,name=''){
    const stamp=++epoch,drawingId=typeof activeDrawingId==='undefined'?undefined:activeDrawingId;
    if(!isOpen())priorFocus=document.activeElement;
    clearResources();suppressClickUntil=0;
    nameLabel.textContent=name||'変状写真';surface.setAttribute('aria-label',name||'変状写真');
    viewer.classList.add('open');viewer.setAttribute('aria-hidden','false');
    status('loading','写真を読み込み中…');closeButton.focus({preventScroll:true});
    try{
      const blob=await getPhotoBlob(photoId,drawingId);
      if(stamp!==epoch)return;
      if(!blob)throw Error('この端末に写真データがありません');
      const image=await decode(blob,stamp);
      if(stamp!==epoch||!isOpen()){release(image);return;}
      source=image;if(!source)throw Error('写真を読み取れません');
      layout(true);status('ready');draw();
    }catch(error){
      if(stamp===epoch&&isOpen()){
        release(source);source=null;surface.width=1;surface.height=1;
        status('error',error?.message==='この端末に写真データがありません'?
          'この端末に写真データがありません。閉じて、写真の同期状況を確認してください。':
          '写真を表示できませんでした。閉じて、もう一度写真を開いてください。');
      }
    }
  };
  closePhotoViewer=function(){
    ++epoch;clearResources();status('closed');
    viewer.classList.remove('open');viewer.setAttribute('aria-hidden','true');
    if(priorFocus?.isConnected)priorFocus.focus?.({preventScroll:true});priorFocus=null;
  };
  closeButton.onclick=closePhotoViewer;
  window.addEventListener('keydown',e=>{
    if(!isOpen())return;
    if(e.key==='Escape'){stop(e);closePhotoViewer();}
    else if(e.key==='+'||e.key==='='){stop(e);zoomAt(zoom*1.5);}
    else if(e.key==='-'){stop(e);zoomAt(zoom/1.5);}
    else if(e.key==='0'){stop(e);layout(true);schedule();}
  },{capture:true});
  window.addEventListener('resize',()=>{if(isOpen()){clearPointers();layout();schedule();}});
  window.addEventListener('blur',clearPointers);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearPointers();});
})();

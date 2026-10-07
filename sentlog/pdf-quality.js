/* Sentlog v1.22: preserve PDF bytes; render visible detail at screen resolution.
 * World coordinates stay identical to v1.21. Detail redraws never call fit(),
 * change annotation state, or write back to the PDF. */
(function () {
  'use strict';
  const wrap=document.getElementById('stageWrap');
  const stage=document.getElementById('stage');
  if (!wrap || !stage || typeof renderPdfPage!=='function') return;
  const MAX_EDGE=4096, BASE_PIXELS=2200000, DETAIL_PIXELS=6000000;
  let epoch=0, view=null, front=null, baseTask=null, detailTask=null;
  let timer=0, request=0, detailKey='', detailBusy=false;
  const dispose=c=>{if(c){c.remove();c.width=1;c.height=1;}};
  const cancel=t=>{try{t?.cancel();}catch(_){}};
  const cancelled=e=>e?.name==='RenderingCancelledException';
  const note=document.createElement('div');
  note.id='sentlogPdfQuality'; note.className='meta'; note.style.marginTop='8px';
  document.getElementById('zoomValue')?.closest('.zoom-row')?.after(note);
  function status(text){note.textContent=text;wrap.dataset.pdfQuality=text;}
  function invalidate(){
    epoch++;request++;clearTimeout(timer);timer=0;
    cancel(baseTask);cancel(detailTask);baseTask=null;detailTask=null;
    view=null;detailKey='';dispose(front);front=null;
    return epoch;
  }
  function bounded(w,h,density,budget){
    const d=Math.min(density,MAX_EDGE/w,MAX_EDGE/h,Math.sqrt(budget/(w*h)));
    return {width:Math.max(1,Math.floor(w*d)),height:Math.max(1,Math.floor(h*d))};
  }
  function isCurrent(v){
    return v && v.epoch===epoch && v.doc===pdfDoc && v.id===activeDrawingId &&
      v.pageNo===state.currentPage && state.sourceType==='pdf' && currentView==='editor';
  }
  function region(v){
    if(!isCurrent(v) || !(scale>0))return null;
    const r=wrap.getBoundingClientRect();if(r.width<1 || r.height<1)return null;
    const pad=24/scale;
    const x=Math.max(0,-tx/scale-pad),y=Math.max(0,-ty/scale-pad);
    const right=Math.min(state.width,(r.width-tx)/scale+pad);
    const bottom=Math.min(state.height,(r.height-ty)/scale+pad);
    const w=right-x,h=bottom-y;if(w<=0 || h<=0)return null;
    const pixels=bounded(w,h,scale*Math.min(3,window.devicePixelRatio||1),DETAIL_PIXELS);
    return {x,y,w,h,...pixels,key:[epoch,x,y,w,h,pixels.width,pixels.height].map(n=>Math.round(n*100)/100).join(':')};
  }
  function schedule(delay=180){
    if(!view)return;
    clearTimeout(timer);request++;
    timer=setTimeout(()=>{timer=0;drawDetail();},delay);
  }
  async function drawDetail(){
    const v=view;if(!isCurrent(v) || document.hidden)return;
    if(detailBusy || activeTouches.size || panStart || labelDrag){schedule(120);return;}
    const area=region(v);if(!area || area.key===detailKey)return;
    const serial=request;
    const buffer=document.createElement('canvas');
    buffer.width=area.width;buffer.height=area.height;
    const context=buffer.getContext('2d',{alpha:false});
    if(!context){dispose(buffer);status('表示：標準（高精細表示を再試行）');return;}
    detailBusy=true;status('表示：高精細に描き直し中…');
    let committed=false,task=null;
    try{
      const sx=area.width/area.w,sy=area.height/area.h;
      task=v.page.render({canvasContext:context,viewport:v.viewport,
        transform:[sx,0,0,sy,-area.x*sx,-area.y*sy],background:'rgb(255,255,255)'});
      detailTask=task;await task.promise;
      if(!isCurrent(v) || serial!==request)return;
      buffer.className='sentlog-pdf-detail';buffer.setAttribute('aria-hidden','true');
      buffer.style.cssText='position:absolute;pointer-events:none;transform-origin:0 0;background:white;left:'+area.x+'px;top:'+area.y+'px;width:'+area.w+'px;height:'+area.h+'px;';
      // A painted back buffer is inserted below annotations before the old one is released.
      stage.insertBefore(buffer,document.getElementById('svg'));
      const old=front;front=buffer;committed=true;dispose(old);detailKey=area.key;
      wrap.dataset.detailWidth=String(area.width);wrap.dataset.detailHeight=String(area.height);
      wrap.dataset.detailScale=String(scale);wrap.dataset.detailPage=String(v.pageNo);
      status('表示：高精細（拡大後に自動再描画）');
    }catch(e){
      if(!cancelled(e) && isCurrent(v)){
        console.warn('Sentlog PDF detail',e);status('表示：標準（拡大操作で高精細を再試行）');
      }
    }finally{
      if(!committed)dispose(buffer);if(detailTask===task)detailTask=null;detailBusy=false;
      if(isCurrent(view) && serial!==request)schedule(100);
    }
  }
  // Keep the existing pan/pinch mathematics. Only request a background redraw.
  const oldTransform=applyTransform;
  applyTransform=function(){oldTransform.apply(this,arguments);schedule();};
  const oldOpen=openFile;
  openFile=async function(){invalidate();return oldOpen.apply(this,arguments);};
  const oldSetup=setupStage;
  setupStage=function(){invalidate();return oldSetup.apply(this,arguments);};
  const oldShowProjects=showProjects,oldShowDrawings=showDrawings;
  showProjects=function(){invalidate();return oldShowProjects.apply(this,arguments);};
  showDrawings=function(){invalidate();return oldShowDrawings.apply(this,arguments);};
  const oldOpenDrawing=openDrawing;
  openDrawing=async function(){invalidate();return oldOpenDrawing.apply(this,arguments);};

  // Base rendering is bounded in memory. Zoom detail is cropped to the visible region,
  // so even a large A0 sheet at 800% never needs a giant full-page bitmap.
  renderPdfPage=async function(pageNo){
    const doc=pdfDoc;if(!doc)return;
    pageNo=Number(pageNo);
    if(!Number.isInteger(pageNo) || pageNo<1 || pageNo>doc.numPages)return;
    const stamp=invalidate(),id=activeDrawingId;
    if(typeof resetTouchGesture==='function')resetTouchGesture();
    setLoading(true);status('表示：PDFを読み込み中…');
    let buffer=null,task=null;
    try{
      const page=await doc.getPage(pageNo);
      if(stamp!==epoch || doc!==pdfDoc || id!==activeDrawingId)return;
      const intrinsic=normalizeRotation(page.rotate||0);
      const base=page.getViewport({scale:1,rotation:intrinsic});
      // Preserve the legacy logical dimensions, independent of device pixel ratio.
      const targetScale=Math.min(2.2,Math.max(1.35,1800/base.width));
      const viewport=page.getViewport({scale:targetScale,rotation:normalizeRotation(intrinsic+getPageRotation(pageNo))});
      state.currentPage=pageNo;state.pdfPageInfo=state.pdfPageInfo||{};
      state.pdfPageInfo[String(pageNo)]={wMm:base.width*25.4/72,hMm:base.height*25.4/72};
      state.width=Math.max(1,Math.round(viewport.width));state.height=Math.max(1,Math.round(viewport.height));
      const pixels=bounded(state.width,state.height,1,BASE_PIXELS);
      canvas.width=pixels.width;canvas.height=pixels.height;
      canvas.style.width=state.width+'px';canvas.style.height=state.height+'px';
      svg.setAttribute('width',state.width);svg.setAttribute('height',state.height);
      svg.setAttribute('viewBox',`0 0 ${state.width} ${state.height}`);
      empty.style.display='none';selected=null;drawing=null;fit();render();updatePageUI();
      buffer=document.createElement('canvas');buffer.width=pixels.width;buffer.height=pixels.height;
      const context=buffer.getContext('2d',{alpha:false});
      if(!context)throw new Error('PDFの表示領域を確保できません');
      task=page.render({canvasContext:context,viewport,
        transform:[pixels.width/state.width,0,0,pixels.height/state.height,0,0],background:'rgb(255,255,255)'});
      baseTask=task;await task.promise;
      if(stamp!==epoch || doc!==pdfDoc || id!==activeDrawingId)return;
      ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(buffer,0,0);
      view={epoch:stamp,doc,page,viewport,pageNo,id};
      updatePageUI();updateScaleStatus();updateRotationUI();render();renderSelectedPhotos();persist();
      status('表示：標準 → 高精細に更新');schedule(0);
    }catch(e){
      if(!cancelled(e) && stamp===epoch){showError('PDFの表示に失敗しました：'+(e.message||e));throw e;}
    }finally{
      dispose(buffer);if(baseTask===task)baseTask=null;
      if(stamp===epoch)setLoading(false);
    }
  };
  // Avoid dynamic code generation in the pinned PDF.js 3.x rendering engine.
  if(window.pdfjsLib){
    const getDocument=pdfjsLib.getDocument.bind(pdfjsLib);
    window.pdfjsLib={...pdfjsLib,getDocument:function(source){
      if(source && typeof source==='object' && !(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source))
        source={...source,isEvalSupported:false};
      return getDocument(source);
    }};
  }
  if('ResizeObserver' in window)new ResizeObserver(()=>schedule()).observe(wrap);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  window.addEventListener('pagehide',()=>{cancel(detailTask);});
  window.addEventListener('pageshow',()=>schedule(0));
  // Test/diagnostic entry point; no app data changes.
  window.sentlogRedrawPdfDetail=()=>schedule(0);
})();

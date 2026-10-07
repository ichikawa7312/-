/* v1.25: per-drawing label size, independent of PDF scale and touch targets. */
(function () {
  'use strict';
  const sidebar=document.getElementById('sidebar');
  if(!sidebar || document.getElementById('sentlogLabelSize'))return;
  const factors=Object.freeze({small:0.65,normal:0.8,large:1});
  const names={small:'小',normal:'標準',large:'大'};
  const valid=value=>Object.prototype.hasOwnProperty.call(factors,value);
  const choice=()=>valid(state.labelSize)?state.labelSize:'normal';
  const factor=()=>factors[choice()];
  const legacyFontSize=labelFontSize;
  const originalBind=bindLabelTarget;
  const originalRender=render;

  // Older drawings without a setting use the new, smaller standard. Do not rewrite data on load.
  labelFontSize=function(){return legacyFontSize()*factor();};

  // The visible text shrinks; the invisible drag area must not shrink with it.
  bindLabelTarget=function(hit,id){
    const shape=state.shapes.find(s=>s.id===id);
    const label=shape?(shape.autoLabel || shape.no || ''):'';
    const fs=legacyFontSize(),zoom=Math.max(0.001,scale);
    const coarse=matchMedia('(any-pointer:coarse)').matches || navigator.maxTouchPoints>0;
    const minimum=(coarse?44:24)/zoom;
    const oldWidth=Math.max(32,label.length*fs*0.72+16),oldHeight=fs+10;
    const w=Number(hit.getAttribute('width')),h=Number(hit.getAttribute('height'));
    const cx=Number(hit.getAttribute('x'))+w/2,cy=Number(hit.getAttribute('y'))+h/2;
    const targetWidth=Math.max(w,oldWidth,minimum),targetHeight=Math.max(h,oldHeight,minimum);
    hit.setAttribute('x',String(cx-targetWidth/2));hit.setAttribute('y',String(cy-targetHeight/2));
    hit.setAttribute('width',String(targetWidth));hit.setAttribute('height',String(targetHeight));
    hit.dataset.labelTarget='true';
    return originalBind.call(this,hit,id);
  };

  const box=document.createElement('section');box.id='sentlogLabelSize';
  box.style.cssText='margin:8px 0;padding:12px 0;border-top:1px solid var(--line);';
  const title=document.createElement('div');title.id='sentlogLabelSizeTitle';
  title.className='section-title';title.style.margin='0 0 8px';title.textContent='変状の文字サイズ';
  const row=document.createElement('div');row.className='row';row.setAttribute('role','group');
  row.setAttribute('aria-labelledby',title.id);
  const help=document.createElement('div');help.className='meta';help.style.marginTop='8px';
  help.textContent='この図面の全ページに適用。PDFの文字・囲み線は変わりません。';
  const buttons=[];
  function updateControls(){
    const selectedSize=choice();
    for(const button of buttons){
      const active=button.dataset.labelSize===selectedSize;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
      button.disabled=!activeDrawingId;
    }
  }
  for(const key of Object.keys(factors)){
    const button=document.createElement('button');button.type='button';
    button.textContent=names[key];button.dataset.labelSize=key;
    button.style.cssText='min-height:44px;padding:8px 4px;touch-action:manipulation;';
    button.setAttribute('aria-label','変状の文字サイズ：'+names[key]);
    button.onclick=()=>{
      if(!activeDrawingId || choice()===key)return;
      state.labelSize=key;
      // No fit(), page navigation, or PDF redraw: only the annotation text changes.
      render();
      try{persist();}catch(error){
        console.error('Sentlog label size save',error);
        showError('文字サイズを保存できませんでした。端末の空き容量を確認してください。');
      }
    };
    buttons.push(button);row.appendChild(button);
  }
  box.append(title,row,help);
  const marker=document.getElementById('leaderMarkerSelect')?.parentElement;
  if(marker)marker.before(box);else sidebar.appendChild(box);

  render=function(){
    const result=originalRender.apply(this,arguments);
    // Scale only the white outline of the label, not the PDF, leaders, damage lines or photo badges.
    for(const text of svg.querySelectorAll('text[dominant-baseline="middle"]')){
      text.setAttribute('stroke-width',String(4*factor()));
    }
    updateControls();
    return result;
  };
  updateControls();
  if(currentView==='editor')render();
})();

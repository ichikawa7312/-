/* Sentlog v1.51: presentation-only toolbar. The original drawing/history buttons and
   onclick handlers remain the only drawing/undo commands. No record writes. */
(function () {
  'use strict';
  const bar=document.querySelector('#editorView .toolbar');
  if(!bar||bar.dataset.iconToolbar)return;
  const defs=[
    ['polygon','多角形','多角形（45°/90°）','頂点を順に置いて範囲を囲みます。', 'M4 4H14L20 10V20H4Z',true],
    ['freehand-line','手描き線','フリーハンド線','指やペンでなぞって線を描きます。','M3 17C5 4 9 4 11 12S17 21 21 6',false],
    ['freehand-area','手描き範囲','フリーハンド範囲','指やペンで囲んだ範囲を記録します。','M4 7C6 2 11 5 15 4S22 8 19 12S21 20 15 20S9 17 6 20S1 13 4 7Z',true],
    ['rect','四角','四角形','対角の２点を指定して四角い範囲を描きます。','M4 5H20V19H4Z',true],
    ['line','直線','直線','始点から終点まで、まっすぐな線を描きます。','M4 20L20 4',false],
    ['dimension','寸法','寸法線','任意の2点間に位置出し用の寸法線を入れます。縮尺設定時は実寸を自動表示します。','M4 5V19M20 5V19M4 12H20M7 9L4 12L7 15M17 9L20 12L17 15',false],
    ['undoBtn','戻す','戻す','直前の編集を取り消します。','M9 4L4 9L9 14M4 9H14C22 9 22 20 14 20',false],
    ['redoBtn','やり直す','やり直す','取り消した編集をやり直します。','M15 4L20 9L15 14M20 9H10C2 9 2 20 10 20',false]
  ];
  const items=defs.map(d=>({d,b:bar.querySelector('[data-tool="'+d[0]+'"]')||document.getElementById(d[0])}));
  if(items.some(x=>!x.b||!bar.contains(x.b)))return;
  bar.dataset.iconToolbar='151';bar.id=bar.id||'sentlogDrawingToolbar';
  bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','描画と取り消し');
  const make=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
  const svg=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};
  const draw=make('div'),history=make('div');draw.className='sl-tool-group';history.className='sl-tool-group sl-tool-history';
  for(const [g,label] of [[draw,'描画'],[history,'取り消しとやり直し']]){g.setAttribute('role','group');g.setAttribute('aria-label',label);}
  const descriptions=make('div');descriptions.className='sl-tool-sr';
  for(const [i,{b,d}] of items.entries()){
    b.type='button';b.classList.add('sl-tool-button');b.setAttribute('aria-label',d[2]);b.removeAttribute('title');
    const icon=svg('svg',{viewBox:'0 0 24 24',width:'24',height:'24','aria-hidden':'true',focusable:'false'});
    if(d[5])icon.append(svg('path',{d:d[4],fill:'currentColor','fill-opacity':'.14',stroke:'none'}));
    icon.append(svg('path',{d:d[4],fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'}));
    if(d[0]==='polygon')for(const [cx,cy] of [[4,4],[14,4],[20,10],[20,20],[4,20]])icon.append(svg('circle',{cx,cy,r:'1.4',fill:'currentColor'}));
    const label=make('span',d[1]);label.className='sl-tool-label';label.setAttribute('aria-hidden','true');b.replaceChildren(icon,label);
    const desc=make('span',d[3]+(i<6?' 同じボタンをもう一度押すと選択・図面移動に戻ります。':''));desc.id='sl-tool-desc-'+i;
    descriptions.append(desc);b.setAttribute('aria-describedby',desc.id);(i<6?draw:history).append(b);
  }
  bar.prepend(draw,history);bar.append(descriptions);
  const mode=make('span'),status=make('span');status.id='sentlogToolStatus';mode.id='sentlogToolMode';status.append(mode);
  mode.setAttribute('role','status');mode.setAttribute('aria-live','polite');mode.setAttribute('aria-atomic','true');
  document.getElementById('headerTitle')?.after(status);
  const pageInfo=document.getElementById('mobilePageInfo');if(pageInfo)status.append(pageInfo);
  const tip=make('div');tip.id='sentlogToolTip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.append(tip);
  const style=make('style');style.textContent=`
  #sentlogDrawingToolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:6px calc(8px + env(safe-area-inset-right,0px)) 6px calc(8px + env(safe-area-inset-left,0px));overflow:visible;flex:0 0 auto}
  #sentlogDrawingToolbar .sl-tool-group{display:flex;flex-wrap:wrap;gap:4px;align-items:center;flex:0 1 auto;min-width:0;max-width:100%}
  #sentlogDrawingToolbar .sl-tool-history{position:relative;flex-wrap:nowrap;flex-shrink:0}
  #sentlogDrawingToolbar .sl-tool-history:before{content:'';position:absolute;left:-5px;width:1px;height:24px;background:#d1d5db}
  #sentlogDrawingToolbar .sl-tool-button{box-sizing:border-box;display:inline-flex;position:relative;align-items:center;justify-content:center;gap:6px;width:var(--sl-named-width,100px);min-width:44px;min-height:44px;height:44px;flex:0 0 auto;padding:0 8px;border:2px solid #d1d5db;border-radius:8px;white-space:nowrap;line-height:1.2;background:#fff;color:#374151;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
  #sentlogDrawingToolbar .sl-tool-button svg{display:block;flex:none;width:24px;height:24px;pointer-events:none}
  #sentlogDrawingToolbar .sl-tool-label{font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;pointer-events:none}
  #sentlogDrawingToolbar.sl-icons-only .sl-tool-button{width:44px;padding:0;gap:0}
  #sentlogDrawingToolbar.sl-icons-only .sl-tool-label{display:none}
  #sentlogDrawingToolbar .sl-tool-button.active{color:#fff;background:#111827;border-color:#111827}
  #sentlogDrawingToolbar .sl-tool-button.active:after{content:'';position:absolute;bottom:3px;width:10px;height:2px;background:currentColor;border-radius:1px}
  #sentlogDrawingToolbar .sl-tool-button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
  #sentlogDrawingToolbar .sl-tool-button:disabled{opacity:.35;cursor:default}
  .sl-tool-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  #sentlogToolStatus{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;max-width:170px;font-size:11px;white-space:nowrap;line-height:1.3;padding:5px 7px;border:1px solid #64748b;border-radius:6px;color:#fff}
  #sentlogToolStatus[hidden]{display:none!important}#sentlogToolMode{overflow:hidden;text-overflow:ellipsis}
  .sl-toolbar-view #headerTitle{flex:1 1 0;min-width:0;max-width:none}
  #sentlogToolStatus #mobilePageInfo{min-width:0;font-size:10px;padding:0;white-space:nowrap}
  #sentlogToolStatus #mobilePageInfo:empty{display:none}
  .sentlog-phone #sentlogToolStatus #mobilePageInfo{display:none}
  .sentlog-phone .sl-toolbar-view #headerTitle{grid-column:2}
  .sentlog-phone #sentlogToolStatus{grid-row:1;grid-column:3;justify-self:end;max-width:90px}
  @media(orientation:landscape) and (max-height:500px){.sentlog-phone #sentlogToolStatus{grid-row:1;grid-column:2;justify-self:end}.sentlog-phone .sl-toolbar-view #headerTitle{padding-right:92px}}
  #sentlogToolTip{position:fixed;z-index:1001;max-width:min(280px,calc(100vw - 16px));padding:10px 12px;border:1px solid #475569;border-radius:8px;background:#111827;color:#fff;box-shadow:0 3px 12px #0003;font-size:12px;line-height:1.6;overflow-wrap:anywhere;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
  #sentlogToolTip[hidden]{display:none!important}#sentlogToolTip strong{display:block;font-size:13px}
  @media(forced-colors:active){#sentlogDrawingToolbar .sl-tool-button.active{outline:2px solid Highlight;outline-offset:-4px}#sentlogDrawingToolbar .sl-tool-button:disabled{color:GrayText;opacity:1}}
  `;document.head.append(style);
  let focusItem=items[0].b,tipOwner=null,tipKind='',hideTimer=0,hoverTimer=0,keyboard=false,press=null;
  const suppressed=new Map();
  const pointers=new Set();
  function update(){
    const editor=currentView==='editor';status.hidden=!editor;document.body.classList.toggle('sl-toolbar-view',editor);
    const active=items.find(x=>x.b.dataset.tool===tool);const name=active?active.d[1]:'選択・移動';
    if(mode.textContent!==name){mode.textContent=name;mode.setAttribute('aria-label','現在：'+name);}
    if(focusItem.disabled)focusItem=items.find(x=>!x.b.disabled)?.b||items[0].b;
    for(const {b} of items){
      if(b.dataset.tool)b.setAttribute('aria-pressed',String(b.dataset.tool===tool&&b.classList.contains('active')));
      b.tabIndex=b===focusItem&&!b.disabled?0:-1;
    }
    if(!editor)hide();
  }
  function layout(){
    const width=bar.getBoundingClientRect().width;if(!width)return;
    const ctx=document.createElement('canvas').getContext('2d');let required=32;
    for(const {b,d} of items){ctx.font=getComputedStyle(b.querySelector('.sl-tool-label')).font;const w=Math.max(44,Math.ceil(ctx.measureText(d[1]).width)+50);b.style.setProperty('--sl-named-width',w+'px');required+=w;}
    const css=getComputedStyle(bar),available=width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    bar.classList.toggle('sl-icons-only',required>available);hide();
  }
  function hide(){clearTimeout(hideTimer);clearTimeout(hoverTimer);tip.hidden=true;tipOwner=null;tipKind='';}
  function show(b,kind){
    if(currentView!=='editor'||!bar.getClientRects().length)return;
    const item=items.find(x=>x.b===b);if(!item)return;clearTimeout(hideTimer);tip.replaceChildren(make('strong',item.d[2]),make('span',item.d[3]));
    if(b.disabled)tip.append(make('div','現在は実行できません。'));tip.hidden=false;tipOwner=b;tipKind=kind;
    const r=b.getBoundingClientRect(),v=window.visualViewport,left=v?.offsetLeft||0,top=v?.offsetTop||0,vw=v?.width||innerWidth,vh=v?.height||innerHeight;
    const t=tip.getBoundingClientRect();tip.style.left=Math.max(left+8,Math.min(r.x+r.width/2-t.width/2,left+vw-t.width-8))+'px';
    tip.style.top=Math.max(top+8,Math.min(bar.getBoundingClientRect().bottom+5,top+vh-t.height-8))+'px';
  }
  function scheduleHide(){clearTimeout(hideTimer);hideTimer=setTimeout(()=>{if(tipKind==='hold'||(keyboard&&document.activeElement===tipOwner)||tip.matches(':hover'))return;hide();},180);}
  function cancel(suppress=true){if(!press)return;clearTimeout(press.timer);if(suppress)suppressed.set(press.b,performance.now()+2000);press=null;}
  for(const {b} of items){
    b.addEventListener('click',e=>{
      if(performance.now()<(suppressed.get(b)||0)){e.preventDefault();e.stopImmediatePropagation();suppressed.delete(b);return;}
      hide();focusItem=b;queueMicrotask(update);
    },true);
    b.addEventListener('pointerdown',e=>{
      if(e.button!==0||e.pointerType==='mouse'||pointers.size>1||!e.isPrimary)return;
      press={b,id:e.pointerId,x:e.clientX,y:e.clientY,held:false,timer:0};
      press.timer=setTimeout(()=>{if(!press||press.b!==b)return;press.held=true;show(b,'hold');},500);
    });
    b.addEventListener('contextmenu',e=>{e.preventDefault();});
    b.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){clearTimeout(hideTimer);clearTimeout(hoverTimer);hoverTimer=setTimeout(()=>show(b,'hover'),350);}});
    b.addEventListener('pointerleave',()=>{clearTimeout(hoverTimer);scheduleHide();});
    b.addEventListener('focus',()=>{focusItem=b;update();if(keyboard)show(b,'focus');});
    b.addEventListener('blur',()=>{if(tipKind!=='hold')scheduleHide();});
  }
  document.addEventListener('pointerdown',e=>{
    keyboard=false;if(e.pointerType!=='mouse')pointers.add(e.pointerId);
    if(press)cancel();
    // A genuinely new press must not inherit suppression from the preceding hold.
    if(pointers.size<=1)suppressed.clear();
    else {const b=e.target.closest?.('.sl-tool-button');if(b)suppressed.set(b,performance.now()+2000);}
    if(!tip.contains(e.target))hide();
  },true);
  document.addEventListener('pointermove',e=>{
    if(press?.id===e.pointerId&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>10){cancel();hide();}
  },true);
  document.addEventListener('pointerup',e=>{
    pointers.delete(e.pointerId);if(press?.id!==e.pointerId)return;
    const r=press.b.getBoundingClientRect(),outside=e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;
    const held=press.held;cancel(held||outside);if(held){e.preventDefault();e.stopPropagation();}
  },{capture:true,passive:false});
  document.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);if(press?.id===e.pointerId){cancel();hide();}},true);
  tip.addEventListener('pointerenter',()=>clearTimeout(hideTimer));tip.addEventListener('pointerleave',scheduleHide);
  document.addEventListener('keydown',e=>{
    keyboard=true;suppressed.clear();
    if(e.key==='Escape'&&(!tip.hidden||press)){cancel();hide();e.preventDefault();e.stopPropagation();}
  },true);
  bar.addEventListener('keydown',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){
      e.preventDefault();const enabled=items.map(x=>x.b).filter(x=>!x.disabled),i=enabled.indexOf(b);
      const next=e.key==='Home'?0:e.key==='End'?enabled.length-1:(i+(e.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
      enabled[next]?.focus();
    }else if(e.repeat&&(e.key==='Enter'||e.key===' '))e.preventDefault();
  });
  const originalRender=render;render=function(){const r=originalRender.apply(this,arguments);update();return r;};
  const originalEditor=showEditor;showEditor=function(){const r=originalEditor.apply(this,arguments);update();layout();return r;};
  const originalProjects=showProjects;showProjects=function(){cancel();hide();const r=originalProjects.apply(this,arguments);update();return r;};
  const originalDrawings=showDrawings;showDrawings=function(){cancel();hide();const r=originalDrawings.apply(this,arguments);update();return r;};
  new MutationObserver(update).observe(bar,{subtree:true,attributes:true,attributeFilter:['class','disabled']});
  const resized=()=>{cancel();hide();layout();};if(typeof ResizeObserver==='function')new ResizeObserver(layout).observe(bar);
  window.addEventListener('resize',resized);window.visualViewport?.addEventListener('resize',resized);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pointers.clear();cancel();hide();}});
  window.addEventListener('blur',()=>{pointers.clear();cancel();hide();});
  document.fonts?.ready.then(layout);
  window.SentlogToolbarIcons={version:'v1.51',refresh:update,layout};
  update();layout();
})();

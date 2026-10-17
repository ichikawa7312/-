/* Sentlog v1.63: concrete crack-width wheel input and compact W= display. */
(function(root){
  'use strict';
  const STEP=.05,MIN=.05,MAX=10,DEFAULT=.20;
  const values=Array.from({length:Math.round((MAX-MIN)/STEP)+1},(_,i)=>Number((MIN+i*STEP).toFixed(2)));
  const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').replace(/ひびわれ/g,'ひび割れ');
  function isCrackName(name){return normalize(name).includes('ひび割れ');}
  function formatWidth(value){
    const n=Number(value);if(!Number.isFinite(n)||n<=0)return '';
    return n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
  }
  function nearestIndex(value){
    const n=Number(value);if(!Number.isFinite(n))return Math.round((DEFAULT-MIN)/STEP);
    return Math.max(0,Math.min(values.length-1,Math.round((n-MIN)/STEP)));
  }
  const pure={STEP,MIN,MAX,DEFAULT,values,isCrackName,formatWidth,nearestIndex};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogCrackWidth)return;

  const typeEl=document.getElementById('damageType'),member=document.getElementById('member');
  if(!typeEl||!member)return;
  const catalog=root.SentlogDamageCatalog;
  const ITEM=44,LAST_PREFIX='sentlogCrackWidthLastV1:';
  let field=null,openBtn=null,modal=null,wheel=null,valueView=null,targetId=null,selectedIndex=nearestIndex(DEFAULT),scrollFrame=0,returnFocus=null;

  function currentProject(){try{return typeof getProject==='function'?getProject():null;}catch(_){return null;}}
  function currentShape(){try{return state?.shapes?.find(s=>s.id===selected)||null;}catch(_){return null;}}
  function catalogEntry(name){
    try{
      if(!catalog?.forProject||!catalog?.matchName)return null;
      return catalog.matchName(catalog.forProject(currentProject(),state?.shapes||[]),name);
    }catch(_){return null;}
  }
  function isConcreteCrack(shapeOrName){
    const name=typeof shapeOrName==='string'?shapeOrName:shapeOrName?.type;
    if(!isCrackName(name))return false;
    const entry=catalogEntry(name);
    if(entry)return entry.group==='concrete';
    const material=document.getElementById('damageMaterial')?.value;
    return material==='concrete'||normalize(name)==='ひび割れ'||normalize(name)==='床版ひび割れ';
  }
  function lastKey(){const id=currentProject()?.id||'default';return LAST_PREFIX+id;}
  function lastWidth(){
    try{const n=Number(localStorage.getItem(lastKey()));return Number.isFinite(n)&&n>0?n:DEFAULT;}catch(_){return DEFAULT;}
  }
  function remember(value){try{if(Number(value)>0)localStorage.setItem(lastKey(),String(Number(value)));}catch(_){}}
  function selectedWidth(shape=currentShape()){
    const n=Number(shape?.crackWidthMm);return Number.isFinite(n)&&n>0?n:null;
  }
  function widthText(shape){const n=selectedWidth(shape);return n==null?'未測定':formatWidth(n)+' mm';}

  function installField(){
    if(field)return;
    field=document.createElement('div');field.id='crackWidthField';field.hidden=true;
    const label=document.createElement('label');label.textContent='ひび割れ幅（mm）';label.htmlFor='crackWidthOpen';
    openBtn=document.createElement('button');openBtn.type='button';openBtn.id='crackWidthOpen';openBtn.textContent='未測定';openBtn.style.width='100%';openBtn.disabled=true;
    field.append(label,openBtn);
    const host=member.closest('div')||member.parentElement;host?.insertAdjacentElement('afterend',field);
    openBtn.onclick=()=>{const s=currentShape();if(s&&isConcreteCrack(s))openPicker(s);};
  }
  function installModal(){
    if(modal)return;
    const style=document.createElement('style');style.textContent=`
#crackWidthField[hidden]{display:none!important}#crackWidthOpen{min-height:44px;text-align:left;font-weight:700;background:#fff}
#crackWidthModal{position:fixed;inset:0;z-index:1150;background:rgba(0,0,0,.46);display:none;align-items:flex-end;justify-content:center;padding:12px;box-sizing:border-box}#crackWidthModal.open{display:flex}
#crackWidthModal .cw-card{width:min(430px,100%);max-height:calc(100dvh - 24px);overflow:auto;background:#fff;color:#111827;border-radius:16px;padding:16px;box-sizing:border-box;box-shadow:0 20px 60px #0005}
#crackWidthModal .cw-head{display:flex;align-items:center;justify-content:space-between;gap:10px}#crackWidthModal h2{font-size:18px;margin:0}#crackWidthModal .cw-note{font-size:12px;line-height:1.6;color:#4b5563;margin:8px 0 12px}
#crackWidthModal .cw-wheel-wrap{position:relative;width:min(250px,100%);height:220px;margin:0 auto;overflow:hidden;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb}
#crackWidthWheel{height:220px;overflow-y:auto;scroll-snap-type:y mandatory;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:88px 0;box-sizing:border-box;scrollbar-width:none}#crackWidthWheel::-webkit-scrollbar{display:none}
#crackWidthWheel button{display:block;width:100%;height:44px;border:0;background:transparent;font:600 24px/44px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#6b7280;padding:0;scroll-snap-align:center;touch-action:manipulation}#crackWidthWheel button[aria-selected="true"]{color:#111827;font-size:28px}
#crackWidthModal .cw-center{position:absolute;left:0;right:0;top:88px;height:44px;border-top:1px solid #94a3b8;border-bottom:1px solid #94a3b8;pointer-events:none;background:rgba(241,245,249,.45)}
#crackWidthModal .cw-value{text-align:center;margin:12px 0 4px;font-size:13px;color:#64748b}#crackWidthModal .cw-value strong{display:block;font-size:24px;color:#111827;margin-top:3px}
#crackWidthModal .cw-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}#crackWidthModal .cw-actions button{min-height:44px}#crackWidthSave{background:#111827;color:#fff;border-color:#111827}
@media(min-width:700px){#crackWidthModal{align-items:center}}
`;
    document.head.appendChild(style);
    modal=document.createElement('div');modal.id='crackWidthModal';modal.setAttribute('aria-hidden','true');
    modal.innerHTML=`<div class="cw-card" role="dialog" aria-modal="true" aria-labelledby="crackWidthTitle"><div class="cw-head"><h2 id="crackWidthTitle">ひび割れ幅</h2><button type="button" id="crackWidthClose">閉じる</button></div><p class="cw-note">単位：mm　0.05mm刻みで上下に回して選択します。</p><div class="cw-wheel-wrap"><div id="crackWidthWheel" role="listbox" aria-label="ひび割れ幅"></div><div class="cw-center" aria-hidden="true"></div></div><div class="cw-value">選択値<strong id="crackWidthValue">W=0.2</strong></div><div class="cw-actions"><button type="button" id="crackWidthUnset">未測定</button><button type="button" id="crackWidthDirect">直接入力</button><button type="button" id="crackWidthCancel">キャンセル</button><button type="button" id="crackWidthSave">決定</button></div></div>`;
    document.body.appendChild(modal);wheel=modal.querySelector('#crackWidthWheel');valueView=modal.querySelector('#crackWidthValue');
    values.forEach((v,i)=>{const b=document.createElement('button');b.type='button';b.dataset.index=String(i);b.setAttribute('role','option');b.textContent=formatWidth(v);b.onclick=()=>{selectIndex(i,true);};wheel.appendChild(b);});
    wheel.addEventListener('scroll',()=>{if(scrollFrame)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;selectIndex(Math.round(wheel.scrollTop/ITEM),false);});},{passive:true});
    modal.querySelector('#crackWidthClose').onclick=closePicker;modal.querySelector('#crackWidthCancel').onclick=closePicker;
    modal.querySelector('#crackWidthSave').onclick=()=>{const s=currentTarget();if(s){setWidth(s,values[selectedIndex]);closePicker();}};
    modal.querySelector('#crackWidthUnset').onclick=()=>{const s=currentTarget();if(s){setWidth(s,null);closePicker();}};
    modal.querySelector('#crackWidthDirect').onclick=()=>{const s=currentTarget();if(!s)return;const existing=selectedWidth(s);const raw=prompt('ひび割れ幅をmmで入力してください。\n例：0.12',existing==null?'':formatWidth(existing));if(raw==null)return;const text=String(raw).trim().replace('，','.').replace(',','.');if(!/^\d+(?:\.\d{1,2})?$/.test(text)){alert('0.12 のように、mm単位で小数第2位まで入力してください。');return;}const n=Number(text);if(!(n>0&&n<=100)){alert('0より大きく100mm以下で入力してください。');return;}setWidth(s,Number(n.toFixed(2)));closePicker();};
    modal.addEventListener('pointerdown',e=>{if(e.target===modal)closePicker();});
    modal.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closePicker();}});
  }
  function selectIndex(index,scroll){
    selectedIndex=Math.max(0,Math.min(values.length-1,Number(index)||0));
    if(scroll)wheel.scrollTo({top:selectedIndex*ITEM,behavior:'smooth'});
    for(const b of wheel.querySelectorAll('button'))b.setAttribute('aria-selected',Number(b.dataset.index)===selectedIndex?'true':'false');
    valueView.textContent='W='+formatWidth(values[selectedIndex]);
  }
  function currentTarget(){const s=currentShape();return s&&s.id===targetId&&isConcreteCrack(s)?s:null;}
  function openPicker(shape){
    if(!shape||!isConcreteCrack(shape))return;installModal();targetId=shape.id;returnFocus=document.activeElement;
    const current=selectedWidth(shape),start=current==null?lastWidth():current;selectedIndex=nearestIndex(start);selectIndex(selectedIndex,false);
    modal.classList.add('open');modal.setAttribute('aria-hidden','false');
    requestAnimationFrame(()=>{wheel.scrollTop=selectedIndex*ITEM;selectIndex(selectedIndex,false);modal.querySelector('#crackWidthSave')?.focus({preventScroll:true});});
  }
  function closePicker(){if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');targetId=null;(returnFocus?.isConnected?returnFocus:openBtn)?.focus?.({preventScroll:true});returnFocus=null;}
  function setWidth(shape,value){
    if(!shape||!isConcreteCrack(shape))return false;
    const old=selectedWidth(shape),next=value==null?null:Number(value);
    if(next!=null&&(!Number.isFinite(next)||next<=0))return false;
    if((old==null&&next==null)||(old!=null&&next!=null&&Math.abs(old-next)<1e-9))return false;
    if(typeof pushHistory==='function')pushHistory(shape.page||state.currentPage);
    shape.crackWidthMm=next;
    if(next!=null)remember(next);
    if(typeof render==='function')render();if(typeof persist==='function')persist();syncInspector();return true;
  }
  function syncInspector(){
    installField();const s=currentShape(),eligible=!!s&&isConcreteCrack(s);field.hidden=!eligible;openBtn.disabled=!eligible;openBtn.textContent=eligible?widthText(s):'未測定';
  }
  function labelPaint(shape){
    try{
      const mode=root.SentlogDamageStyles?.getMode?.()||'hatch';
      const style=root.SentlogLabelColors?.labelStyle?.(shape.type,currentProject(),mode,scale);
      return {color:style?.color||'#111827',halo:Number(style?.halo)||2.2/Math.max(scale,.001)};
    }catch(_){return {color:'#111827',halo:2.2/Math.max(scale,.001)};}
  }
  function drawWidths(){
    if(typeof svg==='undefined'||typeof currentShapes!=='function')return;
    for(const old of svg.querySelectorAll('[data-crack-width-id]'))old.remove();
    for(const s of currentShapes()){
      const width=selectedWidth(s);if(width==null||!isConcreteCrack(s))continue;
      const lp=getLabelPos(s),fs=typeof labelFontSize==='function'?labelFontSize():18/Math.max(scale||1,.001),font=Math.max(11,fs*.82),y=lp.y+fs*1.02,paint=labelPaint(s);
      const t=makeEl('text',{x:lp.x,y,'font-size':font,'text-anchor':'middle','dominant-baseline':'middle',fill:paint.color,'font-weight':'700','paint-order':'stroke fill','stroke':'#fff','stroke-width':paint.halo,'stroke-linejoin':'round','pointer-events':'none'});
      t.dataset.crackWidthId=s.id;t.textContent='W='+formatWidth(width);svg.appendChild(t);
    }
  }

  installField();installModal();
  const oldRender=render;render=function(){const result=oldRender.apply(this,arguments);drawWidths();syncInspector();return result;};
  const oldSelect=selectShape;selectShape=function(){const result=oldSelect.apply(this,arguments);syncInspector();return result;};
  const oldAdd=addShape;addShape=function(){const result=oldAdd.apply(this,arguments),s=currentShape();syncInspector();if(s&&isConcreteCrack(s)&&selectedWidth(s)==null)setTimeout(()=>{if(currentShape()?.id===s.id)openPicker(s);},0);return result;};
  typeEl.addEventListener('change',()=>setTimeout(syncInspector,0));document.getElementById('damageMaterial')?.addEventListener('change',()=>setTimeout(syncInspector,0));
  root.SentlogCrackWidth={...pure,isConcreteCrack,setWidth,open:openPicker,syncInspector};
  if(typeof currentView!=='undefined'&&currentView==='editor')render();else syncInspector();
})(typeof window==='object'?window:globalThis);

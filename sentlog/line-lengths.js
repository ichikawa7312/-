/* Sentlog v1.82: recorded lengths for straight and freehand damage lines.
 * The entered metres stay authoritative. Only calibrated pages resize geometry;
 * all vertices scale about the first point, preserving the drawn bends. */
(function(root){
'use strict';
const MIN=.001,MAX=10000,TOL=.0005,HOLD_MS=500;
function isLine(s){
  return !!s&&['line','freehand-line'].includes(s.kind)&&
    !['drawing-memo','field-record','dimension-line'].includes(s.recordKind)&&Array.isArray(s.points)&&s.points.length>=2;
}
function manualMetres(s){const n=Number(s?.lineLengthM);return Number.isFinite(n)&&n>=MIN&&n<=MAX?n:null;}
function hasManual(s){return isLine(s)&&manualMetres(s)!=null;}
function resizePath(points,currentMm,targetM,bounds){
  if(!Array.isArray(points)||points.length<2||!Number.isFinite(currentMm)||currentMm<=0||
     !Number.isFinite(targetM)||targetM<MIN||targetM>MAX||
     points.some(p=>!Number.isFinite(p?.x)||!Number.isFinite(p?.y)))return {error:'invalid'};
  const factor=targetM*1000/currentMm,a=points[0];
  const next=points.map(p=>({...p,x:a.x+(p.x-a.x)*factor,y:a.y+(p.y-a.y)*factor}));
  if(next.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return {error:'invalid'};
  if(bounds&&next.some(p=>p.x<0||p.y<0||p.x>bounds.width||p.y>bounds.height))return {error:'outside'};
  return {points:next,factor};
}
const pure={MIN,MAX,TOL,HOLD_MS,isLine,manualMetres,hasManual,resizePath};
if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
if(!root.document||root.SentlogLineLengths)return;
if(!root.SentlogShapeDimensions||typeof lineLengthMm!=='function')throw Error('線の長さ機能の読み込み順序が正しくありません。');
const svg=$('svg'),wrap=$('stageWrap'),dimensions=root.SentlogShapeDimensions;
let editor=null,hold=null,field=null,openButton=null;
const z=()=>Math.max(.001,Number(scale)||1);
const calibrated=s=>dimensions.calibrated(s.page||1);
function source(id){return state.shapes.find(s=>s.id===id&&(s.page||1)===state.currentPage&&isLine(s));}
function measuredMetres(s){const mm=calibrated(s)?lineLengthMm(s.points,s.page||1):null;return Number.isFinite(mm)?mm/1000:null;}
function mismatched(s){const target=manualMetres(s),actual=measuredMetres(s);return target!=null&&calibrated(s)&&(actual==null||Math.abs(actual-target)>TOL);}
function displayText(s){
  const manual=manualMetres(s),actual=measuredMetres(s),value=manual??actual;
  return value==null?'長さを入力':(mismatched(s)?'⚠ ':'')+'L='+value.toFixed(3)+' m';
}
function reconcile(s){
  const target=manualMetres(s),measured=measuredMetres(s);
  if(target==null||!calibrated(s)||(measured!=null&&Math.abs(measured-target)<=TOL))return [];
  const result=resizePath(s.points,measured==null?NaN:measured*1000,target,{width:state.width,height:state.height});
  if(result.error)return [{index:0,target,measured,reason:result.error}];
  s.points=result.points;return [];
}
function apply(s,value){
  if(!isLine(s)||!Number.isFinite(value)||value<MIN||value>MAX)return '0.001m以上10000m以下の長さを入力してください。';
  const target=Math.round(value*1000)/1000;let points=null;
  if(calibrated(s)){
    const result=resizePath(s.points,lineLengthMm(s.points,s.page||1),target,{width:state.width,height:state.height});
    if(result.error)return result.error==='outside'?'この長さでは図面の外に出ます。線を移動するか、長さを見直してください。':'長さを計算できない線です。図面設定と線を確認してください。';
    points=result.points;
  }
  pushHistory(s.page||1);s.lineLengthM=target;if(points)s.points=points;
  persist();render();updateMeasureResult();return null;
}
function clear(s){
  if(!hasManual(s))return;
  pushHistory(s.page||1);delete s.lineLengthM;persist();render();updateMeasureResult();
}
function clearHold(){if(hold?.timer)clearTimeout(hold.timer);hold=null;}
function closeEditor(){if(editor){editor.panel.remove();editor=null;}}
function scope(s){return JSON.stringify([activeProjectId,activeDrawingId,state.currentPage,s?.id,s?.points,s?.lineLengthM,getPageSetting(s?.page||1),state.width,state.height]);}
function validEditor(){return editor&&currentView==='editor'&&selected===editor.id&&scope(source(editor.id))===editor.scope;}
function element(tag,text){const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;}
function openEditor(id){
  const s=source(id);if(!s||currentView!=='editor')return;
  clearHold();closeEditor();if(selected!==id)selectShape(id);
  const panel=element('form');panel.className='sentlog-line-length-editor';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','線の長さを編集');
  panel.style.cssText='position:fixed;z-index:1220;left:50%;top:12%;transform:translateX(-50%);width:290px;max-width:calc(100vw - 24px);max-height:75dvh;overflow:auto;box-sizing:border-box;padding:16px;background:#fff;color:#111827;border:1px solid #94a3b8;border-radius:12px;box-shadow:0 8px 28px #0004;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  const title=element('strong',s.kind==='freehand-line'?'くねくね線の長さ':'線の長さ');title.style.cssText='display:block;font-size:16px;margin-bottom:12px';
  const label=element('label','合計の長さ（m）');label.htmlFor='sentlogLineLengthInput';
  const input=element('input');input.id='sentlogLineLengthInput';input.type='number';input.inputMode='decimal';input.min=String(MIN);input.max=String(MAX);input.step='.001';input.required=true;
  const initial=manualMetres(s)??measuredMetres(s);input.value=initial==null?'':initial.toFixed(3);input.placeholder='例：1.200';input.style.cssText='display:block;width:100%;box-sizing:border-box;height:44px;margin:6px 0;font-size:18px;padding:8px;border:1px solid #94a3b8;border-radius:7px';
  const note=element('p',calibrated(s)?'縮尺あり：始点を固定し、線の形を保ったまま入力した長さに合わせます。':'縮尺なし：長さだけを記録します。描いた線の形や位置は変わりません。');
  note.style.cssText='font-size:12px;line-height:1.6;color:#475569;margin:8px 0';
  if(s.kind==='freehand-line')note.append(document.createTextNode(' 曲がった線に沿った合計長さです。'));
  if(mismatched(s))note.append(document.createTextNode(' 現在の図形実寸は '+(measuredMetres(s)?.toFixed(3)??'未取得')+' m です。'));
  const error=element('div');error.setAttribute('role','alert');error.style.cssText='color:#b91c1c;font-size:12px;line-height:1.5';
  const row=element('div');row.style.cssText='display:flex;gap:8px;margin-top:12px';
  const save=element('button','確定');save.type='submit';save.style.cssText='flex:1;min-height:44px;background:#1d4ed8;color:#fff;border:0;border-radius:8px';
  const cancel=element('button','閉じる');cancel.type='button';cancel.style.cssText='flex:1;min-height:44px;background:#fff;border:1px solid #cbd5e1;border-radius:8px';cancel.onclick=closeEditor;
  row.append(save,cancel);panel.append(title,label,input,note,error,row);
  if(hasManual(s)){
    const remove=element('button','手入力した長さを解除');remove.type='button';remove.dataset.clearLineLength='true';remove.style.cssText='width:100%;min-height:44px;margin-top:8px;background:#fff;border:1px solid #cbd5e1;border-radius:8px';
    remove.onclick=()=>{if(!validEditor()){closeEditor();return;}const current=source(id);closeEditor();clear(current);};panel.append(remove);
  }
  panel.addEventListener('pointerdown',e=>e.stopPropagation());
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeEditor();}});
  panel.onsubmit=e=>{e.preventDefault();if(!validEditor()){closeEditor();return;}const message=apply(source(id),Number(input.value));if(message)error.textContent=message;else closeEditor();};
  editor={id,scope:scope(s),panel};document.body.appendChild(panel);input.focus({preventScroll:true});input.select();
}
function installField(){
  if(field)return;
  const member=$('member');if(!member)return;
  field=element('div');field.id='sentlogLineLengthField';field.hidden=true;
  const label=element('label','線の長さ（m）');label.htmlFor='sentlogLineLengthOpen';
  openButton=element('button','長さを入力');openButton.type='button';openButton.id='sentlogLineLengthOpen';openButton.style.cssText='width:100%;min-height:44px;text-align:left;background:#fff;font-weight:700';
  openButton.onclick=()=>openEditor(selected);field.append(label,openButton);
  const host=$('crackWidthField')||member.closest('div');host?.insertAdjacentElement('afterend',field);
}
function syncInspector(){
  installField();if(!field)return;const s=currentView==='editor'?source(selected):null;
  field.hidden=!s;field.style.display=s?'':'none';openButton.disabled=!s;if(s)openButton.textContent=displayText(s);
}
function bindHold(hit,id){
  hit.addEventListener('pointerdown',e=>{
    if(tool!=='pan'||gestureLock||activeTouches.size>1||(e.pointerType==='mouse'&&e.button!==0))return;
    e.preventDefault();e.stopPropagation();clearHold();const s=source(id);if(!s)return;
    const request={id,pointerId:e.pointerId,x:e.clientX,y:e.clientY,scope:scope(s),timer:null};hold=request;
    request.timer=setTimeout(()=>{if(hold!==request)return;clearHold();if(tool==='pan'&&!gestureLock&&activeTouches.size<=1&&selected===id&&scope(source(id))===request.scope)openEditor(id);},HOLD_MS);
    try{wrap.setPointerCapture(e.pointerId);}catch{}
  });
}
function drawLengths(){
  for(const old of svg.querySelectorAll('[data-line-length-id],[data-line-length-hit]'))old.remove();
  if(currentView!=='editor')return;
  for(const s of currentShapes().filter(isLine)){
    const manual=manualMetres(s),actual=measuredMetres(s),chosen=selected===s.id;
    const crack=root.SentlogCrackWidth?.isConcreteCrack?.(s);
    if(!chosen&&manual==null&&(actual==null||crack))continue;
    const placeholder=manual==null&&actual==null,text=displayText(s),p=getLabelPos(s),base=labelFontSize(),font=root.SentlogDimensionText?.fontSize()??10.5/z();
    const widthLabel=[...svg.querySelectorAll('[data-crack-width-id]')].find(el=>el.dataset.crackWidthId===s.id);
    const nameLabel=[...svg.querySelectorAll('[data-damage-label-role="name"]')].find(el=>el.dataset.damageLabelId===s.id);
    const nameBox=nameLabel?.getBBox(),nameBottom=nameBox?nameBox.y+nameBox.height+1/z():p.y+base*.5;
    const widthBox=widthLabel?.getBBox();
    let y=Math.max(widthBox?widthBox.y+widthBox.height+font*.5+2/z():p.y+base*1.02,nameBottom+font*.5+1/z());
    const style=root.SentlogLabelColors?.labelStyle?.(s.type,getProject(),root.SentlogDamageStyles?.getMode?.()||'hatch',scale);
    const t=makeEl('text',{x:p.x,y,'font-size':font,'text-anchor':'middle','dominant-baseline':'middle',fill:chosen?'#1d4ed8':style?.color||'#111827','font-weight':'700','paint-order':'stroke fill',stroke:'#fff','stroke-width':style?.halo||2.2/z(),'pointer-events':'none'});
    t.dataset.lineLengthId=s.id;if(!placeholder)t.dataset.shapeSummaryId=s.id;t.textContent=text;svg.appendChild(t);
    // System-font ascent differs across platforms; use rendered glyph bounds.
    const floor=Math.max(nameBottom,widthBox?widthBox.y+widthBox.height+2/z():nameBottom),glyph=t.getBBox();
    if(glyph.y<floor){y+=floor-glyph.y;t.setAttribute('y',String(y));}
    if(chosen&&tool==='pan'){
      const b=t.getBBox(),w=Math.max(80/z(),b.width+16/z()),h=Math.max(30/z(),b.height+10/z());
      // The padded length target must never cover the draggable name text.
      const center=b.y+b.height/2,top=Math.max(center-h/2,nameBottom);
      const hit=makeEl('rect',{x:p.x-w/2,y:top,width:w,height:center+h/2-top,fill:'rgba(0,0,0,.001)','pointer-events':'all'});
      hit.dataset.lineLengthHit=s.id;hit.style.touchAction='none';hit.style.cursor='pointer';hit.setAttribute('aria-label','長押しで線の長さを入力');bindHold(hit,s.id);svg.appendChild(hit);
    }
  }
}
root.SentlogLineLengths={version:'v1.82',...pure,measuredMetres,displayText,reconcile,open:openEditor};
const oldMeasurement=shapeMeasurement;
shapeMeasurement=function(s){return hasManual(s)?{kind:'length',value:manualMetres(s)*1000}:oldMeasurement.apply(this,arguments);};
const oldRender=render;render=function(){const result=oldRender.apply(this,arguments);if(editor&&!validEditor())closeEditor();drawLengths();syncInspector();return result;};
const oldPreview=renderPreview;renderPreview=function(){const result=oldPreview.apply(this,arguments);drawLengths();return result;};
const oldSelect=selectShape;selectShape=function(){const result=oldSelect.apply(this,arguments);syncInspector();return result;};
window.addEventListener('pointermove',e=>{if(hold&&e.pointerId===hold.pointerId&&Math.hypot(e.clientX-hold.x,e.clientY-hold.y)>12)clearHold();},{capture:true,passive:true});
window.addEventListener('pointerdown',e=>{if(hold&&e.pointerId!==hold.pointerId)clearHold();},{capture:true,passive:true});
for(const name of ['pointerup','pointercancel','lostpointercapture'])window.addEventListener(name,clearHold,{capture:true,passive:true});
window.addEventListener('blur',()=>{clearHold();closeEditor();});
window.addEventListener('pagehide',()=>{clearHold();closeEditor();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearHold();closeEditor();}});
installField();if(currentView==='editor')render();else syncInspector();
})(typeof window==='object'?window:globalThis);

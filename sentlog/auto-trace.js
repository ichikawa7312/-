/* Sentlog automatic trace UI v1: camera, editable suggestions, calibration and normal damage recording.
 * Offline-only analysis; no changes to stored shapes until final confirmation.
 */
(function(root){
'use strict';
if(!root.document||root.SentlogAutoTrace)return;
const Core=root.SentlogAutoTraceCore;
if(!Core){console.warn('Sentlog auto tracing engine unavailable');return;}
const $=id=>document.getElementById(id);
const TYPES=['ひび割れ','浮き','剥離','遊離石灰','漏水','その他'];
const MAX_IMG=760;
let session=null,modal=null,editor=null,placing=null,photoInput=null,button=null,styleAdded=false;
function element(tag,cls,text){
  const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;
}
function n(v){return Number(v)||0;}
function validM(v){const x=Number(v);return Number.isFinite(x)&&x>=.001&&x<=10000?x:null;}
function uidSafe(){return typeof uid==='function'?uid():(root.crypto?.randomUUID?.()||'trace-'+Date.now()+'-'+Math.random());}
function cloneCandidates(v){return JSON.parse(JSON.stringify(v));}
function bound(x,min,max){return Math.max(min,Math.min(max,x));}
function formatM(v){return Number.isFinite(v)?v.toFixed(3)+' m':'未設定';}
function errorText(v){if(editor?.status){editor.status.textContent=v||'';editor.status.style.color='#b91c1c';}}
function statusText(v){if(editor?.status){editor.status.textContent=v||'';editor.status.style.color='#334155';}}
function installStyle(){
 if(styleAdded)return;styleAdded=true;
 const s=element('style');s.id='slAutoTraceStyle';
 s.textContent=[
 '.sl-trace-open{background:#ecfeff!important;border-color:#0891b2!important;color:#155e75!important;font-weight:800!important;width:110px!important;min-width:110px!important;flex:0 0 110px!important;height:44px!important;padding:0 7px!important;white-space:nowrap!important}',
 '.sl-trace-modal{position:fixed;inset:0;z-index:1500;display:flex;justify-content:center;align-items:center;background:rgba(15,23,42,.76);padding:8px;box-sizing:border-box}',
 '.sl-trace-dialog{display:flex;flex-direction:column;gap:9px;width:min(940px,100%);height:min(96dvh,950px);overflow:hidden;background:#fff;color:#0f172a;border-radius:13px;padding:12px;box-sizing:border-box;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
 '.sl-trace-header{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;width:100%;min-height:48px;flex:0 0 auto;position:relative;z-index:1}',
 '.sl-trace-header button{display:inline-flex;justify-content:center;align-items:center;min-width:82px;min-height:48px;padding:9px 12px;flex:0 0 auto;touch-action:manipulation;white-space:nowrap;font-size:13px}',
 '.sl-trace-header button:focus-visible{outline:3px solid #0284c7;outline-offset:2px}',
 '.sl-trace-zoom{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;min-width:0;max-width:340px;flex:1 1 0;align-items:center;flex-wrap:nowrap!important}',
 '.sl-trace-header .sl-trace-zoom button{box-sizing:border-box;min-width:44px!important;width:100%;max-width:none;min-height:48px!important;padding:5px 2px!important;flex:1 1 0!important;font-size:clamp(10px,2.75vw,13px)!important;white-space:nowrap;line-height:1.15}',
 '.sl-trace-header .sl-trace-back{flex:0 0 auto;min-width:82px!important;min-height:48px!important;padding:8px 10px!important;font-size:12px!important;white-space:nowrap}',

 '.sl-trace-header h2{font-size:17px;margin:0}',
 '.sl-trace-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
 '.sl-trace-actions button,.sl-trace-row button{font-size:12px;min-height:36px;padding:6px 9px;border-radius:7px}',
 '.sl-trace-actions button.active{background:#0e7490;color:#fff;border-color:#0e7490}',
 '.sl-trace-modes{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;width:100%;align-items:stretch;flex-wrap:nowrap!important}',
 '.sl-trace-modes>button{box-sizing:border-box;min-width:0!important;width:100%;min-height:44px;padding:5px 1px!important;white-space:nowrap;overflow:hidden;text-overflow:clip;font-weight:700;font-size:clamp(10px,2.8vw,12px)!important;line-height:1.15}',
 '.sl-trace-modes>button.active{outline:2px solid #0e7490;outline-offset:-2px}',
 '.sl-trace-modes>button:focus-visible{outline:3px solid #0284c7;outline-offset:2px}',
 '.sl-trace-scroll{flex:1;min-height:120px;overflow:auto;overscroll-behavior:contain;background:#d7d9d6;border-radius:8px;text-align:left}',
 '.sl-trace-canvas{display:block;touch-action:none;max-width:none;height:auto;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}',
 '.sl-trace-footer{display:grid;gap:7px}',
 '.sl-trace-help{font-size:11px;color:#475569;line-height:1.35}',
 '.sl-trace-set{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid #e2e8f0;padding-top:7px}',
 '.sl-trace-set label{font-size:12px;margin:0;color:#334155;font-weight:700}',
 '.sl-trace-set input[type=number]{width:105px;height:39px;font-size:15px}',
 '.sl-trace-set input[type=checkbox]{width:18px;height:18px}',
 '.sl-trace-candidates{display:flex;gap:6px;overflow-x:auto;min-height:57px;padding:5px 1px}',
 '.sl-trace-candidates-panel,.sl-trace-settings{border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;padding:0 9px}',
 '.sl-trace-candidates-panel summary,.sl-trace-settings summary{display:flex;align-items:center;justify-content:space-between;min-height:40px;font-weight:700;color:#0f172a;cursor:pointer;list-style:none;font-size:13px}',
 '.sl-trace-candidates-panel summary::-webkit-details-marker,.sl-trace-settings summary::-webkit-details-marker{display:none}',
 '.sl-trace-candidates-panel summary::after,.sl-trace-settings summary::after{content:"▾";margin-left:8px;color:#64748b;transform:rotate(-90deg)}',
 '.sl-trace-candidates-panel[open] summary::after,.sl-trace-settings[open] summary::after{transform:rotate(0)}',
 '.sl-trace-candidates-panel[open] .sl-trace-candidates{max-height:min(30dvh,235px);overflow-y:auto;align-items:flex-start}',
 '.sl-trace-detect{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:0 0 9px}',
 '.sl-trace-detect select{flex:1 1 110px;max-width:180px;min-height:39px;padding:6px;font-size:13px}',
 '.sl-trace-region-label{font-size:11px;color:#334155;flex:1 1 100%}',
 '.sl-trace-row{flex:0 0 198px;padding:7px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;display:grid;gap:5px}',
 '.sl-trace-row.selected{border:2px solid #0891b2;padding:6px;background:#ecfeff}',
 '.sl-trace-rowline{display:flex;align-items:center;gap:6px;justify-content:space-between}',
 '.sl-trace-row select{width:100%;height:35px;padding:4px;font-size:12px}',
 '.sl-trace-row input[type=number]{width:75px;height:33px;font-size:12px;padding:3px}',
 '.sl-trace-row input[type=checkbox]{width:18px;height:18px;flex:0 0 18px}',
 '.sl-trace-status{font-size:12px;min-height:18px;color:#334155;line-height:1.4}',
 '.sl-trace-primary{background:#0f766e!important;border-color:#0f766e!important;color:#fff!important}',
 '.sl-trace-placepanel{position:fixed;z-index:1495;top:70px;left:50%;transform:translateX(-50%);width:min(96vw,570px);max-height:45vh;overflow:auto;border-radius:12px;border:1px solid #94a3b8;background:#fff;padding:10px;box-shadow:0 9px 32px #0005;display:grid;gap:7px}',
 '.sl-trace-placepanel strong{font-size:14px}',
 '.sl-trace-placepanel .sl-trace-actions button{min-height:40px}',
 '.sl-trace-placement-hit{position:absolute;inset:0;z-index:18;touch-action:none;cursor:move}',
 '.sl-trace-place-msg{font-size:12px;color:#475569;line-height:1.5}',
 '@media(max-width:520px){.sl-trace-modal{padding:calc(max(56px,var(--sl-trace-safe-top,env(safe-area-inset-top,0px))) + 6px) 8px calc(max(8px,env(safe-area-inset-bottom,0px)) + 6px);align-items:stretch}.sl-trace-dialog{height:100%;max-height:100%;min-height:0;gap:7px;padding:9px}.sl-trace-header h2{font-size:15px;line-height:1.3;min-width:0}.sl-trace-actions button{min-height:39px}.sl-trace-set{gap:5px}.sl-trace-row{flex-basis:170px}.sl-trace-placepanel{top:max(75px,calc(env(safe-area-inset-top,0px) + 14px))}}'
 ].join('');
 document.head.append(s);
}
function closeModal(){
 if(modal){modal.remove();modal=null;}editor=null;
 if(session){session.file=null;session.photo=null;}session=null;
}
function dismissPlacement(backToEditor=false){
 if(!placing)return;
 placing.overlay.remove();placing.svg.remove();placing.panel.remove();placing=null;
 if(backToEditor&&session){openEditor();paint();}
 else closeModal();
}
function newButton(text,fn,cls=''){
 const b=element('button',cls,text);b.type='button';b.onclick=fn;return b;
}
function group(){return element('div','sl-trace-actions');}
async function imageFromFile(file){
 if(!file||!String(file.type).startsWith('image/'))throw Error('写真ファイルを選択してください。');
 let image=null,url=null;
 try{
   if(root.createImageBitmap){try{image=await createImageBitmap(file);}catch(_){image=null;}}
   if(!image){
     url=URL.createObjectURL(file);
     image=await new Promise((resolve,reject)=>{
       const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('写真を開けませんでした'));im.src=url;
     });
   }
   const rawW=image.width||image.naturalWidth,rawH=image.height||image.naturalHeight;
   const factor=Math.min(1,MAX_IMG/Math.max(rawW,rawH));
   const c=document.createElement('canvas');c.width=Math.max(1,Math.round(rawW*factor));c.height=Math.max(1,Math.round(rawH*factor));
   const cx=c.getContext('2d',{willReadFrequently:true});if(!cx)throw Error('画像処理が利用できません');
   cx.drawImage(image,0,0,c.width,c.height);
   const pixels=cx.getImageData(0,0,c.width,c.height);
   return {canvas:c,pixels};
 }finally{if(typeof image?.close==='function')image.close();if(url)URL.revokeObjectURL(url);}
}
function selectedCandidates(){return session?.candidates.filter(c=>c.active!==false)||[];}
function currentCandidate(){return session?.candidates.find(c=>c.id===session.selectedId)||null;}
function chooseType(kind){
 const chosen=$('damageType')?.value||'ひび割れ';
 return kind==='area'?(TYPES.includes(chosen)&&chosen!=='ひび割れ'?chosen:'浮き'):(chosen==='ひび割れ'?'ひび割れ':'ひび割れ');
}
async function openFile(file){
 if(!file)return;
 if(currentView!=='editor'||!activeDrawingId||!state.sourceType){alert('図面を開いてから自動描写を使用してください。');return;}
 if(placing)dismissPlacement(true);
 if(!modal)openEditor();
 statusText('写真を読み込み、白チョークを認識しています…');
 try{
   const {canvas:photo,pixels}=await imageFromFile(file);
   await new Promise(resolve=>requestAnimationFrame(resolve));
   const result=Core.analyze(pixels,{sensitivity:'standard'});
   const candidates=result.candidates.map(c=>({...c,active:true,type:chooseType(c.kind),manualM:null}));
   session={file,photo,candidates,selectedId:candidates[0]?.id||null,mode:'edit',undo:[],zoom:1,reference:null,refM:null,refPicks:[],region:null,sensitivity:'standard',dirty:false,drawingId:activeDrawingId,page:state.currentPage};
   if(!editor)openEditor();
   editor.canvas.width=photo.width;editor.canvas.height=photo.height;
   redraw();
   if(candidates.length)statusText('候補 '+candidates.length+' 件。誤認識は消去・削除・変形してから図面に配置できます。');
   else statusText('自動で線を検出できませんでした。手動で線や囲いを追加することもできます。');
 }catch(e){errorText('認識できませんでした：'+(e?.message||e));console.error('auto trace',e);}
}
function remember(){
 if(!session)return;
 session.undo.push({candidates:cloneCandidates(session.candidates),selectedId:session.selectedId,reference:session.reference?cloneCandidates(session.reference):null,dirty:!!session.dirty});
 session.dirty=true;
 if(session.undo.length>40)session.undo.shift();
}
function revert(){
 if(!session?.undo.length)return;
 const prev=session.undo.pop();session.candidates=prev.candidates;session.selectedId=prev.selectedId;session.reference=prev.reference;session.dirty=prev.dirty;
 redraw();
}
function photoRatio(){
 if(!session?.reference||!validM(session.refM))return null;
 let px=session.reference.px;
 if(session.reference.kind==='candidate'){
   const item=session.candidates.find(c=>c.id===session.reference.id);
   if(!item)return null;px=Core.pathLength(item.points,item.kind==='area');
 }
 return px>0?session.refM/px:null;
}
function estimatedLength(c){
 if(validM(c.manualM))return validM(c.manualM);
 const ratio=photoRatio();return ratio?Core.pathLength(c.points,false)*ratio:null;
}
function sensitivityLabel(value){
 return value==='strict'?'厳しめ':value==='wide'?'広め':'標準';
}
function reanalyze(){
 if(!session?.photo)return false;
 if(session.dirty&&!confirm('手動で修正した候補を再認識の結果に置き換えますか？\n図面に確定済みの変状には影響しません。'))return false;
 try{
   const c=session.photo,cx=c.getContext('2d',{willReadFrequently:true});
   if(!cx)throw Error('写真を読み取れませんでした');
   const result=Core.analyze(cx.getImageData(0,0,c.width,c.height),{
     sensitivity:session.sensitivity||'standard',region:session.region||undefined
   });
   remember();
   session.candidates=result.candidates.map(c=>({...c,active:true,type:chooseType(c.kind),manualM:null}));
   session.selectedId=session.candidates[0]?.id||null;
   // A user-drawn pair of reference points remains valid for this same photo,
   // but a reference candidate may not exist after re-analysis.
   if(session.reference?.kind==='candidate')session.reference=null;
   session.refPicks=[];session.mode='edit';session.dirty=false;
   redraw();
   statusText('再認識：'+result.candidates.length+'件（'+sensitivityLabel(session.sensitivity)+'）'
     +(session.region?'・指定範囲のみ':'・写真全体')+'。図面へは未確定です。');
   return true;
 }catch(e){errorText('再認識に失敗しました：'+(e?.message||e));return false;}
}

function redraw(){
 if(!session||!editor)return;
 paint();renderCandidates();renderStatus();
}
function renderStatus(){
 if(!session||!editor)return;
 editor.refInput.value=session.refM==null?'':String(session.refM);
 const ratio=photoRatio();
 editor.referenceText.textContent=ratio?'基準設定済み：1 px ≒ '+(ratio*1000).toFixed(2)+' mm（撮影面が平面である前提）':'基準未設定：線を選ぶか、写真上の2点を指定してください。';
 editor.undo.disabled=!session.undo.length;
 for(const b of editor.modes.querySelectorAll('[data-mode]')){const active=b.dataset.mode===session.mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
 editor.settingsSummary.textContent='白チョーク認識調整（'+sensitivityLabel(session.sensitivity)+'）';
 editor.sensitivity.value=session.sensitivity||'standard';
 editor.regionText.textContent=session.region?'認識範囲を指定中（点線の内側のみ）':'認識範囲：写真全体';
 editor.canvas.style.width=(session.zoom*100)+'%';
 editor.canvas.style.touchAction=session.mode==='pan'?'pan-x pan-y':'none';
}
function renderCandidates(){
 const host=editor.rows;host.replaceChildren();
 editor.candidatesSummary.textContent='認識候補 '+session.candidates.length+'件（選択 '+selectedCandidates().length+'件）';
 if(!session.candidates.length){host.append(element('span','sl-trace-help','候補なし：線を描き足す／囲いを追加から描けます。'));return;}
 for(const c of session.candidates){
   const row=element('div','sl-trace-row'+(c.id===session.selectedId?' selected':''));
   row.onclick=()=>{session.selectedId=c.id;redraw();};
   const top=element('div','sl-trace-rowline');
   const tick=element('input');tick.type='checkbox';tick.checked=c.active!==false;tick.setAttribute('aria-label','この候補を配置する');
   tick.onchange=e=>{e.stopPropagation();c.active=tick.checked;session.dirty=true;redraw();};
   const title=element('b',null,(c.kind==='area'?'範囲':'線')+' '+c.id.replace(/[^0-9]/g,''));
   top.append(tick,title,element('span','sl-trace-help',c.kind==='area'?'囲い':'ひび割れ線'));row.append(top);
   const select=element('select');for(const type of TYPES){const option=element('option',null,type);option.value=type;select.append(option);}
   select.value=c.type;select.onchange=e=>{e.stopPropagation();c.type=select.value;session.dirty=true;};select.onclick=e=>e.stopPropagation();row.append(select);
   if(c.kind==='line'){
     const line=element('div','sl-trace-rowline');
     const len=estimatedLength(c);
     line.append(element('span','sl-trace-help',len==null?'長さ 未設定':(validM(c.manualM)?'手入力 ':'自動算出 ')+formatM(len)));
     const value=element('input');value.type='number';value.inputMode='decimal';value.step='.001';value.min='.001';value.placeholder='修正m';value.title='この線の長さを手入力で修正';value.value=validM(c.manualM)||'';
     value.onchange=e=>{e.stopPropagation();const v=value.value.trim();if(v&&!validM(v)){errorText('長さは0.001～10000mで入力してください。');value.value=validM(c.manualM)||'';return;}c.manualM=v?validM(v):null;session.dirty=true;redraw();};
     value.onclick=e=>e.stopPropagation();
     line.append(value);row.append(line);
   }else{
     const box=coordinateBox(c.points),ratio=photoRatio();
     row.append(element('span','sl-trace-help',ratio?'概算：幅 '+formatM(box.w*ratio)+' × 高さ '+formatM(box.h*ratio):'寸法は基準設定後に概算表示'));
   }
   const del=newButton('候補を削除',()=>{remember();session.candidates=session.candidates.filter(v=>v.id!==c.id);if(session.selectedId===c.id)session.selectedId=session.candidates[0]?.id||null;redraw();});
   del.onclick=e=>{e.stopPropagation();remember();session.candidates=session.candidates.filter(v=>v.id!==c.id);if(session.selectedId===c.id)session.selectedId=session.candidates[0]?.id||null;redraw();};
   row.append(del);host.append(row);
 }
}
function coordinateBox(points){
 let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
 for(const p of points){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);}
 return {x:x0,y:y0,w:x1-x0,h:y1-y0,cx:(x0+x1)/2,cy:(y0+y1)/2};
}
function pointDistanceSegment(p,a,b){
 const dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy,t=len?bound(((p.x-a.x)*dx+(p.y-a.y)*dy)/len,0,1):0;
 const q={x:a.x+dx*t,y:a.y+dy*t};return {distance:Core.pathLength([p,q]),projection:q,t};
}
function nearestCandidate(p){
 let best=null;
 for(const c of session.candidates){
   for(let i=0;i<c.points.length-(c.kind==='area'?0:1);i++){
     const q=pointDistanceSegment(p,c.points[i],c.points[(i+1)%c.points.length]);
     if(!best||q.distance<best.distance)best={item:c,index:i,position:q.projection,t:q.t,distance:q.distance};
   }
 }
 return best;
}
function photoPoint(e){
 const rect=editor.canvas.getBoundingClientRect();
 return {x:bound((e.clientX-rect.left)*editor.canvas.width/rect.width,0,editor.canvas.width),y:bound((e.clientY-rect.top)*editor.canvas.height/rect.height,0,editor.canvas.height)};
}
function paint(){
 if(!session?.photo||!editor)return;
 const c=editor.canvas,cx=c.getContext('2d');cx.clearRect(0,0,c.width,c.height);cx.drawImage(session.photo,0,0);
 for(const item of session.candidates){
   const pts=item.points;if(pts.length<2)continue;
   const selected=item.id===session.selectedId;
   cx.beginPath();cx.moveTo(pts[0].x,pts[0].y);
   for(let i=1;i<pts.length;i++)cx.lineTo(pts[i].x,pts[i].y);
   if(item.kind==='area')cx.closePath();
   if(item.kind==='area'){cx.fillStyle='rgba(245,158,11,.16)';cx.fill();}
   cx.lineWidth=selected?3.6:2.4;cx.strokeStyle=item.active===false?'#94a3b8':item.kind==='area'?'#f59e0b':'#10b981';cx.stroke();
   if(selected){
     cx.fillStyle='#fff';cx.strokeStyle='#0e7490';cx.lineWidth=1;
     const step=Math.max(1,Math.ceil(pts.length/35));
     for(let i=0;i<pts.length;i+=step){cx.beginPath();cx.arc(pts[i].x,pts[i].y,3,0,Math.PI*2);cx.fill();cx.stroke();}
   }
 }
 const shownRegion=editor.gesture?.kind==='region'
   ?{x0:editor.gesture.start.x,y0:editor.gesture.start.y,x1:editor.gesture.end.x,y1:editor.gesture.end.y}
   :session.region;
 if(shownRegion){
   const x=Math.min(shownRegion.x0,shownRegion.x1),y=Math.min(shownRegion.y0,shownRegion.y1);
   const w=Math.abs(shownRegion.x1-shownRegion.x0),h=Math.abs(shownRegion.y1-shownRegion.y0);
   cx.save();cx.setLineDash([7,4]);cx.strokeStyle='#0284c7';cx.lineWidth=2.5;
   cx.fillStyle='rgba(2,132,199,.07)';cx.fillRect(x,y,w,h);cx.strokeRect(x,y,w,h);cx.restore();
 }
 if(session.refPicks?.length){cx.fillStyle='#0ea5e9';for(const p of session.refPicks){cx.beginPath();cx.arc(p.x,p.y,5,0,Math.PI*2);cx.fill();}}
 if(editor.gesture?.kind==='draw'&&editor.gesture.points.length){
   cx.beginPath();const pts=editor.gesture.points;cx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)cx.lineTo(pts[i].x,pts[i].y);
   if(editor.gesture.shapeKind==='area'&&pts.length>2)cx.closePath();
   cx.strokeStyle='#0ea5e9';cx.lineWidth=3;cx.stroke();
 }
}
function eraseAt(p){
 const radius=12;let changed=false,next=[];
 for(const c of session.candidates){
   if(c.kind==='area'){next.push(c);continue;}
   let touched=false;
   const expanded=[];
   for(let i=0;i<c.points.length-1;i++){
     const a=c.points[i],b=c.points[i+1],len=Core.pathLength([a,b]),count=Math.max(1,Math.ceil(len/4));
     for(let j=0;j<count;j++)expanded.push({x:a.x+(b.x-a.x)*j/count,y:a.y+(b.y-a.y)*j/count});
   }expanded.push(c.points[c.points.length-1]);
   const sections=[],keep=[];for(const v of expanded){
     if(Math.hypot(v.x-p.x,v.y-p.y)<=radius){if(keep.length>=3)sections.push([...keep]);keep.length=0;changed=true;touched=true;}
     else keep.push(v);
   }if(keep.length>=3)sections.push(keep);
   if(!touched){next.push(c);continue;}
   for(let i=0;i<sections.length;i++)next.push({...c,id:i===0?c.id:uidSafe(),points:Core.simplify(sections[i],.8)});
 }
 if(changed){session.candidates=next;session.selectedId=next.find(c=>c.id===session.selectedId)?.id||next[0]?.id||null;}
 return changed;
}
function pointerDown(e){
 if(!session||session.mode==='pan')return;
 if(e.pointerType==='mouse'&&e.button!==0)return;
 e.preventDefault();const p=photoPoint(e);
 if(session.mode==='ref'){
   session.refPicks.push(p);if(session.refPicks.length>=2){
     const px=Core.pathLength(session.refPicks);if(px>5){session.reference={kind:'points',px};statusText('基準2点を指定しました。実測長さを入力してください。');}
     else errorText('基準点を離して指定してください。');
     session.refPicks=[];
   }redraw();return;
 }
 editor.canvas.setPointerCapture(e.pointerId);
 if(session.mode==='region'){
   editor.gesture={kind:'region',pointerId:e.pointerId,start:p,end:p};paint();return;
 }
 if(session.mode==='add-line'||session.mode==='add-area'){
   editor.gesture={kind:'draw',pointerId:e.pointerId,shapeKind:session.mode==='add-area'?'area':'line',points:[p]};
   paint();return;
 }
 if(session.mode==='erase'){
   remember();editor.gesture={kind:'erase',pointerId:e.pointerId};eraseAt(p);redraw();return;
 }
 if(session.mode==='edit'){
   const near=nearestCandidate(p);
   if(!near||near.distance>34){session.selectedId=null;redraw();return;}
   if(near.item.id!==session.selectedId){session.selectedId=near.item.id;redraw();return;}
   remember();
   const c=near.item;
   if(near.t>.12&&near.t<.88&&c.points.length<150){
     c.points.splice(near.index+1,0,near.position);
     near.index++;
   }else near.index=near.t>=.5?(near.index+1)%c.points.length:near.index;
   editor.gesture={kind:'drag',pointerId:e.pointerId,id:c.id,index:near.index,start:p,original:cloneCandidates(c.points)};
 }
}
function pointerMove(e){
 const g=editor?.gesture;if(!g||g.pointerId!==e.pointerId||!session)return;
 e.preventDefault();const p=photoPoint(e);
 if(g.kind==='region')g.end=p;
 else if(g.kind==='draw'){const last=g.points[g.points.length-1];if(Core.pathLength([last,p])>=2)g.points.push(p);}
 else if(g.kind==='erase')eraseAt(p);
 else if(g.kind==='drag'){
   const c=session.candidates.find(v=>v.id===g.id);if(!c)return;
   const dx=p.x-g.start.x,dy=p.y-g.start.y,source=g.original[g.index];
   for(let i=0;i<c.points.length;i++){
     const q=g.original[i],d=Math.hypot(q.x-source.x,q.y-source.y);
     const influence=i===g.index?1:Math.exp(-d*d/(2*25*25));
     c.points[i]={x:bound(q.x+dx*influence,0,session.photo.width),y:bound(q.y+dy*influence,0,session.photo.height)};
   }
 }
 paint();
}
function pointerUp(e){
 const g=editor?.gesture;if(!g||g.pointerId!==e.pointerId||!session)return;
 e.preventDefault();
 if(g.kind==='region'){
   const next=Core.normalizeRegion({x0:g.start.x,y0:g.start.y,x1:g.end.x,y1:g.end.y},session.photo.width,session.photo.height);
   editor.gesture=null;
   if(!next||next.x1-next.x0<24||next.y1-next.y0<24){errorText('認識したい場所を指で囲ってください（24px以上）。');redraw();return;}
   const old=session.region;session.region=next;
   if(!reanalyze()){session.region=old;redraw();}
   return;
 }
 if(g.kind==='draw'&&g.points.length>=2){
   const points=Core.simplify(g.points,1.4,g.shapeKind==='area');
   if(Core.pathLength(points,g.shapeKind==='area')>15&&(g.shapeKind==='line'?points.length>=2:points.length>=3&&Math.abs(Core.signedArea(points))>45)){
     remember();
     const c={id:uidSafe(),kind:g.shapeKind,points,active:true,type:chooseType(g.shapeKind),manualM:null,source:'manual-correction'};
     session.candidates.push(c);session.selectedId=c.id;
   }
 }
 editor.gesture=null;redraw();
}
function openEditor(){
 installStyle();if(modal)modal.remove();
 modal=element('div','sl-trace-modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','自動描写を修正');
 const dialog=element('div','sl-trace-dialog');
 const header=element('div','sl-trace-header');
 // Keep photography zoom and edit undo on the title row to free vertical space.
 // Back is a distinct control and remains below the iPhone status bar.
 const zoom=group();zoom.classList.add('sl-trace-zoom');zoom.setAttribute('role','group');zoom.setAttribute('aria-label','写真の拡大縮小と編集の取消');
 const zoomOut=newButton('− 縮小',()=>{if(session){session.zoom=Math.max(1,session.zoom/1.5);redraw();}});
 zoomOut.title='写真を縮小';zoomOut.setAttribute('aria-label','写真を縮小');
 const zoomIn=newButton('＋ 拡大',()=>{if(session){session.zoom=Math.min(5,session.zoom*1.5);redraw();}});
 zoomIn.title='写真を拡大';zoomIn.setAttribute('aria-label','写真を拡大');
 const undoEdit=newButton('↶ 取消',revert);
 undoEdit.title='写真上の直前の修正を取り消す';undoEdit.setAttribute('aria-label','直前の編集を取り消す');
 zoom.append(zoomOut,zoomIn,undoEdit);
 const back=newButton('← 戻る',()=>closeModal(),'sl-trace-back');
 back.title='図面に戻る（未確定の候補は破棄）';
 back.setAttribute('aria-label','写真編集を閉じて図面に戻る');
 header.append(zoom,back);
 // Seven commands always stay on one row, including on 320px iPhones.
 // Full instructions remain available to screen readers and pointer tooltips.
 const modes=group();modes.classList.add('sl-trace-modes');
 const modeDefs=[
   ['edit','修正','選択した線や囲いの形を直す'],
   ['erase','消去','不要な線を指でなぞって部分消去'],
   ['add-line','＋線','線を手描きで追加'],
   ['add-area','＋囲い','変状の囲いを手描きで追加'],
   ['ref','基準','写真の2点を指定して実測長さの基準にする'],
   ['region','範囲','再認識する写真の範囲を指定'],
   ['pan','移動','写真をスクロールして移動']
 ];
 for(const [id,label,description] of modeDefs){
   const b=newButton(label,()=>{
     if(!session)return;
     session.mode=id;session.refPicks=[];redraw();
     statusText(description);
   });
   b.dataset.mode=id;b.title=description;b.setAttribute('aria-label',description);
   modes.append(b);
 }
 const scroll=element('div','sl-trace-scroll'),canvas=element('canvas','sl-trace-canvas');scroll.append(canvas);
 canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);
 canvas.addEventListener('pointercancel',()=>{if(editor)editor.gesture=null;redraw();});
 const footer=element('div','sl-trace-footer');
 const helper=element('span','sl-trace-help','緑：線　黄：囲い／斜線は図面に登録しません。誤認識は削除でき、実測長さも修正できます。');
 const settingsPanel=element('details','sl-trace-settings');
 const settingsSummary=element('summary',null,'白チョーク認識調整（標準）');
 const detect=element('div','sl-trace-detect');
 const sensLabel=element('label',null,'感度');
 const sensitivity=element('select');sensitivity.setAttribute('aria-label','白チョーク認識感度');
 for(const [value,name] of [['strict','厳しめ'],['standard','標準'],['wide','広め']]){
   const opt=element('option',null,name);opt.value=value;sensitivity.append(opt);
 }
 sensitivity.value='standard';
 sensitivity.onchange=()=>{if(!session)return;session.sensitivity=sensitivity.value;redraw();statusText('感度を変更しました。「再認識」で反映します。');};
 const regionButton=newButton('範囲指定',()=>{
   if(!session)return;
   session.mode='region';settingsPanel.open=false;redraw();
   statusText('写真上の認識したい範囲を指で四角く囲ってください。選択後、自動で再認識します。');
 });
 const clearRegion=newButton('全体に戻す',()=>{
   if(!session)return;
   const previous=session.region;session.region=null;
   if(!reanalyze()){session.region=previous;redraw();}
 });
 const runAgain=newButton('再認識',reanalyze,'sl-trace-primary');
 const regionText=element('div','sl-trace-region-label','認識範囲：写真全体');
 detect.append(sensLabel,sensitivity,regionButton,clearRegion,runAgain,regionText);
 settingsPanel.append(settingsSummary,detect);
 const candidatesPanel=element('details','sl-trace-candidates-panel');
 const candidatesSummary=element('summary',null,'認識候補 0件');
 const rows=element('div','sl-trace-candidates');candidatesPanel.append(candidatesSummary,rows);
 const calibration=element('div','sl-trace-set');
 const lineRef=newButton('選択線を基準',()=>{
   const c=currentCandidate();if(!c){errorText('基準にする線を選択してください。');return;}
   session.reference={kind:'candidate',id:c.id};session.refPicks=[];redraw();
 });
 const refLabel=element('label',null,'基準実測長さ（m）');
 const refInput=element('input');refInput.type='number';refInput.inputMode='decimal';refInput.min='.001';refInput.max='10000';refInput.step='.001';refInput.placeholder='例 1.200';
 refInput.onchange=()=>{
   const v=refInput.value.trim();if(v&&!validM(v)){errorText('実測長さは0.001～10000mで入力してください。');return;}
   session.refM=v?validM(v):null;redraw();
 };
 const referenceText=element('span','sl-trace-help');calibration.append(lineRef,refLabel,refInput,referenceText);
 const actions=group();const attachLabel=element('label');attachLabel.style.cssText='display:inline-flex;align-items:center;gap:4px;white-space:nowrap;font-size:12px';
 const attach=element('input');attach.type='checkbox';attach.checked=true;attachLabel.append(attach,document.createTextNode('撮影写真も各変状に添付'));
 const status=element('div','sl-trace-status');status.setAttribute('role','status');
 const buttonNext=newButton('図面に仮配置 →',beginPlacement,'sl-trace-primary');
 actions.append(attachLabel,newButton('撮り直す',()=>photoInput?.click()),buttonNext);
 footer.append(helper,settingsPanel,candidatesPanel,calibration,actions,status);
 dialog.append(header,modes,scroll,footer);modal.append(dialog);document.body.append(modal);
 editor={canvas,rows,modes,refInput,referenceText,status,undo:undoEdit,attach,gesture:null,settingsPanel,settingsSummary,sensitivity,regionText,candidatesPanel,candidatesSummary};
 if(session){canvas.width=session.photo.width;canvas.height=session.photo.height;redraw();}
 else statusText('カメラで撮影すると自動描写を開始します。');
}
function mergedBox(candidates){
 const all=candidates.flatMap(c=>c.points);return coordinateBox(all);
}
function drawingMetresPerPixel(){
 try{
   const paper=typeof getPaperMm==='function'?getPaperMm(state.currentPage):null;
   const den=typeof pageScaleDenom==='function'?pageScaleDenom(state.currentPage):null;
   if(!paper||!den||!state.width||!state.height)return null;
   return ((paper.w/state.width)+(paper.h/state.height))*den/2000;
 }catch{return null;}
}
function beginPlacement(){
 if(!session||!selectedCandidates().length){errorText('配置する候補を1つ以上選択してください。');return;}
 if(currentView!=='editor'||activeDrawingId!==session.drawingId||state.currentPage!==session.page){errorText('図面が切り替わっています。自動描写をやり直してください。');return;}
 const list=selectedCandidates();
 const bounds=mergedBox(list),r=$('stageWrap').getBoundingClientRect();
 const center=point({clientX:r.left+r.width/2,clientY:r.top+r.height/2});
 const drawingUnit=drawingMetresPerPixel(),photometric=photoRatio();
 const factor=drawingUnit&&photometric?photometric/drawingUnit:
   Math.min(state.width*.32/Math.max(1,bounds.w),state.height*.32/Math.max(1,bounds.h));
 const attach=!!editor?.attach.checked;
 modal.remove();modal=null;editor=null;
 const overlay=element('div','sl-trace-placement-hit');$('stageWrap').append(overlay);
 const preview=makeEl('svg',{width:state.width,height:state.height,viewBox:'0 0 '+state.width+' '+state.height});
 preview.style.cssText='position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:50';$('stage').append(preview);
 const panel=element('div','sl-trace-placepanel');
 panel.append(element('strong',null,'図面への仮配置'));
 const info=element('div','sl-trace-place-msg','線を指でドラッグして移動。向き・倍率を調整して「確定」するまで、既存の図面は変更しません。');
 panel.append(info);
 const controls=group();
 placing={overlay,svg:preview,panel,bounds,list,baseFactor:factor,factor,angle:0,x:bound(center.x,0,state.width),y:bound(center.y,0,state.height),attach,drawingId:session.drawingId,page:session.page,drag:null};
 controls.append(newButton('↶15°',()=>{placing.angle-=Math.PI/12;drawPlacement();}),
 newButton('15°↷',()=>{placing.angle+=Math.PI/12;drawPlacement();}),
 newButton('縮小',()=>{placing.factor*=.9;drawPlacement();}),
 newButton('拡大',()=>{placing.factor*=1.1;drawPlacement();}),
 newButton('倍率を戻す',()=>{placing.factor=placing.baseFactor;drawPlacement();}));
 const footer=group();footer.append(newButton('← 写真編集へ',()=>dismissPlacement(true)),newButton('確定して変状登録',commitPlacement,'sl-trace-primary'));
 const hint=element('div','sl-trace-place-msg');
 hint.textContent=drawingUnit&&photometric?'図面の縮尺と基準寸法を使った倍率です。撮影角度による歪みは必要に応じて補正してください。':'図面の縮尺・基準寸法が揃っていないため、表示中央への仮配置です。位置と倍率を確認してください。';
 panel.append(controls,hint,footer);document.body.append(panel);
 const overlayPoint=e=>({x:e.clientX,y:e.clientY});
 overlay.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();placing.drag={id:e.pointerId,at:overlayPoint(e),x:placing.x,y:placing.y};overlay.setPointerCapture(e.pointerId);});
 overlay.addEventListener('pointermove',e=>{if(!placing?.drag||placing.drag.id!==e.pointerId)return;e.preventDefault();e.stopPropagation();placing.x=placing.drag.x+(e.clientX-placing.drag.at.x)/Math.max(scale,.001);placing.y=placing.drag.y+(e.clientY-placing.drag.at.y)/Math.max(scale,.001);drawPlacement();});
 for(const name of ['pointerup','pointercancel','lostpointercapture'])overlay.addEventListener(name,e=>{e.stopPropagation();if(placing?.drag?.id===e.pointerId)placing.drag=null;});
 drawPlacement();
}
function placedPoints(c){
 const b=placing.bounds,co=Math.cos(placing.angle),si=Math.sin(placing.angle);
 return c.points.map(p=>{
   const x=(p.x-b.cx)*placing.factor,y=(p.y-b.cy)*placing.factor;
   return {x:placing.x+co*x-si*y,y:placing.y+si*x+co*y};
 });
}
function drawPlacement(){
 if(!placing)return;placing.svg.replaceChildren();
 for(const c of placing.list){
   const points=placedPoints(c);if(points.length<2)continue;
   const path=makeEl(c.kind==='area'?'polygon':'polyline',{points:points.map(p=>p.x.toFixed(2)+','+p.y.toFixed(2)).join(' '),
     fill:c.kind==='area'?'rgba(245,158,11,.18)':'none',stroke:c.kind==='area'?'#f59e0b':'#059669',
     'stroke-width':Math.max(1.5,2/Math.max(scale,.001)),'stroke-linejoin':'round','stroke-linecap':'round'});
   placing.svg.append(path);
 }
}
async function commitPlacement(){
 if(!placing||!session||!placing.list.length)return;
 const ctx={...placing,sourcePhoto:session.file};
 if(currentView!=='editor'||activeDrawingId!==ctx.drawingId||state.currentPage!==ctx.page){alert('図面が切り替わりました。登録せずに中止します。');dismissPlacement(true);return;}
 const proposals=ctx.list.map(c=>({candidate:c,points:placedPoints(c)}));
 if(proposals.some(p=>p.points.length<2||p.points.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)||q.x<0||q.y<0||q.x>state.width||q.y>state.height))){
   alert('図面の外にはみ出している線があります。移動または縮小してから確定してください。');return;
 }
 try{root.SentlogRecords?.assertSafe?.();}catch(e){alert('端末の保存状態を確認してください：'+e.message);return;}
 const btn=ctx.panel.querySelector('.sl-trace-primary');if(btn)btn.disabled=true;
 for(const control of ctx.panel.querySelectorAll('button'))control.disabled=true;
 ctx.panel.querySelector('.sl-trace-place-msg').textContent='変状・撮影写真を保存中です。完了まで図面を切り替えないでください。';
 let created=[],persisted=false;
 try{
   pushHistory(ctx.page);
   const ratio=photoRatio(),member=$('member')?.value||'',memo=$('memo')?.value||'';
   for(const p of proposals){
     const c=p.candidate,shape={kind:c.kind==='area'?'freehand-area':'freehand-line',points:p.points,id:uidSafe(),page:ctx.page,
       type:c.type,no:'',member,memo,strokeWidth:Number($('lineWidth')?.value)||1.2,photos:[]};
     if(c.kind==='line'){
       const measured=validM(c.manualM)||(ratio?Core.pathLength(c.points)*ratio:null);
       if(measured&&measured>=.001&&measured<=10000)shape.lineLengthM=Math.round(measured*1000)/1000;
     }
     assignNumbers(shape);state.shapes.push(shape);created.push(shape);
   }
   persist();persisted=true;
   selected=created.at(-1).id;selectShape(selected);
   if(ctx.attach&&ctx.sourcePhoto){
     try{
       const photo=await preparePhoto(ctx.sourcePhoto);
       // One camera photo can mark many defects. Keep a single physical blob
       // per drawing and reference its ID from each ordinary damage shape.
       // Duplicating the blob for every detected line would exhaust offline
       // storage and cloud traffic on crack-dense field photos.
       const photoId=uidSafe();
       await savePhotoBlob(photoId,photo,ctx.drawingId);
       const meta={id:photoId,name:ctx.sourcePhoto.name||'自動描写の撮影写真',createdAt:Date.now(),type:photo.type||ctx.sourcePhoto.type||'image/jpeg',size:photo.size||ctx.sourcePhoto.size||0};
       for(const shape of created)shape.photos.push({...meta});
       persist();
       if(selected===created.at(-1)?.id)await renderSelectedPhotos();
     }catch(photoError){
       console.warn('Auto trace photo attachment',photoError);
       alert('変状は登録しましたが、一部の撮影写真の保存に失敗しました。端末の保存状態と写真一覧を確認してください。');
     }
   }
   dismissPlacement(false);
 }catch(e){
   if(!persisted&&created.length){state.shapes=state.shapes.filter(s=>!created.some(v=>v.id===s.id));rebuildNumberingState();render();}
   console.error('auto trace commit',e);alert('変状の保存に失敗しました：'+(e.message||e));
   for(const control of ctx.panel.querySelectorAll('button'))control.disabled=false;
   ctx.panel.querySelector('.sl-trace-place-msg').textContent='保存できませんでした。登録状態を確認してから再操作してください。';
   if(btn)btn.disabled=false;return;
 }
 // Changes use the same shape JSON, photo storage, history and sync as manual records.
}
function setup(){
 const bar=document.querySelector('#editorView .toolbar')||document.querySelector('.toolbar');
 if(!bar||button)return;installStyle();
 button=newButton('📷 自動描写',()=>{
   if(currentView!=='editor'||!activeDrawingId||!state.sourceType){alert('図面を開いてから使用してください。');return;}
   photoInput.click();
 },'sl-trace-open');button.id='slAutoTraceButton';button.title='白チョークを撮影して線・範囲を自動描写';
 const historyGroup=bar.querySelector(':scope > .sl-tool-history');
 const undo=$('undoBtn');
 // The icon toolbar nests Undo inside its history group; never use a non-child
 // as the insertBefore reference (this silently prevents camera UI mounting).
 const before=historyGroup||(undo?.parentNode===bar?undo:null);
 bar.insertBefore(button,before);
 photoInput=element('input');photoInput.type='file';photoInput.accept='image/*';photoInput.setAttribute('capture','environment');photoInput.hidden=true;photoInput.id='slAutoTraceCamera';
 photoInput.onchange=e=>{const file=e.target.files?.[0];photoInput.value='';if(file)openFile(file);};document.body.append(photoInput);
 root.SentlogAutoTrace={version:1,open:()=>photoInput.click(),core:Core};
}
Promise.resolve(root.sentlogAppReady).then(setup).catch(e=>console.warn('Auto trace setup postponed',e));
})(typeof window==='object'?window:globalThis);

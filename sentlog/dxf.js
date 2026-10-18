/* Sentlog v1.78: original DXF + editable inspection records, offline assets. */
(function(root){'use strict';
if(!root.document||root.SentlogDxf)return;
const C=root.SentlogDxfCore;if(!C)throw Error('DXF基本機能を読み込めません。');
const $=id=>document.getElementById(id),stage=$('stage'),wrap=$('stageWrap');
let active=null,busy=false,panel=null,serial=0,raf=0,enginePromise=null,pendingApproval=null;const prepared=new WeakMap();
const element=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
const isDxf=(f,fallback='')=>/\.dxf$/i.test(f?.name||fallback)||/^(application|image)\/(x-)?dxf$/i.test(f?.type||'');
const current=()=>active&&active.id===activeDrawingId&&state.sourceType==='dxf'&&currentView==='editor';
const hash=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
function destroy(v){if(!v)return;try{v.viewer.GetRenderer()?.forceContextLoss();v.viewer.Destroy();}catch{}v.host.remove();v.bytes=null;}
function clear(){serial++;cancelAnimationFrame(raf);raf=0;destroy(active);active=null;stage.style.width='';stage.style.height='';stage.style.overflow='';canvas.style.display='';svg.style.overflow='';svg.removeAttribute('preserveAspectRatio');delete wrap.dataset.dxf;updateUI();}
function loadEngine(){
 if(root.SentlogDxfEngine)return Promise.resolve(root.SentlogDxfEngine);
 if(!enginePromise)enginePromise=new Promise((resolve,reject)=>{const s=element('script');s.src='./vendor/dxf-engine.js?v=178';s.onload=()=>resolve(root.SentlogDxfEngine);s.onerror=()=>{enginePromise=null;s.remove();reject(Error('DXF表示機能を読み込めません。通信できる場所で一度開いてください。'));};document.head.append(s);});return enginePromise;
}
function dialog(title){
 closePanel();panel=element('div');panel.className='sl-dxf-modal';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
 const card=element('div');card.className='sl-dxf-card';const h=element('h2',title);card.append(h);panel.append(card);document.body.append(panel);return card;
}
function closePanel(){panel?.remove();panel=null;const cancel=pendingApproval;pendingApproval=null;cancel?.(null);}
function button(label,fn){const b=element('button',label);b.type='button';b.onclick=fn;return b;}
function unitSelect(units){const label=element('label','図面の1単位');const select=element('select');select.id='dxfUnits';for(const [value,unit] of Object.entries(C.UNITS)){const o=element('option',unit.name);o.value=value;select.append(o);}select.value=C.UNITS[units]?String(units):'4';label.append(select);return {label,select};}
async function approval(v){
 const card=dialog('DXFを取り込む');card.append(element('p','元図は固定し、変状・メモを重ねて記録します。出力時は元のDXFと書き込みをまとめます。'));
 const preview=element('img');preview.alt='DXF取り込みプレビュー';preview.src=v.viewer.GetCanvas().toDataURL('image/png');preview.className='sl-dxf-preview';card.append(preview);
 const {label,select}=unitSelect(v.info.units);card.append(label);
 if(!v.info.mmPerUnit)card.append(element('p','元DXFの単位が未設定または未対応です。実際の単位を選んでください。'));
 card.append(element('p','文字は表示用フォントに置き換わります。元の文字設定はDXF出力に保持します。'));
 for(const warning of v.warnings)card.append(element('p',warning));
 return await new Promise(resolve=>{pendingApproval=resolve;const actions=element('div');actions.className='sl-dxf-actions';actions.append(button('取り込む',()=>{const units=Number(select.value);pendingApproval=null;closePanel();resolve(units);}),button('キャンセル',()=>{closePanel();resolve(null);}));card.append(actions);actions.firstChild.focus();});
}
async function prepareFile(file,ask=true){
 if(prepared.has(file))return prepared.get(file);if(busy)throw Error('読み込みが終わってから操作してください。');
 busy=true;const token=serial;setLoading(true);let v=null;
 try{
  if(file.size>8*1024*1024)throw Error('DXFは8MB以下に分けて取り込んでください。');
  const bytes=new Uint8Array(await file.arrayBuffer()),info=C.inspect(bytes),sourceHash=await hash(bytes),engine=await loadEngine();
  const host=element('div');host.style.cssText='position:fixed;left:-10000px;top:0;width:512px;height:384px;pointer-events:none;';document.body.append(host);
  const viewer=new engine.DxfViewer(host,{canvasWidth:512,canvasHeight:384,clearColor:engine.white(),fileEncoding:info.encoding,preserveDrawingBuffer:true,antialias:true,retainParsedDxf:false,sceneOptions:{suppressPaperSpace:true}});
  v={viewer,host,bytes,info,sourceHash,warnings:[...info.warnings],id:null};if(!viewer.HasRenderer())throw Error('この端末ではDXF表示を開始できません。ブラウザーを更新して開き直してください。');
  viewer.GetRenderer().setPixelRatio(1);viewer.SetSize(512,384);
  viewer.Subscribe('message',e=>{if(e.detail.level==='warn')v.warnings.push('表示の一部を再現できません：'+e.detail.message);});
  const url=URL.createObjectURL(file);let timer;
  try{await Promise.race([viewer.Load({url,fonts:[new URL('./vendor/dxf-font.woff',location.href).href],workerFactory:()=>new Worker(new URL('./vendor/dxf-worker.js?v=178',location.href))}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DXFの表示処理が時間内に完了しませんでした。図面を分割してください。')),45000);})]);}
  finally{clearTimeout(timer);URL.revokeObjectURL(url);}
  if(token!==serial){destroy(v);return null;}
  v.frame=C.makeFrame(viewer.GetBounds());viewer.controls?.dispose();viewer.controls=null;
  let units=info.units;
  if(ask){setLoading(false);units=await approval(v);if(units===null||token!==serial){destroy(v);return null;}}
  else if(state.dxf?.sourceHash===sourceHash)units=state.dxf.units;
  if(!C.UNITS[units])throw Error('DXFの単位が未設定です。図面を取り込み直して単位を選んでください。');
  v.units=units;v.mmPerUnit=C.UNITS[units].mm;prepared.set(file,v);return v;
 }catch(e){destroy(v);throw e;}finally{busy=false;setLoading(false);}
}
function view(v,cx,cy,width,pw,ph){const o=v.viewer.GetOrigin();v.viewer.SetSize(pw,ph);v.viewer.SetView({x:cx-o.x,y:cy-o.y},width);v.viewer.Render();}
function viewport(){
 if(!current())return;const r=wrap.getBoundingClientRect(),f=state.dxf.frame;if(r.width<1||r.height<1||!(scale>0))return;
 stage.style.transform='none';stage.style.width=r.width+'px';stage.style.height=r.height+'px';stage.style.overflow='hidden';
 svg.setAttribute('width',r.width);svg.setAttribute('height',r.height);svg.setAttribute('viewBox',`${-tx/scale} ${-ty/scale} ${r.width/scale} ${r.height/scale}`);svg.setAttribute('preserveAspectRatio','none');svg.style.overflow='hidden';
 canvas.style.display='none';active.host.style.cssText='position:absolute;left:0;top:0;pointer-events:none;width:'+r.width+'px;height:'+r.height+'px;';
 const d=Math.min(2,devicePixelRatio||1,Math.sqrt(1500000/(r.width*r.height))),pw=Math.max(1,Math.round(r.width*d)),ph=Math.max(1,Math.round(r.height*d));
 const cx=f.xMin+((r.width/2-tx)/scale)*f.unitsPerPixel,cy=f.yMax-((r.height/2-ty)/scale)*f.unitsPerPixel;
 view(active,cx,cy,r.width/scale*f.unitsPerPixel,pw,ph);active.viewer.GetCanvas().style.width=r.width+'px';active.viewer.GetCanvas().style.height=r.height+'px';
 wrap.dataset.dxf='ready';wrap.dataset.dxfPixels=String(pw*ph);
}
function schedule(){if(!current()||raf)return;raf=requestAnimationFrame(()=>{raf=0;try{viewport();}catch(e){showError('DXFの表示を更新できません。図面を開き直してください。');}});}
async function openDxf(file,save){
 const id=activeDrawingId;let v=prepared.get(file)||await prepareFile(file,false);if(!v||id!==activeDrawingId){destroy(v);return;}
 prepared.delete(file);setLoading(true);
 try{
  const old=state.dxf;clear();v.id=id;
  const frame=old?.sourceHash===v.sourceHash&&old.frame?.unitsPerPixel>0?old.frame:v.frame;
  if(save)await saveBackgroundFile(file,id);
  state.sourceType='dxf';state.fileName=file.name||state.fileName;state.currentPage=1;state.pageCount=1;state.pageRotations={};pdfDoc=null;
  state.dxf={sourceHash:v.sourceHash,version:v.info.version,units:v.units,mmPerUnit:v.mmPerUnit,frame,warnings:[...new Set(v.warnings)]};
  setupStage(frame.width,frame.height);const factor=Math.min(1,Math.sqrt(2200000/(frame.width*frame.height))),w=Math.max(1,Math.round(frame.width*factor)),h=Math.max(1,Math.round(frame.height*factor));
  view(v,frame.xMin+frame.width*frame.unitsPerPixel/2,frame.yMax-frame.height*frame.unitsPerPixel/2,frame.width*frame.unitsPerPixel,w,h);
  canvas.width=w;canvas.height=h;ctx.fillStyle='white';ctx.fillRect(0,0,w,h);ctx.drawImage(v.viewer.GetCanvas(),0,0,w,h);
  active=v;stage.insertBefore(v.host,svg);empty.style.display='none';$('fileName').textContent=state.fileName;updatePageUI();fit();viewport();render();persist();updateUI();
 }catch(e){if(active===v)active=null;destroy(v);throw e;}finally{setLoading(false);}
}
if(empty.querySelector('b'))empty.querySelector('b').textContent='PDF・画像・DXFを読み込んでください';
const previousOpen=openFile;
openFile=async function(file,save=true){
 if(isDxf(file,state.fileName)){try{return await openDxf(file,save);}catch(e){console.error(e);showError('DXFを開けませんでした：'+e.message);empty.style.display='grid';return false;}}
 clear();delete state.dxf;return previousOpen.apply(this,arguments);
};
const previousCreate=createDrawingFromFile;
createDrawingFromFile=async function(file){
 if(!isDxf(file))return previousCreate.apply(this,arguments);
 try{const v=await prepareFile(file,true);if(!v)return;const before=activeDrawingId;await previousCreate.apply(this,arguments);if(activeDrawingId===before&&prepared.has(file)){prepared.delete(file);destroy(v);}}
 catch(e){alert('DXFを取り込めませんでした：'+e.message);}
};
const previousReplace=$('fileInput').onchange;
$('fileInput').onchange=async e=>{
 const file=e.target.files[0];if(!file)return;
 if(isDxf(file)){try{if(!await prepareFile(file,true)){e.target.value='';return;}}catch(err){alert('DXFを取り込めませんでした：'+err.message);e.target.value='';return;}}
 delete state.dxf;return previousReplace(e);
};
const previousTransform=applyTransform;applyTransform=function(){const r=previousTransform.apply(this,arguments);if(current())viewport();return r;};
const previousProjects=showProjects;showProjects=function(){clear();closePanel();return previousProjects.apply(this,arguments);};
const previousDrawings=showDrawings;showDrawings=function(){clear();closePanel();return previousDrawings.apply(this,arguments);};
const previousEditor=showEditor;showEditor=function(){if(active&&active.id!==activeDrawingId)clear();return previousEditor.apply(this,arguments);};
const previousDrawing=openDrawing;openDrawing=async function(){clear();return previousDrawing.apply(this,arguments);};
const previousPaper=getPaperMm;getPaperMm=function(){if(state.sourceType==='dxf'&&state.dxf)return {w:state.width*state.dxf.frame.unitsPerPixel*state.dxf.mmPerUnit/100,h:state.height*state.dxf.frame.unitsPerPixel*state.dxf.mmPerUnit/100,source:'DXF実寸'};return previousPaper.apply(this,arguments);};
const previousDenom=pageScaleDenom;pageScaleDenom=function(){return state.sourceType==='dxf'&&state.dxf?100:previousDenom.apply(this,arguments);};
const previousSettings=openPageSettings;openPageSettings=function(){if(state.sourceType==='dxf'){showInfo();return;}return previousSettings.apply(this,arguments);};

function color(value,alpha=1){if(!value||value==='none'||value==='transparent')return null;const m=value.match(/rgba?\(([^)]+)\)/);if(!m)return null;const n=m[1].split(/[ ,/]+/).map(Number),a=(n.length>3?n[3]:1)*alpha;if(a<.01)return null;return {color:(n[0]<<16)|(n[1]<<8)|n[2],opacity:Math.max(0,Math.min(1,a))};}
function capturePrimitives(){
 const output=[],rootMatrix=svg.getScreenCTM().inverse();
 for(const e of svg.querySelectorAll('line,polyline,polygon,rect,circle,ellipse,path,text')){
  if(e.closest('defs')||e.closest('[data-memo-ui]'))continue;const st=getComputedStyle(e);if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity)<.01)continue;
  const matrix=rootMatrix.multiply(e.getScreenCTM()),point=(x,y)=>({x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f}),vector=(x,y)=>({x:matrix.a*x+matrix.c*y,y:matrix.b*x+matrix.d*y});
  const memo=e.closest('[data-memo-id]'),record=memo?state.shapes.find(s=>s.id===memo.dataset.memoId):null;
  const layer=record?.recordKind==='dimension-line'?'dimension':memo?'memo':e.closest('[data-shape-dimension],[data-sentlog-dimension-id]')?'dimension':e.localName==='text'?'label':'damage';
  const stroke=color(st.stroke,Number(st.strokeOpacity)*Number(st.opacity)),fill=color(st.fill,Number(st.fillOpacity)*Number(st.opacity)),num=a=>Number(e.getAttribute(a)||0);
  const base={layer},width=parseFloat(st.strokeWidth)*Math.hypot(matrix.a,matrix.b),dash=st.strokeDasharray==='none'?[]:st.strokeDasharray.split(/[ ,]+/).map(parseFloat).filter(Number.isFinite).map(x=>x*Math.hypot(matrix.a,matrix.b));
  if(e.localName==='text'){
   if(!fill)continue;const nodes=e.querySelectorAll('tspan').length?[...e.querySelectorAll('tspan')]:[e];
   for(const t of nodes){const text=t.textContent;if(!text?.trim())continue;const box=t.getBBox(),m=rootMatrix.multiply(t.getScreenCTM()),fs=parseFloat(getComputedStyle(t).fontSize),at={x:m.a*box.x+m.c*box.y+m.e,y:m.b*box.x+m.d*box.y+m.f};output.push({...base,...fill,type:'text',text,at,height:fs*.75*Math.hypot(m.a,m.b),angle:Math.atan2(m.b,m.a)*180/Math.PI});}continue;
  }
  let points=[],closed=false,ellipse=null;
  if(['polyline','polygon'].includes(e.localName)){points=[...e.points].map(p=>point(p.x,p.y));closed=e.localName==='polygon';}
  else if(e.localName==='line')points=[point(num('x1'),num('y1')),point(num('x2'),num('y2'))];
  else if(e.localName==='rect'){const x=num('x'),y=num('y'),w=num('width'),h=num('height');if(!w||!h)continue;points=[point(x,y),point(x+w,y),point(x+w,y+h),point(x,y+h)];closed=true;}
  else if(['circle','ellipse'].includes(e.localName)){const rx=num(e.localName==='circle'?'r':'rx'),ry=num(e.localName==='circle'?'r':'ry');ellipse={center:point(num('cx'),num('cy')),u:vector(rx,0),v:vector(0,ry)};points=Array.from({length:72},(_,i)=>point(num('cx')+rx*Math.cos(i*Math.PI/36),num('cy')+ry*Math.sin(i*Math.PI/36)));closed=true;}
  else if(e.localName==='path'){
   if(!stroke&&!fill)continue;const length=e.getTotalLength();const count=Math.min(4096,Math.max(2,Math.ceil(length/2)));points=Array.from({length:count+1},(_,i)=>{const p=e.getPointAtLength(i*length/count);return point(p.x,p.y);});closed=/[zZ]\s*$/.test(e.getAttribute('d')||'');
  }
  if(points.length<2)continue;
  if(closed&&fill)output.push({...base,...fill,type:'hatch',points});
  const pattern=e.dataset.damagePattern;if(closed&&pattern&&pattern!=='none'&&st.fill.startsWith('url('))output.push({...base,...(stroke||{color:0,opacity:1}),type:'hatch',points,pattern,opacity:(stroke?.opacity||1)*(pattern==='dots'?.55:.5),spacing:['rise','fall','cross'].includes(pattern)?12/Math.SQRT2:pattern==='sparse'?18:12});
  if(stroke)output.push({...base,...stroke,...(ellipse?{type:'ellipse',...ellipse}:{type:'polyline',points,closed,width}),dash});
 }
 return output;
}
function capture(includeMemos){return root.SentlogDrawingMemos.captureForExport(includeMemos,()=>{const old=scale;try{scale=1;applyTransform();render();return capturePrimitives();}finally{scale=old;applyTransform();render();}});}
async function exportDxf(includeMemos=true){
 if(!current()||busy)throw Error('DXFの読み込みが終わってから出力してください。');
 if(drawing||panStart||root.SentlogDrawingMemos.isEditing()&&!panel)throw Error('編集中の操作を確定してから出力してください。');
 const id=activeDrawingId,bytes=active.bytes;if(await hash(bytes)!==state.dxf.sourceHash||id!==activeDrawingId)throw Error('元DXFが変わっています。図面を開き直してください。');
 const primitives=capture(includeMemos),result=C.appendPrimitives(bytes,primitives,state.dxf.frame),blob=new Blob([result.bytes],{type:'application/dxf'});
 const a=element('a');a.href=URL.createObjectURL(blob);a.download=(getDrawingMeta()?.name||'図面').replace(/[\\/:*?"<>|]/g,'_')+'_記録付き.dxf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000);return {...result,blob};
}
function exportDialog(){const card=dialog('DXFを出力');card.append(element('p','元のDXFと、現在のページの変状・文字・寸法を出力します。添付写真の画像は含みません。'));
 const label=element('label'),check=element('input');check.type='checkbox';check.checked=root.SentlogDrawingMemos.visible;label.append(check,document.createTextNode('図面メモを含める'));card.append(label);
 card.append(element('p','追加寸法は線・矢印・文字として編集できます。元図の寸法は元の形式で保持します。'));
 const error=element('p');error.setAttribute('role','alert');const save=button('DXFを保存',async()=>{save.disabled=true;try{await exportDxf(check.checked);closePanel();}catch(e){error.textContent=e.message;}finally{save.disabled=false;}});card.append(error,save,button('閉じる',closePanel));}
function showInfo(){const card=dialog('DXF図面の情報');card.append(element('p','モデル空間／単位 '+(C.UNITS[state.dxf?.units]?.name||'未設定')+'。元の座標を保持しています。'));
 card.append(element('p','元図の文字は表示用フォントで描画します。元DXFの文字設定は出力に保持します。'));
 for(const warning of state.dxf?.warnings||[])card.append(element('p',warning));card.append(button('閉じる',closePanel));}
const exportButton=button('DXF出力',exportDialog);exportButton.id='dxfExportBtn';const infoButton=button('DXF情報',showInfo);infoButton.id='dxfInfoBtn';
$('memoPdfBtn')?.parentElement.append(exportButton,infoButton);
function updateUI(){const enabled=state.sourceType==='dxf';exportButton.hidden=infoButton.hidden=!enabled;infoButton.textContent=state.dxf?.warnings?.length?'DXF情報 ⚠':'DXF情報';}
const previousRender=render;render=function(){const r=previousRender.apply(this,arguments);updateUI();return r;};
for(const id of ['fileInput','drawingAddInput']){const input=$(id);if(input)input.accept=(input.accept||'application/pdf,image/*')+',.dxf,application/dxf';}
const css=element('style');css.textContent='.sl-dxf-modal{position:fixed;inset:0;z-index:10020;background:#0008;display:grid;place-items:center;padding:14px}.sl-dxf-card{background:white;color:#111827;border-radius:14px;padding:20px;width:min(540px,100%);max-height:90dvh;overflow:auto;box-sizing:border-box}.sl-dxf-card h2{font-size:18px;margin:0 0 12px}.sl-dxf-card p{font-size:13px;line-height:1.65}.sl-dxf-card button{min-height:44px;padding:8px 16px;margin:6px 6px 0 0}.sl-dxf-card select{width:100%;min-height:44px}.sl-dxf-preview{width:100%;max-height:260px;object-fit:contain;background:white;border:1px solid #ddd}.sl-dxf-actions{display:flex;justify-content:flex-end}#sentlogDrawingToolbar #dxfExportBtn,#sentlogDrawingToolbar #dxfInfoBtn{width:auto!important;min-width:0;flex:0 0 auto;padding:6px 9px;font-size:12px}';document.head.append(css);
new ResizeObserver(schedule).observe(wrap);window.addEventListener('pageshow',schedule);document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
root.SentlogDxf={version:'v1.78',prepareFile,exportDxf,capturePrimitives,isDxf,isEditing:()=>busy||!!panel,get frame(){return state.dxf?.frame;}};updateUI();
})(window);

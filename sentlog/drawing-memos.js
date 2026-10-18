/* Sentlog v1.77: drawing notes, separate from damage records.
 * Notes and existing independent dimensions share the drawing snapshot, history,
 * backup and cloud transport. Gesture previews never mutate saved records. */
(function(root){
'use strict';
const TYPES=['line','freehand','rect','ellipse','text','dimension'];
const clone=v=>JSON.parse(JSON.stringify(v));
const finite=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
function isDimension(s){return !!s&&s.recordKind==='dimension-line'&&s.kind==='dimension';}
function isMemo(s){return !!s&&(s.recordKind==='drawing-memo'||isDimension(s));}
function memoType(s){return isDimension(s)?'dimension':s.memoType;}
function parseMetres(value){
  const m=String(value??'').trim().replace(/[０-９．]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xfee0)).match(/^([0-9]+(?:\.[0-9]+)?)\s*(mm|㎜|m|ｍ)?$/i);
  if(!m)return null;const n=Number(m[1])/(m[2]==='mm'||m[2]==='㎜'?1000:1);
  return n>=.001&&n<=10000?n:null;
}
function manualMetres(s){return parseMetres(s.manualText);}
function textBox(s){
  const fs=Math.max(1,finite(s.fontSize,14)*finite(s.unit,1)),lines=String(s.text||'').split('\n');
  const width=Math.max(fs,...lines.map(t=>[...t].reduce((n,c)=>n+(/[\x00-\x7f]/.test(c)?.62:1)*fs,0)))+fs*.4;
  return {width,height:Math.max(1,lines.length)*fs*1.35,fs,lines};
}
function bounds(s){
  let pts=s.points||[];
  if(memoType(s)==='text'){
    const p=pts[0]||{x:0,y:0},b=textBox(s),a=finite(s.rotation)*Math.PI/180;
    pts=[[0,0],[b.width,0],[b.width,b.height],[0,b.height]].map(([x,y])=>({x:p.x+x*Math.cos(a)-y*Math.sin(a),y:p.y+x*Math.sin(a)+y*Math.cos(a)}));
  }
  if(!pts.length)return {x:0,y:0,w:0,h:0};
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
  return {x,y,w:Math.max(...xs)-x,h:Math.max(...ys)-y};
}
function translated(s,dx,dy){const n=clone(s);n.points=n.points.map(p=>({...p,x:p.x+dx,y:p.y+dy}));return n;}
function resized(s,p){
  const n=clone(s),b=bounds(s),type=memoType(s);
  if(type==='text'){
    const ratio=Math.max(.2,Math.min(8,Math.hypot(p.x-b.x,p.y-b.y)/Math.max(1,Math.hypot(b.w,b.h))));
    n.fontSize=Math.max(6,Math.min(144,finite(s.fontSize,14)*ratio));return n;
  }
  const sx=b.w>.0001?(p.x-b.x)/b.w:1,sy=b.h>.0001?(p.y-b.y)/b.h:1;
  n.points=n.points.map(q=>({x:b.x+(q.x-b.x)*sx,y:b.y+(q.y-b.y)*sy}));return n;
}
function simplify(points,tolerance=1){
  // Iterative Ramer-Douglas-Peucker: bounded stack, no recursion on long strokes.
  if(points.length<=2)return points.map(p=>({...p}));
  const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]],t2=tolerance*tolerance;
  while(stack.length){
    const [a,b]=stack.pop(),p=points[a],q=points[b],dx=q.x-p.x,dy=q.y-p.y,d2=dx*dx+dy*dy;
    let far=-1,max=t2;
    for(let i=a+1;i<b;i++){const r=points[i],t=d2?Math.max(0,Math.min(1,((r.x-p.x)*dx+(r.y-p.y)*dy)/d2)):0;
      const dist=(r.x-p.x-t*dx)**2+(r.y-p.y-t*dy)**2;if(dist>max){max=dist;far=i;}}
    if(far>=0){keep.add(far);stack.push([a,far],[far,b]);}
  }
  return [...keep].sort((a,b)=>a-b).map(i=>({...points[i]}));
}
function validGeometry(s){
  const p=s.points;if(!Array.isArray(p)||!p.length||p.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)))return false;
  const b=bounds(s),type=memoType(s);
  return type==='text'?!!String(s.text||'').trim():type==='rect'||type==='ellipse'?b.w>0&&b.h>0:p.length>=2&&Math.hypot(b.w,b.h)>0;
}
function jpegPdf(jpeg,width,height,paperW,paperH){
  const enc=new TextEncoder(),chunks=[],offsets=[0];let length=0;
  const append=v=>{const bytes=typeof v==='string'?enc.encode(v):v;chunks.push(bytes);length+=bytes.length;};
  const object=(id,body)=>{offsets[id]=length;append(id+' 0 obj\n');append(body);append('\nendobj\n');};
  const w=Number(paperW).toFixed(3),h=Number(paperH).toFixed(3);
  append('%PDF-1.4\n%Sentlog\n');object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4]=length;append(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);append(jpeg);append('\nendstream\nendobj\n');
  const commands=`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
  object(5,`<< /Length ${enc.encode(commands).length} >>\nstream\n${commands}endstream`);
  const start=length;append('xref\n0 6\n0000000000 65535 f \n');
  for(let i=1;i<=5;i++)append(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  const out=new Uint8Array(length);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}return out;
}
const pure={TYPES,isMemo,isDimension,memoType,parseMetres,manualMetres,bounds,textBox,translated,resized,simplify,validGeometry,jpegPdf};
if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
if(!root.document||root.SentlogDrawingMemos)return;
if(typeof render!=='function'||!root.SentlogDimensionLines)throw Error('図面メモの読み込み順序が正しくありません。');
const wrap=$('stageWrap'),svg=$('svg'),bar=$('sentlogDrawingToolbar');if(!wrap||!svg||!bar)return;
const z=()=>Math.max(.001,finite(scale,1));
const D=root.SentlogDimensionLines;
let mode='damage',visible=true,chosen=null,gesture=null,panel=null,exporting=false,scope='';
let defaults={color:'#1d4ed8',strokeWidth:1.5,dashed:false,arrow:false,fontSize:14,white:true,rotation:0};
const names={line:'直線',freehand:'手描き',rect:'四角',ellipse:'丸',text:'文字',dimension:'寸法'};
const paths={line:'M4 20L20 4',freehand:'M3 17C5 4 9 4 11 12S17 21 21 6',rect:'M4 5H20V19H4Z',ellipse:'M21 12A9 7 0 1 1 3 12A9 7 0 1 1 21 12',text:'M4 5H20M12 5V20M8 20H16',dimension:'M4 5V19M20 5V19M4 12H20M7 9L4 12L7 15M17 9L20 12L17 15'};
const el=(tag,attrs={},text)=>{const e=document.createElement(tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!=null)e.textContent=text;return e;};
const se=(tag,attrs={})=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
const source=id=>state.shapes.find(s=>s.id===id&&isMemo(s)&&(s.page||1)===state.currentPage);
const current=()=>source(chosen);
const pageScope=()=>activeDrawingId+':'+state.currentPage;
function button(text,label,fn){const b=el('button',{type:'button','aria-label':label},text);b.onclick=fn;return b;}
function closePanel(){if(panel){panel.remove();panel=null;}}
function clearTransient(){gesture=null;chosen=null;closePanel();}
function isCalibrated(){return D.calibrated(state.currentPage);}
function dimensionText(s){
  if(String(s.manualText||'').trim())return String(s.manualText).trim();
  return isCalibrated()?D.formatMetresFromMm(lineLengthMm(s.points,s.page||1)):'寸法値';
}
function commitChange(next){
  if(!validGeometry(next))return false;
  const index=state.shapes.findIndex(s=>s.id===next.id);pushHistory();
  if(index<0)state.shapes.push(next);else state.shapes[index]=next;
  selected=null;chosen=next.id;persist();render();return true;
}
function removeCurrent(){const s=current();if(!s)return;pushHistory();state.shapes=state.shapes.filter(x=>x.id!==s.id);clearTransient();persist();render();}
function duplicateCurrent(){const s=current();if(!s)return;const n=translated(s,16/z(),16/z());n.id=uid();closePanel();commitChange(n);}
function newMemo(type,points){
  return {id:uid(),page:state.currentPage,kind:type==='dimension'?'dimension':'memo',recordKind:type==='dimension'?'dimension-line':'drawing-memo',memoType:type,points:clone(points),...defaults,unit:1/z(),text:'',manualText:''};
}
function activate(next){
  cancelPointerDraft();closePanel();chosen=null;selected=null;drawing=null;panStart=null;
  document.querySelectorAll('[data-tool],[data-field-record-tool],[data-memo-tool]').forEach(b=>b.classList.remove('active'));
  tool=next;render();
}
function setMode(next){
  mode=next;activate('pan');$('inspector')?.classList.remove('open');updateUI();
}
const switchRow=el('div',{class:'sl-memo-switch-row'}),switchGroup=el('div',{class:'sl-memo-switch',role:'group','aria-label':'記録モード'});
const damageButton=button('変状記録','変状記録に切り替え',()=>setMode('damage'));
const memoButton=button('図面メモ','図面メモに切り替え',()=>setMode('memo'));
damageButton.id='damageModeBtn';memoButton.id='memoModeBtn';switchGroup.append(damageButton,memoButton);
const visibilityButton=button('メモ表示','図面メモの表示を切り替え',()=>{visible=!visible;clearTransient();render();});visibilityButton.id='memoVisibilityBtn';
const editButton=button('書式','図面メモの書式と編集',()=>openEditor(current()));editButton.id='memoEditBtn';
const pdfButton=button('PDF','このページをPDF保存',()=>openExport());pdfButton.id='memoPdfBtn';
switchRow.append(switchGroup,visibilityButton,editButton,pdfButton);bar.prepend(switchRow);
const memoTools=el('div',{class:'sl-memo-tools',role:'group','aria-label':'図面メモの道具'}),memoButtons=[];
for(const type of TYPES){
  const b=button('',names[type]+(type==='freehand'?'（フリーハンド線）':''),()=>{
    visible=true;activate(tool==='memo-'+type?'pan':'memo-'+type);
  });b.dataset.memoTool=type;b.className='sl-memo-tool';
  const icon=se('svg',{viewBox:'0 0 24 24',width:22,height:22,'aria-hidden':'true'});icon.append(se('path',{d:paths[type],fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round'}));
  b.append(icon,el('span',{},names[type]));memoTools.append(b);memoButtons.push(b);
}
switchRow.after(memoTools);
const damageGroup=bar.querySelector('.sl-tool-group:not(.sl-tool-history)');
const legacyDimension=bar.querySelector('[data-tool="dimension"]');if(legacyDimension)legacyDimension.hidden=true;
function updateUI(){
  bar.classList.toggle('sl-memo-mode',mode==='memo');bar.dataset.recordMode=mode;
  document.body.classList.toggle('sl-memo-active',mode==='memo'&&currentView==='editor');
  damageButton.setAttribute('aria-pressed',String(mode==='damage'));memoButton.setAttribute('aria-pressed',String(mode==='memo'));
  memoTools.hidden=mode!=='memo';if(damageGroup)damageGroup.hidden=mode==='memo';
  for(const b of [...bar.children])if(b.dataset?.fieldRecordTool||b.id==='fieldRecordBtn')b.hidden=mode==='memo';
  visibilityButton.textContent=visible?'メモ表示':'メモ非表示';visibilityButton.setAttribute('aria-pressed',String(visible));
  editButton.hidden=mode!=='memo';editButton.textContent=current()?'編集':'書式';
  for(const b of memoButtons){const active=tool==='memo-'+b.dataset.memoTool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  const status=$('sentlogToolMode');if(status&&mode==='memo')status.textContent='メモ：'+(names[tool.replace('memo-','')]||'選択・移動');
}
const style=el('style');style.textContent=`
#sentlogDrawingToolbar [hidden]{display:none!important}
.sl-memo-switch-row{display:flex;align-items:center;gap:4px;width:100%;min-width:0}
.sl-memo-switch{display:flex;gap:0;margin-right:auto;border:1px solid #94a3b8;border-radius:8px;overflow:hidden;flex-shrink:0}
#sentlogDrawingToolbar .sl-memo-switch-row button{flex:0 0 auto;width:auto;min-width:0;height:34px;min-height:34px;padding:4px 8px;font-size:11px;white-space:nowrap;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;touch-action:manipulation}
#sentlogDrawingToolbar .sl-memo-switch button{border:0;border-radius:0;font-weight:700}
#sentlogDrawingToolbar .sl-memo-switch button[aria-pressed=true]{background:#1d4ed8;color:white}
.sl-memo-tools{display:flex;gap:3px;flex:0 0 auto}
#sentlogDrawingToolbar .sl-memo-tool{flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:5px;width:auto;height:44px;min-height:44px;min-width:40px;padding:4px 9px;background:#fff;color:#334155;border:1px solid #cbd5e1;border-radius:7px;touch-action:manipulation}
.sl-memo-tool svg,.sl-memo-tool span{pointer-events:none}.sl-memo-tool span{font-size:11px}
#sentlogDrawingToolbar .sl-memo-tool.active{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
.sl-memo-active #inspector{display:none!important}
.sentlog-phone .sl-memo-active .workspace{padding-bottom:var(--sl-safe-bottom,0px)}
@media(min-width:901px){.sl-memo-active #editorView{grid-template-columns:240px minmax(0,1fr)}}
.sl-memo-panel{position:fixed;z-index:1250;top:50%;left:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:330px;max-width:calc(100vw - 20px);max-height:80dvh;overflow:auto;overscroll-behavior:contain;background:white;color:#172033;padding:14px;border:1px solid #94a3b8;border-radius:12px;box-shadow:0 10px 45px #0005;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.sl-memo-panel h2{font-size:16px;margin:0 0 10px}.sl-memo-panel p{font-size:11px;line-height:1.5;color:#64748b;margin:8px 0}
.sl-memo-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px}.sl-memo-panel label{font-size:12px;display:block}
.sl-memo-panel input,.sl-memo-panel select,.sl-memo-panel textarea{width:100%;height:38px;box-sizing:border-box;font-size:16px;margin-top:4px;padding:5px;border:1px solid #94a3b8;border-radius:6px;background:#fff;color:#172033}
.sl-memo-panel input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:6px}.sl-memo-panel textarea{height:84px;resize:vertical}
.sl-memo-wide{grid-column:1/-1}.sl-memo-actions{display:flex;gap:7px;margin-top:12px}.sl-memo-actions button{flex:1;min-height:40px;padding:7px;background:white;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;color:#172033}.sl-memo-actions .sl-memo-save{background:#1d4ed8;color:white;border-color:#1d4ed8}.sl-memo-actions .sl-memo-delete{color:#b91c1c}
.sl-memo-error{color:#b91c1c;font-size:12px;margin-top:6px;min-height:16px}
@media(max-width:600px){#sentlogDrawingToolbar.sl-memo-mode{gap:4px}#sentlogDrawingToolbar.sl-memo-mode .sl-tool-history{gap:3px}#sentlogDrawingToolbar.sl-memo-mode .sl-tool-history .sl-tool-button{width:36px;min-width:36px;padding:0}#sentlogDrawingToolbar.sl-memo-mode .sl-tool-history .sl-tool-label{display:none}#sentlogDrawingToolbar .sl-memo-tool{flex-direction:column;gap:1px;padding:2px;width:40px}.sl-memo-tool span{font-size:9px}#sentlogDrawingToolbar .sl-memo-switch-row button{padding:4px 6px;font-size:10px}}
`;document.head.append(style);
function panelShell(title){
  closePanel();const form=el('form',{class:'sl-memo-panel',role:'dialog','aria-label':title});form.append(el('h2',{},title));
  form.addEventListener('pointerdown',e=>e.stopPropagation());form.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closePanel();}});
  panel=form;document.body.append(form);return form;
}
function openEditor(item=null,fresh=false){
  if(exporting)return;
  const draft=item?clone(item):{...defaults},type=item?memoType(item):tool.replace('memo-','');
  const id=item?.id,at=pageScope(),form=panelShell(item?names[type]+'を編集':'メモの書式');
  const fields=el('div',{class:'sl-memo-fields'}),controls={};
  function field(key,label,tag='input',attrs={},wide=false){const l=el('label',wide?{class:'sl-memo-wide'}:{},label),input=el(tag,attrs);l.append(input);fields.append(l);controls[key]=input;return input;}
  const color=field('color','色','input',{type:'color'});color.value=draft.color||'#111827';
  const width=field('strokeWidth','線の太さ','select');for(const [v,t] of [[.8,'極細'],[1.5,'細'],[2.5,'標準'],[4,'太']])width.append(el('option',{value:v},t));width.value=String(draft.strokeWidth||1.5);
  const dash=field('dashed','線種','select');dash.append(el('option',{value:'false'},'実線'),el('option',{value:'true'},'破線'));dash.value=String(!!draft.dashed);
  const arrow=field('arrow','直線の終点','select');arrow.append(el('option',{value:'false'},'なし'),el('option',{value:'true'},'矢印'));arrow.value=String(!!draft.arrow);
  if(type==='text'||!item){
    const fs=field('fontSize','文字サイズ','input',{type:'number',min:6,max:144,step:1});fs.value=String(Math.round(draft.fontSize||14));
    const rotation=field('rotation','文字の角度（°）','input',{type:'number',min:-360,max:360,step:5});rotation.value=String(draft.rotation||0);
    const white=field('white','文字の白背景','select');white.append(el('option',{value:'true'},'あり'),el('option',{value:'false'},'なし'));white.value=String(draft.white!==false);
  }
  if(type==='text'&&item){const t=field('text','文字（改行できます）','textarea',{maxlength:2000},true);t.value=draft.text||'';}
  if(type==='dimension'&&item){
    const input=field('dimension','記録寸法（m）','input',{type:'text',inputmode:'decimal',placeholder:'例：1.200 m'},true);input.value=draft.manualText||(isCalibrated()?D.formatMetresFromMm(lineLengthMm(draft.points,draft.page)):'');
    form.append(el('p',{},isCalibrated()?'入力した寸法を優先します。数値を変えると終点が移動します。空欄で自動寸法へ戻ります。':'縮尺未設定：入力値を記録します。線の長さは変えません。'));
  }
  form.append(fields);
  if(item)form.append(el('p',{},'線や枠をドラッグして移動。青い丸で大きさ・端点を変更できます。'));
  const error=el('div',{class:'sl-memo-error',role:'alert'});form.append(error);
  const actions=el('div',{class:'sl-memo-actions'}),save=el('button',{type:'submit',class:'sl-memo-save'},'確定');
  actions.append(save,button('閉じる','編集を閉じる',closePanel));form.append(actions);
  if(item&&!fresh){const more=el('div',{class:'sl-memo-actions'}),del=button('削除','選択したメモを削除',removeCurrent);del.className='sl-memo-delete';more.append(button('複製','選択したメモを複製',duplicateCurrent),del);form.append(more);}
  form.onsubmit=e=>{
    e.preventDefault();if(at!==pageScope()||item&&!fresh&&!source(id)){closePanel();return;}
    const next=item?clone(source(id)||draft):{...defaults};
    next.color=controls.color.value;next.strokeWidth=Number(controls.strokeWidth.value)||1.5;next.dashed=controls.dashed.value==='true';next.arrow=controls.arrow.value==='true';
    if(controls.fontSize){next.fontSize=Math.max(6,Math.min(144,Number(controls.fontSize.value)||14));next.rotation=finite(controls.rotation.value);next.white=controls.white.value==='true';}
    if(controls.text){next.text=controls.text.value.trim();if(!next.text){error.textContent='文字を入力してください。';return;}}
    if(controls.dimension){
      next.manualText=controls.dimension.value.trim();const metres=parseMetres(next.manualText);
      if(next.manualText&&metres==null){error.textContent='0.001〜10000 mの寸法を入力してください。';return;}
      if(metres!=null){next.manualText=metres.toFixed(3)+' m';if(isCalibrated()){
        const result=D.resizedEnd(next.points[0],next.points[1],lineLengthMm(next.points,next.page),metres,{width:state.width,height:state.height});
        if(result.error){error.textContent='指定寸法では図面の外に出ます。始点を移動してから入力してください。';return;}next.points[1]=result.end;
      }}
    }
    if(item){if(!commitChange(next)){error.textContent='描画の大きさを確認してください。';return;}}
    else {for(const key of Object.keys(defaults))if(next[key]!=null)defaults[key]=next[key];}
    closePanel();render();
  };
  if(fresh&&controls.text){controls.text.focus();}
}
function drawOne(s,target=svg,interactive=true,preview=false){
  if(!validGeometry(s)&&!(isDimension(s)&&s.points?.length===2))return;
  const type=memoType(s),unit=Math.max(.001,finite(s.unit,1/z())),color=s.color||'#111827',stroke=Math.max(.4,finite(s.strokeWidth,1))*unit;
  const group=se('g',{'data-memo-id':s.id||'preview'});target.append(group);
  const attrs={stroke:color,'stroke-width':stroke,fill:'none','stroke-linejoin':'round','stroke-linecap':'round','pointer-events':'none'};
  if(s.dashed)attrs['stroke-dasharray']=`${7*unit} ${5*unit}`;
  if(preview)group.setAttribute('opacity','.72');
  let hit=null;
  const pts=s.points;
  if(type==='line'||type==='freehand'){
    const p=pts.map(p=>p.x+','+p.y).join(' ');group.append(se('polyline',{...attrs,points:p}));
    hit=se('polyline',{points:p,fill:'none',stroke:'transparent','stroke-width':Math.max(22/z(),stroke),'pointer-events':'stroke'});
    if(s.arrow&&type==='line'){
      const a=pts[pts.length-2],b=pts[pts.length-1],q=D.dimensionBasis(a,b);
      if(q){const l=Math.min(10*unit,q.len*.4),w=l*.45;group.append(se('polygon',{points:[b,{x:b.x-q.ux*l+q.nx*w,y:b.y-q.uy*l+q.ny*w},{x:b.x-q.ux*l-q.nx*w,y:b.y-q.uy*l-q.ny*w}].map(p=>p.x+','+p.y).join(' '),fill:color,'pointer-events':'none'}));}
    }
  }else if(type==='rect'||type==='ellipse'){
    const b=bounds(s),geometry=type==='rect'?{x:b.x,y:b.y,width:b.w,height:b.h}:{cx:b.x+b.w/2,cy:b.y+b.h/2,rx:b.w/2,ry:b.h/2};
    group.append(se(type==='rect'?'rect':'ellipse',{...attrs,...geometry}));
    hit=se(type==='rect'?'rect':'ellipse',{...geometry,fill:'none',stroke:'transparent','stroke-width':Math.max(22/z(),stroke),'pointer-events':'stroke'});
  }else if(type==='text'){
    const p=pts[0],b=textBox(s),textGroup=se('g',{transform:`translate(${p.x} ${p.y}) rotate(${finite(s.rotation)})`});group.append(textGroup);
    if(s.white!==false)textGroup.append(se('rect',{x:-b.fs*.15,y:0,width:b.width,height:b.height,fill:'#fff','pointer-events':'none'}));
    const t=se('text',{x:0,y:0,'font-size':b.fs,'font-family':'sans-serif',fill:color,'pointer-events':'none'});
    for(const [i,line] of b.lines.entries()){const span=se('tspan',{x:0,y:b.fs*(1+i*1.35)});span.textContent=line||' ';t.append(span);}textGroup.append(t);
    hit=se('rect',{x:-b.fs*.15,y:0,width:b.width,height:b.height,fill:'transparent','pointer-events':'all'});if(interactive)textGroup.append(hit);
  }else if(type==='dimension'){
    const q=D.dimensionGeometry(pts[0],pts[1],finite(s.dimensionOffset,25*unit),8*unit,4*unit);if(!q)return;
    for(const [a,b] of [[q.a,q.e1],[q.b,q.e2],[q.d1,q.d2]])group.append(se('line',{...attrs,x1:a.x,y1:a.y,x2:b.x,y2:b.y}));
    for(const points of [q.arrow1,q.arrow2])group.append(se('polygon',{points:points.map(p=>p.x+','+p.y).join(' '),fill:color,'pointer-events':'none'}));
    const p={x:q.mid.x,y:q.mid.y-8*unit},fs=finite(s.fontSize,12)*unit;
    const t=se('text',{x:p.x,y:p.y,transform:`rotate(${q.angle} ${p.x} ${p.y})`,'font-size':fs,'font-family':'sans-serif','text-anchor':'middle','dominant-baseline':'middle',fill:color,'paint-order':'stroke fill',stroke:s.white===false?'none':'white','stroke-width':3*unit,'pointer-events':'none'});t.textContent=dimensionText(s);group.append(t);
    hit=se('line',{x1:q.d1.x,y1:q.d1.y,x2:q.d2.x,y2:q.d2.y,stroke:'transparent','stroke-width':28/z(),'pointer-events':'stroke'});
  }
  if(interactive&&hit){hit.dataset.memoId=s.id;if(type!=='text')group.append(hit);hit.style.cursor='move';}
  if(interactive&&chosen===s.id&&!preview)drawHandles(s,group);
}
function drawHandles(s,group){
  const b=bounds(s),unit=1/z(),type=memoType(s);
  group.append(se('rect',{x:b.x-4*unit,y:b.y-4*unit,width:b.w+8*unit,height:b.h+8*unit,fill:'none',stroke:'#2563eb','stroke-width':unit,'stroke-dasharray':`${4*unit} ${4*unit}`,'pointer-events':'none','data-memo-ui':'true'}));
  const handles=(type==='line'||type==='dimension')?s.points.slice(0,2).map((p,i)=>[p,'endpoint-'+i]):[[{x:b.x+b.w,y:b.y+b.h},'resize']];
  for(const [p,role] of handles){const h=se('circle',{cx:p.x,cy:p.y,r:7*unit,fill:'#fff',stroke:'#2563eb','stroke-width':2*unit,'data-memo-id':s.id,'data-memo-handle':role,'data-memo-ui':'true'});h.style.cursor='nwse-resize';group.append(h);}
}
const originalRender=render;
render=function(){
  if(scope!==pageScope()||currentView!=='editor'){scope=pageScope();clearTransient();}
  const all=state.shapes||[],notes=all.filter(isMemo);let result;
  state.shapes=all.filter(s=>!isMemo(s));try{result=originalRender.apply(this,arguments);}finally{state.shapes=all;}
  if(mode==='memo')for(const child of svg.querySelectorAll('*'))child.style.pointerEvents='none';
  if(chosen&&!source(chosen))chosen=null;
  if(visible)for(const s of notes)if((s.page||1)===state.currentPage&&s.id!==gesture?.original?.id)drawOne(s,svg,tool==='pan');
  if(gesture?.preview)drawOne(gesture.preview,svg,false,true);
  updateUI();return result;
};
function withoutMemos(fn,self,args){const all=state.shapes;state.shapes=all.filter(s=>!isMemo(s));try{return fn.apply(self,args);}finally{state.shapes=all;}}
const originalRebuild=rebuildNumberingState;rebuildNumberingState=function(){return withoutMemos(originalRebuild,this,arguments);};
const originalAssign=assignNumbers;assignNumbers=function(){return withoutMemos(originalAssign,this,arguments);};
const originalMeta=updateActiveMeta;updateActiveMeta=function(){return withoutMemos(originalMeta,this,arguments);};
const originalSelect=selectShape;selectShape=function(id){if(source(id)){setMode('memo');chosen=id;selected=null;render();return;}chosen=null;return originalSelect.apply(this,arguments);};
const originalClear=clearSelection;clearSelection=function(){chosen=null;closePanel();return originalClear.apply(this,arguments);};
const originalCancel=cancelPointerDraft;cancelPointerDraft=function(){gesture=null;return originalCancel.apply(this,arguments);};
const originalRotate=rotateShapeGeometry;rotateShapeGeometry=function(s,w,h,dir){const r=originalRotate.apply(this,arguments);if(isMemo(s)&&memoType(s)==='text')s.rotation=finite(s.rotation)+(dir>0?90:-90);return r;};
function boundedPoint(e){const p=point(e);return {x:Math.max(0,Math.min(state.width,p.x)),y:Math.max(0,Math.min(state.height,p.y))};}
function take(e){if(e.cancelable)e.preventDefault();e.stopImmediatePropagation();}
wrap.addEventListener('pointerdown',e=>{
  if(!state.sourceType||exporting||gestureLock||activeTouches.size>1||e.pointerType==='mouse'&&e.button!==0)return;
  const id=e.target.closest?.('[data-memo-id]')?.dataset.memoId,p=boundedPoint(e),s=source(id);
  if(tool==='pan'&&s&&visible){
    take(e);if(mode!=='memo')setMode('memo');closePanel();chosen=s.id;selected=null;panStart=null;
    gesture={pointerId:e.pointerId,scope:pageScope(),start:p,original:clone(s),preview:clone(s),role:e.target.dataset.memoHandle||'move',moved:false};
  }else if(mode==='memo'&&tool.startsWith('memo-')){
    take(e);closePanel();chosen=null;selected=null;panStart=null;
    const type=tool.slice(5),draft=newMemo(type,[p,...(type==='text'?[]:[p])]);
    gesture={pointerId:e.pointerId,scope:pageScope(),start:p,preview:draft,type,moved:false};
  }else return;
  try{wrap.setPointerCapture(e.pointerId);}catch{}render();
},{capture:true,passive:false});
wrap.addEventListener('pointermove',e=>{
  if(!gesture||gesture.pointerId!==e.pointerId)return;
  if(gestureLock||activeTouches.size>1||gesture.scope!==pageScope()){gesture=null;render();return;}
  take(e);const p=boundedPoint(e),g=gesture,dx=p.x-g.start.x,dy=p.y-g.start.y;
  if(Math.hypot(dx,dy)*z()>3)g.moved=true;
  if(g.original){
    if(g.role==='move')g.preview=translated(g.original,dx,dy);
    else if(g.role.startsWith('endpoint-')){
      const index=Number(g.role.slice(-1));g.preview=clone(g.original);g.preview.points[index]=p;
      const m=manualMetres(g.original);
      if(isDimension(g.original)&&m!=null&&isCalibrated()){
        const a=g.preview.points[1-index],b=g.preview.points[index],r=D.resizedEnd(a,b,lineLengthMm([a,b]),m);
        if(!r.error)g.preview.points[index]=r.end;
      }
    }else g.preview=resized(g.original,p);
  }else if(g.type==='freehand'){
    const last=g.preview.points[g.preview.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)*z()>=1.5)g.preview.points.push(p);
    if(g.preview.points.length>4000)g.preview.points=simplify(g.preview.points,1/z());
  }else if(g.type!=='text')g.preview.points[1]=p;
  render();
},{capture:true,passive:false});
function finishMemo(e,cancelled){
  if(!gesture||gesture.pointerId!==e.pointerId)return false;
  const g=gesture;gesture=null;panStart=null;
  try{wrap.releasePointerCapture(e.pointerId);}catch{}
  if(cancelled||gestureLock||activeTouches.size>1||g.scope!==pageScope()){render();return true;}
  if(g.original){if(g.moved)commitChange(g.preview);else render();return true;}
  if(g.type==='text'){openEditor(g.preview,true);render();return true;}
  const b=bounds(g.preview);if(!g.moved||Math.hypot(b.w,b.h)*z()<5){render();return true;}
  if(g.type==='freehand')g.preview.points=simplify(g.preview.points,.7/z());
  if(commitChange(g.preview)&&g.type==='dimension'&&!isCalibrated())openEditor(g.preview);
  return true;
}
const originalFinish=finishPointer;finishPointer=function(e,cancelled=false){finishMemo(e,cancelled);return originalFinish.apply(this,arguments);};
window.addEventListener('pointerup',e=>{if(e.pointerType!=='touch'&&gesture?.pointerId===e.pointerId)finishPointer(e,false);},{capture:true});
window.addEventListener('pointercancel',e=>{if(e.pointerType!=='touch'&&gesture?.pointerId===e.pointerId)finishPointer(e,true);},{capture:true});
wrap.addEventListener('lostpointercapture',e=>{if(gesture?.pointerId===e.pointerId){gesture=null;render();}});
bar.addEventListener('click',e=>{if(e.target.closest('[data-tool],[data-field-record-tool],#undoBtn,#redoBtn')){clearTransient();queueMicrotask(()=>render());}});
window.addEventListener('blur',()=>{gesture=null;render();});
window.addEventListener('pagehide',clearTransient);
function reconcileManualDimensions(page){
  const warnings=[];if(!isCalibrated())return warnings;
  for(const s of state.shapes.filter(s=>isDimension(s)&&(s.page||1)===page)){
    const m=manualMetres(s);if(m==null)continue;
    const r=D.resizedEnd(s.points[0],s.points[1],lineLengthMm(s.points,page),m,{width:state.width,height:state.height});
    if(!r.error)s.points[1]=r.end;else warnings.push(s.id);
  }return warnings;
}
function openExport(){
  if(!state.sourceType){alert('先に図面を開いてください。');return;}
  const form=panelShell('このページをPDF保存'),label=el('label'),check=el('input',{type:'checkbox'});check.checked=visible;label.append(check,document.createTextNode('図面メモを含める'));form.append(label);
  form.append(el('p',{},'現在のページの図面と変状をPDFに保存します。元の図面は変更しません。'));
  const error=el('div',{class:'sl-memo-error',role:'alert'}),actions=el('div',{class:'sl-memo-actions'}),save=el('button',{type:'submit',class:'sl-memo-save'},'PDFを保存');actions.append(save,button('閉じる','PDF保存を閉じる',closePanel));form.append(error,actions);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;save.textContent='作成中…';try{await exportPdf(check.checked);closePanel();}catch(err){error.textContent=err.message||'PDFを作成できませんでした。';}finally{save.disabled=false;save.textContent='PDFを保存';}};
}
async function exportPdf(includeMemos){
  if(exporting||gesture)throw Error('描画を終えてから保存してください。');
  if(loading.style.display==='grid'||empty.style.display!=='none')throw Error('図面の読み込みが終わってから保存してください。');
  exporting=true;const previous={chosen,tool,visible,selected},exportScope=pageScope();let out=null,url=null;
  const paper=getPaperMm(),paperW=paper?.w||297,paperH=paper?.h||paperW*state.height/state.width;
  const fileName=(getDrawingMeta()?.name||'図面').replace(/[\\/:*?"<>|]/g,'_')+'_'+state.currentPage+'頁'+(includeMemos?'_メモあり':'_メモなし')+'.pdf';
  try{
    chosen=null;selected=null;tool='pan';visible=includeMemos;render();
    const copy=svg.cloneNode(true);copy.querySelectorAll('[data-memo-ui]').forEach(e=>e.remove());
    copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.setAttribute('width',state.width);copy.setAttribute('height',state.height);copy.setAttribute('viewBox',`0 0 ${state.width} ${state.height}`);
    copy.removeAttribute('style');
    const touch=/iPhone|iPad|iPod/i.test(navigator.userAgent||'')||navigator.maxTouchPoints>1;
    const factor=Math.min(2,(touch?3072:4096)/Math.max(state.width,state.height),Math.sqrt((touch?4000000:10000000)/(state.width*state.height)));
    out=document.createElement('canvas');out.width=Math.max(1,Math.round(state.width*factor));out.height=Math.max(1,Math.round(state.height*factor));
    const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage($('bgCanvas'),0,0,out.width,out.height);
    const image=new Image();url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml;charset=utf-8'}));
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('図面メモを画像化できませんでした。'));image.src=url;});
    ctx.drawImage(image,0,0,out.width,out.height);
    const blob=await new Promise(resolve=>out.toBlob(resolve,'image/jpeg',.95));if(!blob)throw Error('PDF用画像を作成できませんでした。');
    const pdf=new Blob([jpegPdf(new Uint8Array(await blob.arrayBuffer()),out.width,out.height,paperW*72/25.4,paperH*72/25.4)],{type:'application/pdf'});
    const a=el('a',{href:URL.createObjectURL(pdf),download:fileName});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000);
    return pdf;
  }finally{if(url)URL.revokeObjectURL(url);if(out){out.width=1;out.height=1;}if(exportScope===pageScope()){chosen=previous.chosen;selected=previous.selected;tool=previous.tool;}visible=previous.visible;exporting=false;render();}
}
root.SentlogDrawingMemos={version:'v1.77',...pure,setMode,activate,commitChange,dimensionText,reconcileManualDimensions,exportPdf,
  isEditing:()=>!!gesture||!!panel||exporting,
  get mode(){return mode;},get visible(){return visible;},get selectedId(){return chosen;},
  get toolLabel(){return 'メモ：'+(names[tool.replace('memo-','')]||'選択・移動');}};
updateUI();if(currentView==='editor')render();
})(typeof window==='object'?window:globalThis);

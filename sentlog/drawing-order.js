/* Display order only: never move/rename background PDFs, CAD or annotations. */
(function(root){'use strict';
const KEY='surveyFieldNoteWorkspaceV1',copy=x=>JSON.parse(JSON.stringify(x)),gid=d=>String(d?.groupId||d?.id||'');
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):null;
const natural=new Intl.Collator('ja',{numeric:true,sensitivity:'base'});
function orderGroups(groups){
 const items=[...(groups||[])];
 if(!items.some(g=>g.sheets?.some(d=>positive(d.groupOrder)!=null)))return items;
 return items.map((g,i)=>({g,i,rank:(g.sheets||[]).map(d=>positive(d.groupOrder)).find(x=>x!==null)??Infinity}))
  .sort((a,b)=>a.rank-b.rank||a.i-b.i).map(x=>x.g);
}
function byNumber(groups){return [...groups].sort((a,b)=>natural.compare(a.name||'',b.name||'')||String(a.id).localeCompare(String(b.id)));}
function verifyOrder(existing,ids){
 if(!Array.isArray(ids)||existing.length!==ids.length||new Set(ids).size!==ids.length||existing.some(id=>!ids.includes(id)))
  throw Error('並び順が変更されています。画面を更新してからもう一度操作してください。');
}
function reorderGroups(input,pid,ids,now=Date.now()){
 const ws=copy(input),p=ws.projects?.find(x=>x.id===pid);
 if(!p)throw Error('案件が見つかりません。');
 const existing=[...new Set((p.drawings||[]).map(gid))];verifyOrder(existing,ids);
 const ranks=new Map(ids.map((id,i)=>[id,i+1]));
 for(const d of p.drawings)d.groupOrder=ranks.get(gid(d));
 p.updatedAt=Math.max(Number(p.updatedAt)||0,Number(now)||0)+1;
 return ws;
}
function reorderSheets(input,pid,groupId,ids,now=Date.now()){
 const ws=copy(input),p=ws.projects?.find(x=>x.id===pid);
 if(!p)throw Error('案件が見つかりません。');
 const sheets=p.drawings.filter(d=>gid(d)===groupId);
 verifyOrder(sheets.map(d=>d.id),ids);
 const ranks=new Map(ids.map((id,i)=>[id,i+1]));
 sheets.forEach(d=>{d.sheetOrder=ranks.get(d.id);});
 p.updatedAt=Math.max(Number(p.updatedAt)||0,Number(now)||0)+1;
 return ws;
}
const api={gid,orderGroups,byNumber,reorderGroups,reorderSheets};
if(typeof module==='object'&&module.exports){module.exports=api;return;}
if(!root.document||root.SentlogDrawingOrder)return;
const S=root.SentlogRecords,G=root.SentlogDrawingGroups;
if(!S||!G)throw Error('図面No.の並び替え機能を利用できません。');
let editing=false,saving=false,lastProject='',toolbar=null,dragId=null;
const $=id=>document.getElementById(id);
const el=(tag,t,cls)=>{const e=document.createElement(tag);if(t!=null)e.textContent=t;if(cls)e.className=cls;return e;};
const project=()=>getProject(),groups=p=>orderGroups(G.groupsForProject(p).sort((a,b)=>b.updatedAt-a.updatedAt));
function button(t,handler){const b=el('button',t);b.type='button';b.onclick=e=>{e.preventDefault();e.stopPropagation();handler();};return b;}
function setMessage(msg,error=false){const e=toolbar?.querySelector('[data-role=status]');if(e){e.textContent=msg;e.style.color=error?'#b91c1c':'#64748b';}}
async function transact(makeNext){
 if(saving)return false;
 const raw=S.getItem(KEY),old=JSON.parse(raw||'null'),p=project();
 if(!old||!p)throw Error('案件の保存内容を確認できません。');
 const next=makeNext(old,p.id);
 if(typeof S.archiveAtomic!=='function')throw Error('安全な保存処理がありません。');
 saving=true;
 try{
  await S.archiveAtomic({writes:[[KEY,JSON.stringify(next)]],deleteFiles:[],expectedWorkspace:raw});
  workspace=next;return true;
 }finally{saving=false;}
}
async function saveIds(ids){
 try{if(await transact((ws,pid)=>reorderGroups(ws,pid,ids))){renderDrawings();setMessage('並び順を保存しました。ほかの端末にも同期されます。');}}
 catch(e){console.warn('group ordering',e);renderDrawings();setMessage('並び替えを保存できませんでした：'+e.message,true);}
}
async function move(id,offset){
 const p=project();if(!p)return;
 const ids=groups(p).map(g=>g.id),i=ids.indexOf(id),to=i+offset;
 if(i<0||to<0||to>=ids.length)return;
 [ids[i],ids[to]]=[ids[to],ids[i]];await saveIds(ids);
}
async function drop(from,to){
 if(!from||!to||from===to)return;
 const p=project();if(!p)return;
 const ids=groups(p).map(g=>g.id),i=ids.indexOf(from),j=ids.indexOf(to);
 if(i<0||j<0)return;
 ids.splice(i,1);ids.splice(j,0,from);await saveIds(ids);
}
function installStyle(){
 if($('slDrawingOrderCss'))return;
 const s=el('style');s.id='slDrawingOrderCss';
 s.textContent=[
  '.sl-order-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;background:#fff;border:1px solid #d1d5db;border-radius:9px;padding:10px;margin:12px 0}',
  '.sl-order-toolbar button{background:#fff;color:#111827;border:1px solid #cbd5e1;border-radius:8px;padding:8px 12px;min-height:39px;font-size:12px}',
  '.sl-order-toolbar .sl-order-toggle{background:#111827;color:white;border-color:#111827}',
  '.sl-order-hint{font-size:12px;color:#64748b;flex-basis:100%}',
  '.sl-order-card-actions{display:flex;align-items:center;gap:5px;margin:0 0 7px}',
  '.sl-order-card-actions button{background:#fff;border:1px solid #cbd5e1;color:#111827;border-radius:7px;padding:5px 7px;min-height:35px;font-size:12px}',
  '.sl-order-card-actions .sl-order-handle{flex:1;text-align:left;touch-action:none;user-select:none;cursor:grab}',
  '.sl-order-card-actions button:disabled{opacity:.35}',
  '.sl-order-edit .drawing-group-actions{display:none}',
  '.sl-order-edit .manager-card{cursor:default}',
  '.sl-order-edit .manager-card.sl-order-drop{outline:3px solid #0f766e}',
  '.sl-order-edit .manager-card.sl-order-source{opacity:.65}',
  '.sl-sheet-order{display:flex;gap:7px;align-items:center;font-size:12px}',
  '.sl-sheet-order button{flex:1;min-height:40px;border:1px solid #cbd5e1;border-radius:7px;background:#fff}',
  '.sl-sheet-order button:disabled{opacity:.35}',
  '@media(max-width:500px){.sl-order-toolbar button{min-height:44px}}'
 ].join('');
 document.head.append(s);
}
function getToolbar(){
 const grid=$('drawingsGrid');if(!grid)return null;
 if(!toolbar){
  toolbar=el('div',null,'sl-order-toolbar');toolbar.id='slDrawingOrderToolbar';
  const toggle=button('⇅ 並び替え',()=>{editing=!editing;renderDrawings();});toggle.className='sl-order-toggle';toggle.dataset.role='toggle';
  const byNum=button('図面No.順に整列',()=>{const p=project();if(p)saveIds(byNumber(G.groupsForProject(p)).map(g=>g.id));});
  byNum.dataset.role='numeric';
  const hint=el('div',null,'sl-order-hint');hint.dataset.role='status';hint.setAttribute('role','status');
  toolbar.append(toggle,byNum,hint);grid.before(toolbar);
 }
 return toolbar;
}
function clearHighlights(){$('drawingsGrid')?.querySelectorAll('.sl-order-drop,.sl-order-source').forEach(c=>c.classList.remove('sl-order-drop','sl-order-source'));}
function bindTouch(handle,id){
 let touch=null;
 handle.addEventListener('pointerdown',e=>{
  if(!editing||e.pointerType==='mouse'||saving)return;
  touch={id:e.pointerId,from:id,x:e.clientX,y:e.clientY,drag:false,to:null,timer:null};
  touch.timer=setTimeout(()=>{if(touch){touch.drag=true;handle.closest('[data-drawing-group-id]')?.classList.add('sl-order-source');}},420);
  try{handle.setPointerCapture(e.pointerId);}catch(_){}
 });
 handle.addEventListener('pointermove',e=>{
  if(!touch||e.pointerId!==touch.id)return;
  if(!touch.drag){
   if(Math.hypot(touch.x-e.clientX,touch.y-e.clientY)>12){clearTimeout(touch.timer);touch=null;}
   return;
  }
  e.preventDefault();clearHighlights();
  handle.closest('[data-drawing-group-id]')?.classList.add('sl-order-source');
  const candidate=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-drawing-group-id]');
  touch.to=candidate?.dataset.drawingGroupId||null;
  if(candidate&&touch.to!==touch.from)candidate.classList.add('sl-order-drop');
 });
 const end=e=>{
  if(!touch||e.pointerId!==touch.id)return;
  const {timer,drag,from,to}=touch;clearTimeout(timer);touch=null;clearHighlights();
  if(drag){e.preventDefault();e.stopPropagation();if(to&&to!==from)drop(from,to);}
 };
 handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}
function decorate(){
 const p=project(),grid=$('drawingsGrid');if(!p||!grid)return;
 if(lastProject!==p.id){lastProject=p.id;editing=false;}
 installStyle();const bar=getToolbar(),list=groups(p);if(!bar)return;
 bar.hidden=list.length<2;
 bar.querySelector('[data-role=toggle]').textContent=editing?'✓ 完了':'⇅ 並び替え';
 bar.querySelector('[data-role=numeric]').hidden=!editing;
 setMessage(editing?'PCはドラッグ、iPad・iPhoneは「移動」を長押し。上下ボタンでも変更できます。':'');
 grid.classList.toggle('sl-order-edit',editing);
 const cards=new Map([...grid.querySelectorAll('[data-drawing-group-id]')].map(c=>[c.dataset.drawingGroupId,c]));
 for(const g of list){const c=cards.get(g.id);if(c)grid.append(c);}
 list.forEach((g,i)=>{
  const card=cards.get(g.id);if(!card||!editing)return;
  card.addEventListener('click',e=>{if(e.target.closest('button,input,select'))return;e.preventDefault();e.stopImmediatePropagation();},true);
  card.addEventListener('keydown',e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopImmediatePropagation();}},true);
  const row=el('div',null,'sl-order-card-actions'),handle=button('⠿ 移動',()=>{});
  handle.className='sl-order-handle';handle.title='ドラッグ、または長押しして移動';handle.setAttribute('aria-label',g.name+'を移動');
  const up=button('↑',()=>move(g.id,-1));up.disabled=i===0;up.setAttribute('aria-label',g.name+'を一つ前へ');
  const down=button('↓',()=>move(g.id,1));down.disabled=i===list.length-1;down.setAttribute('aria-label',g.name+'を一つ後ろへ');
  row.append(handle,up,down);card.prepend(row);card.draggable=true;
  card.addEventListener('dragstart',e=>{if(!editing||saving)return e.preventDefault();dragId=g.id;e.dataTransfer?.setData('text/plain',g.id);card.classList.add('sl-order-source');});
  card.addEventListener('dragover',e=>{if(!editing||!dragId)return;e.preventDefault();clearHighlights();card.classList.add('sl-order-drop');});
  card.addEventListener('drop',e=>{if(!editing||!dragId)return;e.preventDefault();e.stopPropagation();const from=dragId;dragId=null;clearHighlights();drop(from,g.id);});
  card.addEventListener('dragend',()=>{dragId=null;clearHighlights();});
  bindTouch(handle,g.id);
 });
}
async function moveSheet(offset){
 const p=project(),d=getDrawingMeta();if(!p||!d||saving)return;
 const g=G.groupsForProject(p).find(x=>x.id===gid(d));if(!g)return;
 const ids=g.sheets.map(x=>x.id),i=ids.indexOf(d.id),j=i+offset;if(i<0||j<0||j>=ids.length)return;
 [ids[i],ids[j]]=[ids[j],ids[i]];
 try{if(await transact((ws,pid)=>reorderSheets(ws,pid,g.id,ids))){G.updateSheetUi();sheetControls();}}
 catch(e){console.warn('sheet reorder',e);alert('シートの順番を保存できませんでした：'+e.message);}
}
function sheetControls(){
 if(currentView!=='editor')return;
 const host=$('sentlogSheetNav');if(!host)return;
 let bar=host.querySelector('.sl-sheet-order');
 if(!bar){
  bar=el('div',null,'sl-sheet-order');const text=el('span','シート順');
  const up=button('↑ 前へ',()=>moveSheet(-1));up.dataset.action='up';
  const down=button('↓ 後へ',()=>moveSheet(1));down.dataset.action='down';
  bar.append(text,up,down);host.append(bar);
 }
 const p=project(),d=getDrawingMeta(),g=p&&d?G.groupsForProject(p).find(x=>x.id===gid(d)):null;
 bar.hidden=!g||g.sheets.length<2;if(!g)return;
 const i=g.sheets.findIndex(x=>x.id===d.id);
 bar.querySelector('[data-action=up]').disabled=i<=0||saving;
 bar.querySelector('[data-action=down]').disabled=i<0||i>=g.sheets.length-1||saving;
}
const oldRender=renderDrawings;renderDrawings=function(){const r=oldRender.apply(this,arguments);decorate();return r;};
const oldOpen=openDrawing;openDrawing=async function(){const r=await oldOpen.apply(this,arguments);sheetControls();return r;};
const oldEditor=showEditor;showEditor=function(){const r=oldEditor.apply(this,arguments);sheetControls();return r;};
root.SentlogDrawingOrder={...api,version:1};
Promise.resolve(root.sentlogAppReady).then(()=>{if(currentView==='drawings')renderDrawings();if(currentView==='editor')sheetControls();});
})(typeof window!=='undefined'?window:globalThis);

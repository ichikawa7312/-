/* Sentlog: temporary annotation visibility and selected PDF export.
 * No changes to persisted shapes, sync state, drawing sources, or histories. */
(function(root){'use strict';
const F=root.SentlogDisplayFilterCore;
if(!F||root.SentlogDisplayFilter||typeof render!=='function')return;
const active=new Map();let modal=null,saveURL=null,working=false;
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const btn=(text,action)=>{const node=el('button',text);node.type='button';node.addEventListener('click',action);return node;};
const key=()=>typeof activeDrawingId==='string'?activeDrawingId:null;
const applied=()=>active.get(key())||null;
const allShapes=()=>Array.isArray(state.shapes)?state.shapes:[];
const control=btn('表示切替・PDF',open);
control.id='slDisplayFilterBtn';control.className='sl-display-filter-open';
const indicator=el('span','');indicator.id='slDisplayFilterStatus';indicator.setAttribute('role','status');
const toolbar=document.getElementById('sentlogDrawingToolbar')||document.querySelector('#editorView .toolbar');
if(toolbar){toolbar.append(control,indicator);}
const origRender=render;
render=function(){
 const filter=currentView==='editor'?applied():null,all=allShapes();
 if(!filter){const result=origRender.apply(this,arguments);updateStatus(all);return result;}
 state.shapes=all.filter(s=>F.isVisible(s,filter));
 try{return origRender.apply(this,arguments);}
 finally{state.shapes=all;updateStatus(all);}
};
function updateStatus(shapes=allShapes()){
 const filter=applied(),on=currentView==='editor'&&filter&&!F.isAll(shapes,filter);
 control.textContent=on?'表示絞込中・PDF':'表示切替・PDF';
 indicator.textContent=on?'表示を絞り込み中（記録は残っています）':'';
 const clear=document.getElementById('clearBtn');if(clear)clear.disabled=!!on;
 const file=document.getElementById('fileInput');if(file)file.disabled=!!on;
}
/* Switching into an edit gesture restores the complete drawing first.
 * Otherwise a newly created record outside the filter could appear to vanish. */
const stage=document.getElementById('stageWrap');
stage?.addEventListener('pointerdown',()=>{
 const filter=applied();
 if(currentView!=='editor'||!filter||F.isAll(allShapes(),filter))return;
 if(tool!=='pan'||root.SentlogDrawingMemos?.mode==='memo'){
  active.delete(key());render();
 }
},{capture:true});
document.getElementById('damageType')?.addEventListener('change',()=>{
 const filter=applied();
 if(currentView==='editor'&&filter&&!F.isAll(allShapes(),filter)){
  active.delete(key());render();
 }
},{capture:true});

function close(){if(working)return;if(saveURL){URL.revokeObjectURL(saveURL);saveURL=null;}modal?.remove();modal=null;}
function open(){
 if(currentView!=='editor'||!key()||!state.sourceType){alert('図面を開いてから表示切替を使ってください。');return;}
 if(working)return;close();
 const currentId=key(),projectId=activeProjectId,shapes=allShapes().slice(),known=F.categories(shapes);
 const previous=F.normalise(active.get(currentId),shapes);
 let draft={categories:[...previous.categories],hiddenIds:[...previous.hiddenIds]};
 const selectedCategories=new Set(draft.categories),hidden=new Set(draft.hiddenIds);
 const panel=el('dialog');panel.className='sl-display-filter-dialog';modal=panel;
 const header=el('h2','表示切替・PDF出力');
 const intro=el('p','表示する変状や写真・調査位置を選択できます。記録そのものは変更されません。');
 const typeTitle=el('h3','表示する種類');
 const typeGrid=el('div');typeGrid.className='sl-filter-types';
 const individualTitle=el('h3','個別の記録を選択');
 const individualHint=el('p','種類ごとに開いて、特定の番号だけを残すこともできます。');individualHint.className='sl-filter-hint';
 const records=el('div');records.className='sl-filter-records';
 const options=el('div');options.className='sl-filter-options';
 const selectAll=btn('すべて表示',()=>{known.forEach(c=>selectedCategories.add(c));hidden.clear();syncChecks();});
 const selectNone=btn('すべて非表示',()=>{selectedCategories.clear();syncChecks();});
 options.append(selectAll,selectNone);
 const categoryChecks=new Map(),individualChecks=[];
 const groups=new Map(known.map(c=>[c,[]]));
 for(const shape of shapes){const c=F.category(shape);groups.get(c)?.push(shape);}
 for(const [c,group] of groups){
  const row=el('label'),box=el('input');box.type='checkbox';box.checked=selectedCategories.has(c);box.addEventListener('change',()=>{if(box.checked)selectedCategories.add(c);else selectedCategories.delete(c);syncChecks();});
  row.append(box,document.createTextNode(c+'（'+group.length+'）'));typeGrid.append(row);categoryChecks.set(c,box);
  const section=el('details');section.className='sl-filter-group';const summary=el('summary',c+'（'+group.length+'件）');section.append(summary);
  if(known.length===1)section.open=true;
  for(const shape of group){
   const line=el('label'),item=el('input'),id=String(shape.id??'');item.type='checkbox';item.checked=!hidden.has(id);item.addEventListener('change',()=>{if(item.checked)hidden.delete(id);else hidden.add(id);});
   const label=F.label(shape)||c;line.append(item,document.createTextNode('P'+(shape.page||1)+'　'+label));section.append(line);individualChecks.push({item,c,id});
  }
  records.append(section);
 }
 function syncChecks(){for(const [c,box] of categoryChecks)box.checked=selectedCategories.has(c);for(const {item,c,id} of individualChecks){item.disabled=!selectedCategories.has(c);item.checked=!hidden.has(id);}}
 function currentDraft(){return F.normalise({categories:[...selectedCategories],hiddenIds:[...hidden]},shapes);}
 syncChecks();
 const outputTitle=el('h3','PDFの出力範囲');
 const range=el('div');range.className='sl-filter-range';
 const one=el('label'),oneInput=el('input');oneInput.type='radio';oneInput.name='sl-filter-range';oneInput.value='page';oneInput.checked=true;one.append(oneInput,document.createTextNode('現在のページ（P'+(state.currentPage||1)+'）'));
 const all=el('label'),allInput=el('input');allInput.type='radio';allInput.name='sl-filter-range';allInput.value='all';all.append(allInput,document.createTextNode('この図面の全ページ'));
 range.append(one,all);
 const status=el('p','');status.className='sl-filter-result';status.setAttribute('role','status');
 const results=el('div');results.className='sl-filter-result-actions';
 const actions=el('div');actions.className='sl-filter-actions';
 const show=btn('画面に反映',()=>{
  if(currentView!=='editor'||key()!==currentId){status.textContent='図面が変わりました。いったん閉じて開き直してください。';return;}
  const f=currentDraft();if(F.isAll(shapes,f))active.delete(currentId);else active.set(currentId,f);
  selected=null;render();if(typeof renderSelectedPhotos==='function')renderSelectedPhotos();close();
 });
 const reset=btn('全表示に戻す',()=>{active.delete(currentId);if(currentView==='editor'&&key()===currentId){selected=null;render();}close();});
 const create=btn('選択内容でPDF作成',async()=>{
  if(working)return;
  if(currentView!=='editor'||key()!==currentId){status.textContent='図面が変わりました。開き直してください。';return;}
  if(!root.SentlogDrawingExport||root.SentlogDrawingExport.busy){status.textContent='他のPDF出力が進行中です。';return;}
  working=true;for(const b of [create,show,reset,closeButton,selectAll,selectNone])b.disabled=true;results.replaceChildren();
  if(saveURL){URL.revokeObjectURL(saveURL);saveURL=null;}
  try{
   status.textContent='記録の保存状態を確認しています…';
   await SentlogRecords.settled();SentlogRecords.assertSafe();
   const [item]=root.SentlogDrawingExport.inputSnapshot(projectId,[currentId],true);
   item.filter=currentDraft();item.onlyPage=oneInput.checked?Number(state.currentPage||1):null;
   const result=await root.SentlogDrawingExport.createPdf(item,(page,count)=>{status.textContent='PDF作成中：'+page+' / '+count+'ページ';},stage=>{status.textContent=stage;});
   if(currentView!=='editor'||key()!==currentId)throw Error('途中で図面が切り替わりました。もう一度出力してください。');
   const filename=FILENAME(item.drawing.name,item.onlyPage);
   saveURL=URL.createObjectURL(result.blob);
   const download=el('a','PDFを保存');download.href=saveURL;download.download=filename;download.className='sl-filter-save';results.append(download);
   const file=new File([result.blob],filename,{type:'application/pdf'});
   if(navigator.canShare?.({files:[file]}))results.append(btn('共有・ファイルに保存',async()=>{try{await navigator.share({files:[file]});}catch(e){if(e.name!=='AbortError')status.textContent='共有できませんでした。「PDFを保存」を使ってください。';}}));
   status.textContent=result.pages+'ページのPDFを作成しました。下の「PDFを保存」を押してください。';
  }catch(e){status.textContent=e?.message||'PDFを作成できませんでした。';}
  finally{working=false;for(const b of [create,show,reset,closeButton,selectAll,selectNone])b.disabled=false;}
 });
 create.className='sl-filter-primary';
 const closeButton=btn('閉じる',close);
 actions.append(show,create,reset,closeButton);
 panel.addEventListener('cancel',e=>{e.preventDefault();close();});
 panel.append(header,intro,options,typeTitle,typeGrid,individualTitle,individualHint,records,outputTitle,range,status,actions,results);
 document.body.append(panel);panel.showModal();
}
function FILENAME(name,page){
 const base=(root.SentlogDrawingExportCore?.safeName?.(name)||'図面');
 return base+(page==null?'_表示選択_全ページ':'_表示選択_P'+page)+'.pdf';
}
const css=el('style');css.textContent=`
.sl-display-filter-open{min-width:104px;min-height:40px;border:1px solid #64748b;border-radius:8px;background:#f8fafc;color:#0f172a;font-size:12px;font-weight:700}
#slDisplayFilterStatus{font-size:11px;color:#b45309;max-width:230px}
.sl-display-filter-dialog{box-sizing:border-box;width:min(620px,calc(100vw - 20px));max-height:90dvh;border:0;border-radius:14px;padding:18px;background:white;color:#0f172a;overflow:auto}
.sl-display-filter-dialog::backdrop{background:#0009}.sl-display-filter-dialog h2{margin:0 0 8px;font-size:18px}.sl-display-filter-dialog h3{font-size:14px;margin:16px 0 8px}
.sl-display-filter-dialog p{font-size:12px;line-height:1.5;margin:6px 0}
.sl-display-filter-dialog button,.sl-filter-save{min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#111827}
.sl-display-filter-dialog label{display:flex;gap:8px;align-items:center;min-height:37px;font-size:13px;cursor:pointer}
.sl-display-filter-dialog input[type=checkbox],.sl-display-filter-dialog input[type=radio]{width:18px;height:18px;flex:none}
.sl-filter-options,.sl-filter-actions,.sl-filter-result-actions{display:flex;flex-wrap:wrap;gap:8px}
.sl-filter-types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}
.sl-filter-records{max-height:28dvh;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;padding:5px 10px}
.sl-filter-group{border-bottom:1px solid #e2e8f0}.sl-filter-group:last-child{border:0}
.sl-filter-group summary{padding:10px 4px;cursor:pointer;font-size:13px;font-weight:600}
.sl-filter-group label{padding:0 8px 0 16px}.sl-filter-hint{color:#64748b}
.sl-filter-range{display:flex;flex-wrap:wrap;gap:12px}.sl-filter-primary{background:#0f172a!important;color:white!important}
.sl-filter-result{white-space:pre-wrap;color:#1f2937}.sl-filter-save{display:inline-flex;text-decoration:none;background:#0f172a!important;color:white!important;align-items:center}
@media(max-width:560px){.sl-filter-types{grid-template-columns:1fr}.sl-display-filter-dialog{padding:12px}.sl-display-filter-open{min-width:84px}}
`;document.head.append(css);
root.SentlogDisplayFilter={version:1,open,reset:()=>{if(key())active.delete(key());render();},filter:()=>applied(),isVisible:s=>F.isVisible(s,applied())};
})(typeof window==='object'?window:globalThis);

/* SentlogDrawingExport v1.88: complete drawings, isolated rendering, explicit save. */
(function(){'use strict';
if(window.SentlogDrawingExport)return;
const C=window.SentlogDrawingExportCore,frames=new Map(),copy=v=>JSON.parse(JSON.stringify(v));
let running=false,cancelled=false,dialog=null,resultURL=null,library=null;
const element=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
const button=(text,fn)=>{const e=element('button',text);e.type='button';e.onclick=fn;return e;};
const check=()=>{if(cancelled)throw Error('出力を中止しました。');};
async function bounded(task){
 let timer,poll;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('図面出力がタイムアウトしました。図面を分けて再試行してください。')),90000);poll=setInterval(()=>{if(cancelled)reject(Error('出力を中止しました。'));},150);})]);}
 finally{clearTimeout(timer);clearInterval(poll);}
}
async function libs(){
 if(window.PDFLib)return window.PDFLib;
 if(!library)library=new Promise((resolve,reject)=>{const s=element('script');s.src='./vendor/export-pdf-lib.min.js?v=1171';s.onload=()=>resolve(window.PDFLib);s.onerror=()=>{library=null;s.remove();reject(Error('PDF出力機能を取得できません。通信を確認してください。'));};document.head.append(s);});
 return library;
}
function inputSnapshot(projectId,ids,includeMemos){
 const project=getProject(projectId);if(!project)throw Error('案件を確認できません。');
 const selected=project.drawings.filter(d=>ids.includes(d.id));if(!selected.length)throw Error('出力する図面を選んでください。');
 const preferences={};for(const key of ['sentlogDamageDisplayV1']){const value=localStorage.getItem(key);if(value!==null)preferences[key]=value;}
 return selected.map(d=>{const raw=SentlogRecords.getItem(drawingStorageKey(d.id));if(!raw)throw Error(d.name+'：図面の記録がこの端末にありません。同期または復旧してください。');
  const state=JSON.parse(raw);if(!Array.isArray(state.shapes))throw Error(d.name+'：記録を読み取れません。');
  return {project:copy(project),drawing:copy(d),state,raw,includeMemos,preferences};});
}
function unchanged(item){if(SentlogRecords.getItem(drawingStorageKey(item.drawing.id))!==item.raw)throw Error(item.drawing.name+'：出力中に記録が更新されました。同期後にもう一度出力してください。');}
async function renderer(item){
 const token=crypto.randomUUID(),frame=element('iframe');frame.title='図面出力処理';frame.setAttribute('aria-hidden','true');
 frame.tabIndex=-1;frame.inert=true;
 frame.style.cssText='position:fixed;left:-20000px;top:0;width:1400px;height:1000px;border:0;pointer-events:none;';
 frames.set(token,{frame,input:item});
 const ready=new Promise((resolve,reject)=>{frame.onload=()=>{const api=frame.contentWindow.SentlogExportRenderer;if(api)resolve(api);else reject(Error('図面出力画面を開始できません。再読み込みしてください。'));};frame.onerror=()=>reject(Error('出力画面を読み込めません。'));});
 frame.src='./drawing-export-view.html?v=188&job='+encodeURIComponent(token);document.body.append(frame);
 let timeout;try{const api=await Promise.race([ready,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('出力画面の読み込みがタイムアウトしました。')),45000);})]);return {api,dispose:()=>{frames.delete(token);frame.remove();}};}
 catch(e){frames.delete(token);frame.remove();throw e;}finally{clearTimeout(timeout);}
}
async function createPdf(item,onPage){
 check();unchanged(item);
 const file=await getBackgroundFile(item.drawing.id);if(!(file instanceof Blob)||!file.size)throw Error(item.drawing.name+'：元図がこの端末にありません。同期またはPCから復旧してください。');
 unchanged(item);const P=await libs();
 const source=(item.state.sourceType==='pdf'||/\.pdf$/i.test(file.name||item.state.fileName||''))?await P.PDFDocument.load(await file.arrayBuffer(),{updateMetadata:false}):null;
 const worker=await renderer({...item,file});
 try{
  const info=await bounded(worker.api.ready);check();
  if(source&&source.getPageCount()!==info.count)throw Error('PDFのページ数が一致しません。');
  const doc=await P.PDFDocument.create();doc.setTitle(item.drawing.name);doc.setCreator('');doc.setProducer('');
  for(let n=1;n<=info.count;n++){check();unchanged(item);onPage(n,info.count);check();const data=await bounded(worker.api.page(n));check();await C.addPage(doc,source,data,P);}
  unchanged(item);return {blob:new Blob([await doc.save()],{type:'application/pdf'}),pages:info.count};
 }finally{worker.dispose();}
}
async function hash(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function writeVerified(folder,name,blob){
 const handle=await folder.getFileHandle(name,{create:true}),writer=await handle.createWritable();
 try{await writer.write(blob);await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
 const saved=await handle.getFile();if(saved.size!==blob.size||await hash(saved)!==await hash(blob))throw Error(name+'：保存後の照合に失敗しました。');
}
function stamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());}
async function newFolder(parent,name){
 for(let i=0;i<10;i++){const candidate=name+'_'+crypto.randomUUID().slice(0,6);try{await parent.getDirectoryHandle(candidate);}catch(e){if(e.name==='NotFoundError')return parent.getDirectoryHandle(candidate,{create:true});throw e;}}
 throw Error('新しい出力先を作れません。');
}
async function runExport(projectId,ids,{includeMemos=true,folder=null,onProgress=()=>{}}={}){
 if(running)throw Error('出力が進行中です。');running=true;cancelled=false;
 let saved=0,output=null;
 try{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const items=inputSnapshot(projectId,ids,includeMemos),files=[],fileNames=C.names(items.map(i=>i.drawing));
  const bundleName=C.safeName(items[0].project.name)+'_記録図面_'+stamp();
  if(folder)output=await newFolder(folder,bundleName);
  let bytes=0,totalPages=0;const lines=['案件：'+items[0].project.name,'出力日時：'+new Date().toLocaleString('ja-JP'),'図面メモ：'+(includeMemos?'含む':'含まない'),'添付写真の画像は含みません。',''];
  for(let i=0;i<items.length;i++){
   check();const item=items[i];const result=await createPdf(item,(page,count)=>onProgress(`${i+1}/${items.length} 図面：${item.drawing.name}（${page}/${count}ページ）`));
   check();bytes+=result.blob.size;totalPages+=result.pages;
   if(output)await writeVerified(output,fileNames[i],result.blob);
   else {if(bytes>160*1024*1024)throw Error('出力が160MBを超えました。図面を選び直して、分けて出力してください。');files.push({name:fileNames[i],blob:result.blob});}
   saved++;lines.push(fileNames[i]+'　'+result.pages+'ページ');
  }
  for(const item of items)unchanged(item);
  const list=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/plain;charset=utf-8'});
  if(output)await writeVerified(output,'出力一覧.txt',list);else files.push({name:'出力一覧.txt',blob:list});
  check();onProgress('出力ファイルをまとめています…');
  return {blob:output?null:await C.zip(files),name:bundleName+'.zip',count:items.length,pages:totalPages,folderName:output?.name};
 }catch(e){if(output&&saved)e.message+='（'+output.name+' に'+saved+'件のPDFを保存済みです。一括出力は完了していません。）';throw e;}
 finally{running=false;}
}
function close(){if(running){cancelled=true;return;}dialog?.close();dialog?.remove();dialog=null;if(resultURL)URL.revokeObjectURL(resultURL);resultURL=null;}
function open(){
 if(running)return;const project=getProject();if(currentView!=='drawings'||!project)return;close();
 const projectId=project.id;dialog=element('dialog');dialog.className='sl-drawing-export';
 dialog.append(element('h2','記録図面を一括出力'),element('p','変状・寸法・写真番号・撮影方向を含め、図面ごとに全ページをPDFにします。添付写真の画像は含みません。'));
 const toolbar=element('div'),list=element('div');list.className='sl-export-list';const boxes=[];
 for(const d of project.drawings){const label=element('label'),box=element('input');box.type='checkbox';box.value=d.id;box.checked=true;label.append(box,document.createTextNode(d.name+'（'+(d.pageCount||1)+'ページ）'));list.append(label);boxes.push(box);}
 toolbar.append(button('全選択',()=>boxes.forEach(b=>b.checked=true)),button('選択解除',()=>boxes.forEach(b=>b.checked=false)));
 const label=element('label'),memos=element('input');memos.type='checkbox';memos.checked=true;label.append(memos,document.createTextNode('図面メモを含める'));
 const status=element('p');status.className='sl-export-status';status.setAttribute('role','status');
 const actions=element('div');actions.className='sl-export-actions';const results=element('div');results.className='sl-export-results';
 const controls=[...toolbar.querySelectorAll('button')];
 const start=async mode=>{
  const ids=boxes.filter(b=>b.checked).map(b=>b.value);if(!ids.length){status.textContent='図面を1件以上選んでください。';return;}
  controls.forEach(b=>b.disabled=true);boxes.forEach(b=>b.disabled=true);memos.disabled=true;results.replaceChildren();if(resultURL){URL.revokeObjectURL(resultURL);resultURL=null;}
  try{
   // The picker must run directly inside this user gesture.
   const folder=mode==='folder'?await window.showDirectoryPicker({mode:'readwrite'}):null;
   status.textContent='出力を準備しています…';
   const result=await runExport(projectId,ids,{includeMemos:memos.checked,folder,onProgress:text=>status.textContent=text});
   if(result.blob){
    resultURL=URL.createObjectURL(result.blob);const save=element('a','ZIPを保存');save.href=resultURL;save.download=result.name;save.className='sl-export-save';results.append(save);
    const file=new File([result.blob],result.name,{type:'application/zip'});
    if(navigator.canShare?.({files:[file]}))results.append(button('共有・ファイルに保存',async()=>{try{await navigator.share({files:[file]});}catch(e){if(e.name!=='AbortError')status.textContent='共有できませんでした。「ZIPを保存」を使ってください。';}}));
    status.textContent=result.count+'図面・'+result.pages+'ページのPDFを作成しました。下のボタンで保存してください。';
   }else status.textContent=result.count+'図面・'+result.pages+'ページを「'+result.folderName+'」に保存・照合しました。';
  }catch(e){status.textContent=e.name==='AbortError'?'保存先の選択をキャンセルしました。':(e.message||'出力できませんでした。');}
  finally{controls.forEach(b=>b.disabled=false);boxes.forEach(b=>b.disabled=false);memos.disabled=false;}
 };
 const zip=button('PDFをまとめて作成',()=>start('zip'));zip.id='slDrawingExportZip';controls.push(zip);actions.append(zip);
 if(typeof window.showDirectoryPicker==='function'){const folder=button('PCのフォルダに保存',()=>start('folder'));folder.id='slDrawingExportFolder';controls.push(folder);actions.append(folder);}
 const cancel=button('閉じる／出力を中止',close);actions.append(cancel);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 dialog.append(toolbar,list,label,status,actions,results);document.body.append(dialog);dialog.showModal();
}
const launch=button('記録図面を一括出力',open);launch.id='slDrawingExportBtn';
document.querySelector('#drawingsView .manager-actions')?.append(launch);
if(!launch.isConnected)document.querySelector('#drawingsView .manager-shell')?.prepend(launch);
const style=element('style');style.textContent='.sl-drawing-export{box-sizing:border-box;width:min(580px,calc(100% - 24px));max-height:88dvh;border:0;border-radius:14px;padding:20px;color:#111827;background:#fff}.sl-drawing-export::backdrop{background:#0007}.sl-drawing-export h2{font-size:19px;margin:0 0 12px}.sl-drawing-export p{font-size:13px;line-height:1.7}.sl-drawing-export button,.sl-export-save{padding:10px 14px;min-height:44px;margin:4px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#111827}.sl-export-list{max-height:34dvh;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0}.sl-export-list label{display:flex;align-items:center;gap:10px;padding:12px;overflow-wrap:anywhere}.sl-drawing-export input[type=checkbox]{width:18px;height:18px;flex:none}.sl-export-actions,.sl-export-results{display:flex;flex-wrap:wrap;gap:4px}.sl-export-save{display:inline-flex;align-items:center;text-decoration:none;background:#111827;color:white}.sl-export-status{white-space:pre-wrap;overflow-wrap:anywhere}#slDrawingExportBtn{min-height:42px;}';document.head.append(style);
window.SentlogDrawingExport={version:'v1.88',open,runExport,createPdf,inputSnapshot,cancel:()=>cancelled=true,get busy(){return running;},frameInput(token,child){const entry=frames.get(token);return entry?.frame.contentWindow===child?entry.input:null;}};
})();

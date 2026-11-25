/* High-quality ledger export: lazy source reading, file-backed XLSX. */
(function(root){
 'use strict';
 const TOKEN='20261125-ledger-hq-1',TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
 const err=(message,code='LEDGER_EXPORT')=>Object.assign(Error(message),{code});
 const MAX_BYTES=0xffffffff-32*1024*1024,MAX_PIXELS=24000000;
 const check=signal=>{if(signal?.aborted)throw err('Excel出力を中止しました。元の写真・記録は変更していません。','LEDGER_CANCEL');};
 if(typeof root.importScripts==='function'&&!root.document){
  const lib=new URL('original-photo-zip.js',root.location.href);lib.search='?v=20261121-onezip';root.importScripts(lib.href);
  const NS='sentlog-ledger-exports-v1',READY='ready.json';let job=null,busy=false;
  async function cleanup(remove){
   const j=job;job=null;if(!j)return;
   try{if(j.output)await j.output.close();}finally{
    try{if(remove&&j.dirName&&j.ns&&j.lease)await j.ns.removeEntry(j.dirName,{recursive:true});}finally{if(j.lease)await j.lease.close();}
   }
  }
  async function writeAll(j,bytes){let n=0;while(n<bytes.length){const k=await j.output.write(bytes.subarray(n),{at:j.pos});if(!Number.isInteger(k)||k<=0||k>bytes.length-n)throw err('Excelの一時保存に失敗しました。','LEDGER_WRITE');n+=k;j.pos+=k;}if(j.pos>MAX_BYTES)throw err('ExcelのZIP容量上限に近づきました。出力対象を分けてください。','LEDGER_LIMIT');return bytes.length;}
  async function start(msg){
   if(job)throw err('Excel出力がすでに進行中です。','LEDGER_BUSY');
   if(!navigator.storage?.getDirectory)throw err('このブラウザーでは高画質Excelの一時保存を利用できません。','LEDGER_OPFS');
   const j=job={pos:0,names:new Set()};j.ns=await (await navigator.storage.getDirectory()).getDirectoryHandle(NS,{create:true});
   const lock=await j.ns.getFileHandle('lease',{create:true});if(typeof lock.createSyncAccessHandle!=='function')throw err('このブラウザーでは高画質Excelの一時保存を利用できません。','LEDGER_OPFS');
   try{j.lease=await lock.createSyncAccessHandle();}catch(e){throw err('別の画面でExcel出力中です。そちらを終了してください。','LEDGER_BUSY');}
   const prior=[],partial=[];for await(const [name,h] of j.ns.entries()){
    if(!/^job-[a-f0-9-]{36}$/i.test(name)||h.kind!=='directory')continue;
    try{await h.getFileHandle(READY);prior.push(name);}catch(e){if(e.name!=='NotFoundError')throw e;partial.push(name);}
   }
   const acknowledged=new Set(Array.isArray(msg.ack)?msg.ack:[]);
   if(prior.some(id=>!acknowledged.has(id))){const e=err('前回のExcelが一時保存されています。','LEDGER_PREVIOUS');e.prior=prior;throw e;}
   for(const id of [...partial,...prior])await j.ns.removeEntry(id,{recursive:true});
   j.dirName='job-'+crypto.randomUUID();j.dir=await j.ns.getDirectoryHandle(j.dirName,{create:true});
   j.handle=await j.dir.getFileHandle('ledger.xlsx',{create:true});j.output=await j.handle.createSyncAccessHandle();await j.output.truncate(0);
   j.writer=root.SentlogOriginalPhotoZip.createWriter({write:b=>writeAll(j,b)});return {};
  }
  async function add(msg){const j=job;if(!j?.writer||!(msg.blob instanceof Blob))throw err('Excelの構成部品を確認できません。','LEDGER_WRITE');
   if(typeof msg.path!=='string'||root.SentlogOriginalPhotoZip.safePath(msg.path)!==msg.path||j.names.has(msg.path.toLowerCase()))throw err('Excelの構成部品が重複または不正です。','LEDGER_WRITE');
   if(j.pos+msg.blob.size>MAX_BYTES)throw err('ExcelのZIP容量上限に近づきました。出力対象を分けてください。','LEDGER_LIMIT');
   const added=await j.writer.add({path:msg.path,blob:msg.blob,modifiedAt:0});if(added.path!==msg.path)throw err('Excel内のファイル名が一致しません。','LEDGER_WRITE');j.names.add(msg.path.toLowerCase());return {};
  }
  async function finish(){const j=job;if(!j?.writer||!j.names.has('[content_types].xml')||!j.names.has('xl/workbook.xml'))throw err('Excelの構成が不足しています。','LEDGER_WRITE');
   const result=await j.writer.close();if(result.zip64)throw err('ExcelのZIP容量上限を超えました。','LEDGER_LIMIT');
   await j.output.flush();await j.output.close();j.output=null;const f=await j.handle.getFile();if(f.size!==j.pos||BigInt(f.size)!==result.byteLength)throw err('Excelの一時保存が完了していません。','LEDGER_WRITE');
   // Preserve a flushed output across page/worker failure until explicit acknowledgement.
   await j.dir.getFileHandle(READY,{create:true});await cleanup(false);return {file:f};
  }
  root.onmessage=async event=>{const m=event.data||{};if(busy)return;busy=true;try{const result=await (m.op==='start'?start(m):m.op==='add'?add(m):m.op==='finish'?finish():Promise.reject(err('不明な出力操作です。')));root.postMessage({id:m.id,ok:true,...result});}catch(e){try{await cleanup(true);}catch(_){}root.postMessage({id:m.id,ok:false,code:e?.name==='QuotaExceededError'?'LEDGER_SPACE':e?.code||'LEDGER_EXPORT',message:e?.name==='QuotaExceededError'?'Excel出力用の端末空き容量が不足しています。元の写真・記録は変更していません。':String(e?.message||e),prior:e?.prior});}finally{busy=false;}};
  return;
 }
 const refs=new WeakSet();
 const valid=x=>x instanceof Uint8Array&&x.length>0||!!x&&typeof x==='object'&&refs.has(x);
 const photo=(read,label,progress)=>{const p=Object.freeze({read,label,progress});refs.add(p);return p;};
 function image(src){return new Promise((resolve,reject)=>{const im=new Image();const timer=setTimeout(()=>{im.onload=im.onerror=null;im.src='';reject(err('写真の読み込みが時間内に完了しませんでした。'));},20000);im.onload=()=>{clearTimeout(timer);im.onload=im.onerror=null;resolve(im);};im.onerror=()=>{clearTimeout(timer);im.onload=im.onerror=null;reject(err('写真を読み込めません。'));};im.src=src;});}
 function dataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader(),t=setTimeout(()=>{r.abort();reject(err('写真の読み込みが時間内に完了しませんでした。'));},20000);r.onload=()=>{clearTimeout(t);resolve(r.result);};r.onerror=()=>{clearTimeout(t);reject(r.error||err('写真を読み込めません。'));};r.readAsDataURL(blob);});}
 async function isPlainJpeg(blob,w,h){
  if(!/^image\/jpe?g$/i.test(blob.type)||blob.size<4||w*3!==h*4)return false;
  const b=new Uint8Array(await blob.slice(0,262144).arrayBuffer()),end=new Uint8Array(await blob.slice(-2).arrayBuffer());
  if(b[0]!==255||b[1]!==216||end[0]!==255||end[1]!==217)return false;
  let i=2,dimension=false;while(i+3<b.length){if(b[i++]!==255)return false;while(b[i]===255)i++;const marker=b[i++];if(marker===218)return dimension;if(marker===225||marker===217)return false;const n=b[i]*256+b[i+1];if(n<2||i+n>b.length)return false;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(n<8||b[i+3]*256+b[i+4]!==h||b[i+5]*256+b[i+6]!==w)return false;dimension=true;}i+=n;
  }return false;
 }
 async function jpeg(blob,signal){check(signal);if(!(blob instanceof Blob)||!blob.size)throw err('写真データがありません。');let im,cv;const url=URL.createObjectURL(blob);
  try{try{im=await image(url);}catch(e){check(signal);im=await image(await dataUrl(blob));}check(signal);const w=im.naturalWidth,h=im.naturalHeight;if(!w||!h)throw err('写真の寸法が不正です。');
   if(await isPlainJpeg(blob,w,h)){check(signal);return blob;}
   const u=Math.max(Math.ceil(w/4),Math.ceil(h/3)),cw=4*u,ch=3*u;if(cw*ch>MAX_PIXELS)throw err('写真が大きすぎます。元画像の解像度は変更していません。','LEDGER_IMAGE_LIMIT');
   cv=document.createElement('canvas');cv.width=cw;cv.height=ch;const ctx=cv.getContext('2d');if(!ctx)throw err('写真の変換機能を利用できません。');ctx.fillStyle='#fff';ctx.fillRect(0,0,cw,ch);ctx.drawImage(im,Math.floor((cw-w)/2),Math.floor((ch-h)/2),w,h);
   const out=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(err('写真のJPEG変換が時間内に完了しませんでした。')),20000);cv.toBlob(b=>{clearTimeout(t);b?resolve(b):reject(err('写真のJPEG変換に失敗しました。'));},'image/jpeg',.95);});check(signal);return out;
  }finally{if(cv){cv.width=1;cv.height=1;}if(im)im.src='';URL.revokeObjectURL(url);}
 }
 async function zip(files,{signal,confirmPrevious=()=>false}={}){
  check(signal);if(typeof Worker!=='function'||typeof navigator.storage?.getDirectory!=='function')throw err('このブラウザーでは高画質Excelの一時保存を利用できません。PCまたは最新版ブラウザーをご利用ください。','LEDGER_OPFS');
  const worker=new Worker(new URL('photo-ledger-stream.js?v='+TOKEN,document.baseURI),{name:'sentlog-ledger-stream'});let id=0,pending=null,fatal=null;
  const fail=e=>{if(pending)pending.reject(e);};const onAbort=()=>fail(err('Excel出力を中止しました。元の写真・記録は変更していません。','LEDGER_CANCEL'));
  signal?.addEventListener('abort',onAbort);worker.onmessage=e=>{const m=e.data;if(!pending||m?.id!==pending.id)return;if(m.ok)pending.resolve(m);else pending.reject(Object.assign(err(m.message,m.code),{prior:m.prior}));};
  worker.onerror=e=>{e.preventDefault?.();fatal=err('Excel出力の処理が停止しました。元の写真・記録は変更していません。');fail(fatal);};
  const ask=async(op,values={})=>{check(signal);if(fatal)throw fatal;const n=++id;let t;try{return await new Promise((resolve,reject)=>{pending={id:n,resolve,reject};t=setTimeout(()=>reject(err('Excel書き出しが時間内に完了しませんでした。')),120000);worker.postMessage({id:n,op,...values});});}finally{clearTimeout(t);pending=null;}};
  try{
   try{await ask('start');}catch(e){if(e.code!=='LEDGER_PREVIOUS'||!Array.isArray(e.prior)||!confirmPrevious())throw e;await ask('start',{ack:e.prior});}
   let count=0;const total=files.filter(([,v])=>refs.has(v)).length;
   for(const [path,v] of files){check(signal);let blob;if(refs.has(v)){
    v.progress?.(++count,total);try{blob=await jpeg(await v.read(),signal);}catch(e){if(e.code==='LEDGER_CANCEL')throw e;throw err('写真を1枚取得・変換できません。Excel出力を停止しました：'+v.label+'（'+e.message+'）',e.code);}
   }else blob=v instanceof Blob?v:new Blob([v]);
   await ask('add',{path,blob});blob=null;
   }
   const result=await ask('finish');check(signal);if(!(result.file instanceof Blob)||!result.file.size)throw err('Excelの完成ファイルを確認できません。');return new File([result.file],'ledger.xlsx',{type:TYPE});
  }finally{signal?.removeEventListener('abort',onAbort);worker.terminate();}
 }
 root.SentlogLedgerStream={version:TOKEN,valid,photo,jpeg,zip};
})(globalThis);

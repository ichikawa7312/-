"""Sentlog v1.93: safe drawing replacement and record-loss sync guard.

A background/PDF replacement must never clear annotations or photo links. If a
recorded drawing's page structure changes, replacement is blocked and the user
must add it as a new sheet/drawing instead. The source PDF is still replaced only
after a durable local state backup is written.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:
        raise RuntimeError(f'Safe-replace integration mismatch: {path}: {old[:100]!r}: {s.count(old)}')
    p.write_text(s.replace(old,new))

# Allow a one-deep durable state backup per drawing before background replacement.
p='sentlog/record-store.js'
change(p,
       "const managed=k=>k.startsWith('sentlogSyncMergeCheckpointV1:') ||",
       "const managed=k=>k.startsWith('sentlogReplaceBackupV1:') || k.startsWith('sentlogSyncMergeCheckpointV1:') ||")

# Replace the destructive legacy handler. Existing shapes/photos remain in state
# throughout openFile(), so intermediate persist() calls cannot sync an empty drawing.
p='sentlog/part09.txt'
old="""$('fileInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(!activeDrawingId){e.target.value='';return}state.shapes=[];state.nextGlobalNo=1;state.typeCounters={};state.pageSettings={};state.pdfPageInfo={};state.pageRotations={};selected=null;$('globalNo').value='未採番';$('typeNo').value='未採番';state.currentPage=1;clearAllHistory();await openFile(f,true);e.target.value=''};"""
new=r"""async function inspectReplacementFile(file){
  const isPDF=file.type==='application/pdf'||/\.pdf$/i.test(file.name||'');
  if(isPDF){
    if(!window.pdfjsLib)throw Error('PDF表示エンジンを読み込めません。');
    const buf=await file.arrayBuffer(),doc=await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise,info={};
    try{
      for(let n=1;n<=doc.numPages;n++){
        const page=await doc.getPage(n),intrinsic=normalizeRotation(page.rotate||0),v=page.getViewport({scale:1,rotation:intrinsic});
        info[String(n)]={wMm:v.width*25.4/72,hMm:v.height*25.4/72};
      }
      return {sourceType:'pdf',pageCount:doc.numPages,pdfPageInfo:info};
    }finally{try{await doc.destroy?.()}catch{}}
  }
  const url=URL.createObjectURL(file);
  try{
    const size=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(Error('画像を読み取れません。'));image.src=url;});
    return {sourceType:'image',pageCount:1,...size};
  }finally{URL.revokeObjectURL(url)}
}
function replacementRecordSummary(value=state){
  const shapes=value.shapes||[],photos=shapes.reduce((n,s)=>n+(s.photos?.length||0),0);
  return {shapes:shapes.length,photos,pages:new Set(shapes.map(s=>Number(s.page)||1))};
}
function replacementFrameCompatible(previous,probe){
  if(previous.sourceType!==probe.sourceType)return {ok:false,reason:'図面の種類（PDF／画像）が変わります。'};
  if(Number(previous.pageCount||1)!==Number(probe.pageCount||1))return {ok:false,reason:'ページ数が '+(previous.pageCount||1)+' → '+probe.pageCount+' に変わります。'};
  if(previous.sourceType==='pdf'){
    const records=replacementRecordSummary(previous);
    for(const page of records.pages){
      const a=previous.pdfPageInfo?.[String(page)],b=probe.pdfPageInfo?.[String(page)];
      if(!a||!b)continue;
      const dw=Math.abs(Number(a.wMm)-Number(b.wMm)),dh=Math.abs(Number(a.hMm)-Number(b.hMm));
      if(dw>1||dh>1)return {ok:false,reason:page+'ページ目の用紙寸法が変わります。'};
    }
  }else if(Number(previous.width)>0&&Number(previous.height)>0&&(Math.abs(Number(previous.width)-probe.width)>1||Math.abs(Number(previous.height)-probe.height)>1)){
    return {ok:false,reason:'画像サイズが変わります。'};
  }
  return {ok:true};
}
$('fileInput').onchange=async e=>{
  const f=e.target.files[0];if(!f)return;if(!activeDrawingId){e.target.value='';return}
  const previous=JSON.parse(JSON.stringify(state)),summary=replacementRecordSummary(previous);
  try{
    const probe=await inspectReplacementFile(f);
    if(summary.shapes||summary.photos){
      const compatible=replacementFrameCompatible(previous,probe);
      if(!compatible.ok){
        alert('この図面には記録があるため、安全に差し替えできません。\n\n'+compatible.reason+'\n\n記録と写真は変更していません。新しいPDFは「この図面No.に追加」から別シートとして登録してください。');
        return;
      }
      if(!confirm('この図面には変状・記録 '+summary.shapes+'件、写真 '+summary.photos+'枚があります。\n\n記録・写真・縮尺設定を残したまま背景PDFだけ差し替えます。\n元の記録は削除しません。\n\n差し替えますか？'))return;
    }
    const backupKey='sentlogReplaceBackupV1:'+activeDrawingId;
    window.SentlogRecords.setItem(backupKey,JSON.stringify({savedAt:new Date().toISOString(),drawingId:activeDrawingId,state:previous}));
    await window.SentlogRecords.flush();
    if(summary.shapes||summary.photos){
      state.pageStates={};
      state.pdfPageInfo={};
      state.currentPage=Math.min(Math.max(1,Number(previous.currentPage)||1),probe.pageCount);
      selected=null;drawing=null;clearAllHistory();
    }else{
      state.shapes=[];state.nextGlobalNo=1;state.typeCounters={};state.pageSettings={};state.pdfPageInfo={};state.pageRotations={};state.pageStates={};selected=null;
      $('globalNo').value='未採番';$('typeNo').value='未採番';state.currentPage=1;clearAllHistory();
    }
    await openFile(f,true);
    rebuildNumberingState();render();renderSelectedPhotos();persist();
  }catch(err){
    console.error('drawing replacement',err);
    alert('図面の差し替えを中止しました。記録と写真は変更していません。\n'+(err?.message||err));
  }finally{e.target.value=''}
};"""
change(p,old,new)

# A second device must not accept an incoming PDF replacement that also drops
# records/photos. This protects an intact offline device from a destructive cloud state.
p='sentlog/sync-view.js'
old="""    const oldProject=ws.projects.find(p=>p.id===id);"""
new=old+"""
    const incomingDrawings=snapshot.payload.drawings||[];
    for(const oldMeta of oldProject?.drawings||[]){
      const before=read(oldMeta.id),incomingItem=incomingDrawings.find(d=>(d.meta?.id||d.state?.id)===oldMeta.id),after=incomingItem?.state;
      if(!before||!after)continue;
      const beforeShapes=Array.isArray(before.shapes)?before.shapes:[],afterShapes=Array.isArray(after.shapes)?after.shapes:[];
      const beforePhotos=beforeShapes.reduce((n,s)=>n+(s.photos?.length||0),0),afterPhotos=afterShapes.reduce((n,s)=>n+(s.photos?.length||0),0);
      const frameChanged=before.sourceType!==after.sourceType||before.fileName!==after.fileName||Number(before.pageCount||1)!==Number(after.pageCount||1);
      if(frameChanged&&(afterShapes.length<beforeShapes.length||afterPhotos<beforePhotos))
        return {applied:false,reason:'record-loss-guard'};
    }"""
change(p,old,new)

# Release/cache markers.
p='sentlog/index.html'
change(p,'phone-runtime.js?v=192','phone-runtime.js?v=193',2)
change(p,"['phone-runtime.js?v=193','v1.92']","['phone-runtime.js?v=193','v1.93']")
change('sentlog/phone-runtime.js','v1.92','v1.93',4)
change('sentlog-pc/index.html','v1.92','v1.93',1)
change('sentlog/sw.js','sentlog-pwa-v203','sentlog-pwa-v204')

for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.py','.cjs'):continue
    s=f.read_text();u=s.replace("'v1.92'","'v1.93'").replace('phone-runtime.js?v=192','phone-runtime.js?v=193').replace(r'phone-runtime\.js\?v=192',r'phone-runtime\.js\?v=193').replace('sentlog-pwa-v203','sentlog-pwa-v204')
    if u!=s:f.write_text(u)

subprocess.run(['node','--check','sentlog/sync-view.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/safe_replace.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.93: recorded drawing replacement preserves records/photos and guards peer devices')

"""Sentlog v2.03: protect page-replaced PDFs from stale device uploads.

Runs after all existing build stages. A page replacement records the completed
PDF hash going forward. Existing v1.98 replacements are migrated safely by
using the latest replacement timestamp and File.lastModified as a one-time
authority hint, so the final replacement wins over older open tabs/devices.
"""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path
    s=p.read_text()
    n=s.count(old)
    if n!=count:
        raise RuntimeError(f'PDF revision guard integration mismatch {path}: {old[:100]!r}: {n}')
    p.write_text(s.replace(old,new))

p=ROOT/'sentlog/cloud-sync.js'
s=p.read_text()

anchor="""function drawingState(id){
  try{return JSON.parse(window.SentlogRecords.getItem(DRAWING_KEY_PREFIX+id)||'null')}catch{return null}
}
"""
helpers=r"""function normalizePdfHash(value){
  const h=String(value||'').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h)?h:'';
}
function latestPdfRevisionFromState(st){
  const markers=st?.pageReplacements;
  if(!markers||typeof markers!=='object'||Array.isArray(markers))return null;
  let best=null;
  for(const [page,value] of Object.entries(markers)){
    if(!value||typeof value!=='object')continue;
    const updatedAt=Number(value.updatedAt)||0;
    if(!updatedAt)continue;
    if(!best||updatedAt>best.updatedAt){
      best={
        page:Number(page)||0,
        updatedAt,
        pdfHash:normalizePdfHash(value.pdfHash),
        pdfSize:Number(value.pdfSize)||0,
        restored:!!value.restored
      };
    }
  }
  return best;
}
function resolvePdfVersion(revision,localHash,remoteHash,hasLocal,canReplace,localLastModified=0){
  localHash=normalizePdfHash(localHash);remoteHash=normalizePdfHash(remoteHash);
  if(localHash&&localHash===remoteHash)return 'same';
  if(!hasLocal)return 'take-remote';
  const expected=normalizePdfHash(revision?.pdfHash);
  if(expected){
    if(localHash===expected&&remoteHash!==expected)return 'local-authoritative';
    if(remoteHash===expected&&localHash!==expected)return canReplace?'take-remote':'block';
    return 'conflict';
  }
  const updatedAt=Number(revision?.updatedAt)||0;
  const localModified=Number(localLastModified)||0;
  if(updatedAt&&localModified&&localModified>=updatedAt-30000)return 'local-authoritative';
  return canReplace?'take-remote':'block';
}
function expectedDrawingRevision(id){return latestPdfRevisionFromState(drawingState(id))}
"""
if s.count(anchor)!=1:
    raise RuntimeError('drawingState anchor mismatch: '+str(s.count(anchor)))
s=s.replace(anchor,anchor+helpers,1)

old_global="let syncTimer=null;"
new_global="let syncTimer=null;\nconst drawingUploadBlocks=new Set();"
if s.count(old_global)!=1: raise RuntimeError('sync global anchor mismatch')
s=s.replace(old_global,new_global,1)

old_pull="""        const local=await dbGet(key);
        let same=false;
        if(local instanceof Blob && local.size===Number(a.byte_size)){
          same=(await sha256Hex(local)).toLowerCase()===String(a.sha256).toLowerCase();
        }
        if(!same){
          if(local instanceof Blob && local.size && window.sentlogSyncView && !window.sentlogSyncView.canReplaceDrawing(drawingId))continue;
          const file=await downloadPrivateAsset(a);await dbPut(key,file);received++;
          await window.sentlogSyncView?.fileReceived(drawingId,file);
        }
        if(a.source_device_id!==deviceId)await ackAsset(a.id,deviceId);"""
new_pull="""        const local=await dbGet(key);
        const remoteHash=normalizePdfHash(a.sha256);
        const revision=expectedDrawingRevision(drawingId);
        let localHash='',same=false;
        if(local instanceof Blob && local.size===Number(a.byte_size)){
          localHash=(await sha256Hex(local)).toLowerCase();
          same=localHash===remoteHash;
        }
        if(!same){
          if(!localHash&&revision&&local instanceof Blob&&local.size)localHash=(await sha256Hex(local)).toLowerCase();
          const hasLocal=local instanceof Blob&&!!local.size;
          const canReplace=!hasLocal||!window.sentlogSyncView||window.sentlogSyncView.canReplaceDrawing(drawingId);
          const decision=resolvePdfVersion(revision,localHash,remoteHash,hasLocal,canReplace,local instanceof File?local.lastModified:0);
          if(decision==='local-authoritative')continue;
          if(decision==='block'||decision==='conflict'){drawingUploadBlocks.add(drawingId);continue;}
          const file=await downloadPrivateAsset(a);await dbPut(key,file);received++;
          await window.sentlogSyncView?.fileReceived(drawingId,file);
        }
        if(a.source_device_id!==deviceId)await ackAsset(a.id,deviceId);"""
if s.count(old_pull)!=1:
    raise RuntimeError('drawing pull guard anchor mismatch: '+str(s.count(old_pull)))
s=s.replace(old_pull,new_pull,1)

pattern=r"(async function uploadDrawing\(cloudProject,deviceId,item,knownAssets\)\{\n  const key='background:'\+item\.drawingId;\n  let blob=await dbGet\(key\);\n  if\(!\(blob instanceof Blob\)\)return \{status:'missing'\};)"
m=re.search(pattern,s)
if not m: raise RuntimeError('uploadDrawing anchor mismatch')
upload_guard=r"""
  const revision=expectedDrawingRevision(item.drawingId);
  if(revision){
    const localHash=(await sha256Hex(blob)).toLowerCase();
    const expectedHash=normalizePdfHash(revision.pdfHash);
    if(expectedHash&&localHash!==expectedHash){
      drawingUploadBlocks.add(item.drawingId);
      return {status:'blocked-stale'};
    }
    if(!expectedHash&&revision.updatedAt){
      const known=knownAssets?.get('drawing:'+item.drawingId);
      const remoteHash=normalizePdfHash(known?.sha256);
      const recentLocal=blob instanceof File&&Number(blob.lastModified)>0&&Number(blob.lastModified)>=Number(revision.updatedAt)-30000;
      if(localHash!==remoteHash&&!recentLocal){
        drawingUploadBlocks.add(item.drawingId);
        return {status:'blocked-stale'};
      }
    }
  }"""
s=s[:m.end()]+upload_guard+s[m.end():]

old_sync="""  syncing=true;
  const statusCycle=syncStatus.begin();"""
new_sync="""  syncing=true;
  drawingUploadBlocks.clear();
  const statusCycle=syncStatus.begin();"""
if s.count(old_sync)!=1: raise RuntimeError('sync start anchor mismatch')
s=s.replace(old_sync,new_sync,1)

old_loop="""      for(const item of collectDrawings(lp)){
        try{"""
new_loop="""      for(const item of collectDrawings(lp)){
        if(drawingUploadBlocks.has(item.drawingId))continue;
        try{"""
if s.count(old_loop)!=1: raise RuntimeError('drawing upload loop anchor mismatch')
s=s.replace(old_loop,new_loop,1)

old_status="""    else if(pulled.conflicts)syncStatus.finish(statusCycle,{level:'error',label:'変更を要確認',message:'同じ案件がこの端末と別の端末で変更されています。どちらも自動では上書きしていません。'});"""
new_status="""    else if(drawingUploadBlocks.size)syncStatus.finish(statusCycle,{level:'pending',label:'PDF更新待ち',message:'別端末で更新されたPDFを保護しています。古いPDFはクラウドへ送信しません。図面を閉じると最新版を受信できます。'});
    else if(pulled.conflicts)syncStatus.finish(statusCycle,{level:'error',label:'変更を要確認',message:'同じ案件がこの端末と別の端末で変更されています。どちらも自動では上書きしていません。'});"""
if s.count(old_status)!=1: raise RuntimeError('sync status anchor mismatch')
s=s.replace(old_status,new_status,1)

p.write_text(s)

# Force clients to request the revised sync module.
idx=ROOT/'sentlog/index.html'
x=idx.read_text()
old_version='cloud-sync.js?v=20261020-review-186'
new_version='cloud-sync.js?v=20261025-pdf-revision-203'
if x.count(old_version)!=2:
    raise RuntimeError('cloud sync loader version mismatch: '+str(x.count(old_version)))
idx.write_text(x.replace(old_version,new_version))

# Advance the service worker cache after every prior build step.
sw=ROOT/'sentlog/sw.js'
w=sw.read_text()
m=re.search(r'sentlog-pwa-v(\d+)',w)
if not m: raise RuntimeError('service worker cache version missing')
old_cache=m.group(0);new_cache='sentlog-pwa-v'+str(int(m.group(1))+1)
w=w.replace(old_cache,new_cache);sw.write_text(w)

for t in (ROOT/'tests').iterdir():
    if t.suffix not in ('.cjs','.py') or t.name=='pdf_revision_guard.test.cjs': continue
    q=t.read_text()
    u=q.replace(old_cache,new_cache)
    u=u.replace(old_version,new_version)
    u=u.replace(r'cloud-sync\.js\?v=20261020-review-186',r'cloud-sync\.js\?v=20261025-pdf-revision-203')
    if u!=q:t.write_text(u)

subprocess.run(['node','--check','sentlog/cloud-sync.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/page_replacement.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/pdf_revision_guard.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v2.03: newest page-replaced PDF wins; stale open devices cannot overwrite it')

"""v1.86: review conflicting records and reduce large-survey network requests."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Sync review integration mismatch: {path}: {old[:100]}')
    p.write_text(s.replace(old,new))
p='sentlog/cloud-sync.js'
replace(p,'async function rest(path,opts={}){',(ROOT/'sentlog/sync-network-runtime.txt').read_text()+'\nasync function rest(path,opts={}){')
replace(p,"  const r=await fetch(SUPABASE_URL+path,{\n    ...opts,\n    headers:headers({'Content-Type':'application/json',...(opts.headers||{})})\n  });\n  const txt=await r.text();", "  const {response:r,text:txt}=await readSyncResponse(path,opts);")
replace(p,'storageFolder,metadata,capturedAt}){','storageFolder,metadata,capturedAt,knownAssets}){')
replace(p,'  const existing=await existingAsset(clientKey);',
        "  let existing=knownAssets?.get(clientKey);\n  if(!existing||existing.kind!==kind||String(existing.sha256).toLowerCase()!==hash||Number(existing.byte_size)!==blob.size)\n    existing=await existingAsset(clientKey);")
replace(p,'async function uploadPhoto(cloudProject,deviceId,item){','async function uploadPhoto(cloudProject,deviceId,item,knownAssets){')
replace(p,"    cloudProject,deviceId,clientKey:'photo:'", "    cloudProject,deviceId,knownAssets,clientKey:'photo:'")
replace(p,'async function uploadDrawing(cloudProject,deviceId,item){','async function uploadDrawing(cloudProject,deviceId,item,knownAssets){')
replace(p,"    cloudProject,deviceId,clientKey:'drawing:'", "    cloudProject,deviceId,knownAssets,clientKey:'drawing:'")
replace(p,'      if(!snap.skipped)uploaded++;\n      for(const item',
        "      if(!snap.skipped)uploaded++;\n      const knownAssets=new Map((await readProjectAssets(cp.id,'client_key,kind,sha256,byte_size,status,storage_path')).map(a=>[a.client_key,a]));\n      for(const item")
replace(p,'await uploadDrawing(cp,deviceId,item);','await uploadDrawing(cp,deviceId,item,knownAssets);')
replace(p,'await uploadPhoto(cp,deviceId,item);','await uploadPhoto(cp,deviceId,item,knownAssets);')
replace('sentlog/index.html','sync-merge.js?v=181','sync-merge.js?v=186',2)
replace('sentlog/index.html',"['sync-merge.js?v=186','verifiedPdfPageCounts']","['sync-merge.js?v=186','recordChoiceKey']")
replace('sentlog/index.html','cloud-sync.js?v=20261020-assets-185','cloud-sync.js?v=20261020-review-186',2)
replace('sentlog/index.html',"['cloud-sync.js?v=20261020-review-186','readProjectAssets']","['cloud-sync.js?v=20261020-review-186','sentlogRecordReview']")
replace('sentlog/index.html','phone-runtime.js?v=185','phone-runtime.js?v=186',2)
replace('sentlog/index.html','photo-recovery.js?v=141','photo-recovery.js?v=186',2)
replace('sentlog-pc/index.html','photo-recovery.js?v=143','photo-recovery.js?v=186')
replace('sentlog-pc/index.html','v1.43 · 写真再送ループ対策','v1.86 · 写真再取得の全件確認')
replace('sentlog/index.html',"['phone-runtime.js?v=186','v1.85']","['phone-runtime.js?v=186','v1.86']")
replace('sentlog/phone-runtime.js','v1.85','v1.86',4)
replace('sentlog/sw.js','sentlog-pwa-v196','sentlog-pwa-v197')
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.85'","SENTLOG_BUILD==='v1.86'").replace("'v1.85'","'v1.86'").replace('sentlog-pwa-v196','sentlog-pwa-v197')
    for name,old,new in [('phone-runtime','185','186'),('sync-merge','181','186'),('cloud-sync','20261020-assets-185','20261020-review-186')]:
        updated=updated.replace(f'{name}.js?v={old}',f'{name}.js?v={new}').replace(rf'{name}\.js\?v={old}',rf'{name}\.js\?v={new}')
    updated=updated.replace('photo-recovery.js?v=143','photo-recovery.js?v=186').replace('photo-recovery.js?v=141','photo-recovery.js?v=186').replace('v1.43 · 写真再送ループ対策','v1.86 · 写真再取得の全件確認')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.86: equivalent rotations, verified ancestor/manual review, batched asset checks and bounded read retries')

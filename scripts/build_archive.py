"""Apply the reviewed archive additions to the v1.32 static app at build time.

Inputs remain the original application files; guarded transformations fail closed
if a future edit changes an integration point. No user data is read by this build.
v1.34 changes only archive-click feedback and its release/cache markers.
"""
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]

def change(path: str, old: str, new: str, count: int = 1) -> None:
    p = ROOT / path
    s = p.read_text()
    if s.count(old) != count:
        raise RuntimeError(f'Archive integration point changed: {path}: {old[:70]!r}')
    p.write_text(s.replace(old, new))

# Guard the original synchronizer versions, rather than patch unknown future code.
for path, expected in {
    'sentlog/cloud-sync.js': 'b55678435627b3823cce77839b3e26ddbc0367c6',
    'sentlog/pdf-recovery.js': 'c1da1f2fabc8b35358930d67df289dd8dd15646a',
    'sentlog-pc/index.html': 'b684cbdb8a25d6e629acd0861353b005e0f87dee',
}.items():
    data = (ROOT / path).read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if actual != expected:
        raise RuntimeError(f'Unexpected baseline: {path}: {actual}')

p = 'sentlog/cloud-sync.js'
change(p,"const syncStatus=createSyncStatusView();","/* archive-v133: server-controlled project lifecycle; no automatic archive transfer. */\nconst syncStatus=createSyncStatusView();\nconst archive=window.SentlogArchive;\nif(!archive)throw Error('保管機能が未更新です。通信できる場所で画面を更新してください。');")
change(p,"async function pullRemoteProjects(deviceId){", "async function pullRemoteProjects(deviceId,manualProject=null){")
change(p,"sentlog_projects?status=eq.active&select=id,name,client_key,updated_at", "sentlog_projects?select=id,name,status,client_key,updated_at")
change(p,"    if(!cp.client_key)continue;", "    if(!cp.client_key||!archive.canSync(cp,manualProject))continue;")
change(p,"async function syncNow(){", "async function syncNow(options={}){\n  const manualProject=options?.manualProject||null;")
change(p,"    const pulled=await pullRemoteProjects(deviceId);", "    await archive.refresh();\n    const pulled=await pullRemoteProjects(deviceId,manualProject);")
change(p,"    for(const lp of ws.projects||[]){\n      const cp=await ensureCloudProject(lp);", "    for(const lp of ws.projects||[]){\n      if(!archive.includeLocal(lp.id,manualProject))continue;\n      const cp=await ensureCloudProject(lp);\n      if(!archive.canSync(cp,manualProject)||cp.status==='archived')continue;")
with (ROOT/p).open('a') as out:
    out.write("\nwindow.sentlogArchiveSync=syncNow;\n")

p = 'sentlog/pdf-recovery.js'
change(p,"  const s=session(),id=device();", "  const archive=window.SentlogArchive;\n  if(!IS_PC && !archive?.ready)return;\n  const s=session(),id=device();")
change(p,"    const pending=(assets||[]).filter(a=>a.metadata?.drawing_id && needed.has(a.id+':'+String(a.sha256).toLowerCase()));", "    const states=IS_PC?await api('rpc/sentlog_archive_v1',{p_action:'list'}):null;\n    const allowed=pid=>IS_PC?states.some(c=>c.id===pid&&c.status==='active'&&!c.checking):archive.isAuto(pid);\n    const pending=(assets||[]).filter(a=>allowed(a.project_id)&&a.metadata?.drawing_id && needed.has(a.id+':'+String(a.sha256).toLowerCase()));")
change(p,"      if(!a.metadata?.drawing_id || !ids.has(a.metadata.drawing_id))continue;", "      if(!allowed(a.project_id)||!a.metadata?.drawing_id || !ids.has(a.metadata.drawing_id))continue;")
change(p,"else status(total?'PDF：この端末に '+available+' / '+total+' 件保存済み（内容照合済み）。':'PDF：同期対象の図面を確認しています。');", "else { status(total?'PDF：この端末に '+available+' / '+total+' 件保存済み（内容照合済み）。':'使用中のPDFに再取得待ちはありません。'); }\n    // Hide only successful status; never suppress missing/error warnings.\n    for(const panel of panels())panel.hidden=!(errors||missing||differentNames.length);")
change(p,"for(const box of panels()){box.replaceChildren();", "for(const box of panels()){box.hidden=false;box.replaceChildren();")

p = 'sentlog-pc/index.html'
change(p,"async function pendingAssets(){", "async function pendingAssets(){\n  const states=await rest('/rest/v1/rpc/sentlog_archive_v1',{method:'POST',body:JSON.stringify({p_action:'list'})});")
change(p,"  $('pendingCount').textContent=q?.length||0;return q||[]", "  const active=(q||[]).filter(a=>states.some(c=>c.id===a.project_id&&c.status==='active'&&!c.checking));\n  $('pendingCount').textContent=active.length;return active;")
change(p,'v1.26 · PDF再配信対応','v1.33 · 案件一式の保管確認')
change(p,'<script type="module" src="../sentlog/pdf-recovery.js?v=126"></script>', '<script src="../sentlog/archive-core.js?v=133"></script>\n<script src="../sentlog/archive-pc.js?v=133"></script>\n<script type="module" src="../sentlog/pdf-recovery.js?v=133"></script>')

p = 'sentlog/index.html'
change(p,'phone-runtime.js?v=132','phone-runtime.js?v=134',2)
change(p,"'v1.32'","'v1.34'",2) # phone and storage preflight tokens
change(p,"['storage-ui.js?v=132','v1.34']", "['storage-ui.js?v=132','v1.32'],['archive-core.js?v=133','SentlogArchiveCore'],['archive.js?v=134','v1.34 archive']")
change(p,'cloud-sync.js?v=20261008-storage-130','cloud-sync.js?v=20261008-archive-133',2)
change(p,"'await window.sentlogAppReady'],['sync-view.js", "'archive-v133'],['sync-view.js")
change(p,'pdf-recovery.js?v=130','pdf-recovery.js?v=133',2)
# The loader injects escaped script end tags into document.write.
needle='<script type="module" src="./cloud-sync.js?v=20261008-archive-133">'
change(p,needle,'<script src="./archive-core.js?v=133"><\\/script><script src="./archive.js?v=134"><\\/script>'+needle)
p = 'sentlog/phone-runtime.js'
s = (ROOT/p).read_text()
if s.count('v1.32') != 4:
    raise RuntimeError('Unexpected build-version markers')
(ROOT/p).write_text(s.replace('v1.32','v1.34'))
p = 'sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v145';", "const CACHE='sentlog-pwa-v147';")
change(p,"'record-store.js','storage-ui.js'", "'archive-core.js','archive.js','record-store.js','storage-ui.js'")
print('Built Sentlog v1.34 archive click fix: no local deletion operations')

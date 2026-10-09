"""Integrate v1.36 into the checked v1.34 archive build. No user data access.
Run AFTER build_archive.py. Hash guards deliberately reject an unknown baseline.
"""
from pathlib import Path
import hashlib
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Management integration point changed: {path}: {old[:60]!r}')
 p.write_text(s.replace(old,new))
BASELINES={'sentlog/archive-core.js': '6766715dc6e868e908cddb1d09fad2d5122738ec36dc3398a9d5b7240dff6132', 'sentlog/archive.js': 'd925aa2b069e18a6100aae0e303d441594863b2bef7afc15cb85c1e8e5cf6e64', 'sentlog/cloud-sync.js': 'f487e9e7b89bd772ab1d7b1ad70d839ab7b7b5684d19214c9b5b1c9a1c45da49', 'sentlog-pc/index.html': 'ff7ebea9c5856b2767ff640f87f97ab73123386d2be99ddcaf84aa390dd109e3', 'sentlog/pdf-recovery.js': 'bac74fe72d06ed952dd90584ed315c9e8efb21d5b9dfa17782bdddeea9fc1fac', 'sentlog/index.html': 'a8c78aea4526c1723e50a5c609d7a836562a26756b035c10047a290ba331357e', 'sentlog/phone-runtime.js': '744250073945b9a05a810bebebfd199469fc5259fc57cee85b69a6eb068ff2dc', 'sentlog/sw.js': 'd303a3540793c3cfc4564833e80eec2280fe8603687b1a852e156dd94a89e93d'}
for path,expected in BASELINES.items():
 if hashlib.sha256((ROOT/path).read_bytes()).hexdigest()!=expected:
  raise RuntimeError('Unexpected v1.34 build: '+path)

p='sentlog/archive-core.js'
change(p,'if(!control||control.checking)return false;','if(!control||control.checking||control.retired)return false;')
p='sentlog/archive.js'
change(p,'/* v1.34 archive stage 1.','/* v1.35 archive stage 1.')
change(p,'  async function manual(cp){\n',"  async function manual(cp){\n    if(cp.retired)throw Error('使用終了の案件は同期しません。再利用する場合は、確認のうえ使用中に戻してください。');\n")
change(p,'  async function reopen(cp){\n',"  async function reopen(cp){\n    if(cp.retired){if(!window.SentlogManagement)throw Error('管理機能を更新してください。');return window.SentlogManagement.resume(cp);}\n")
change(p,"if(!getProject(p.id)){if(!cp)throw Error('案件を確認できません。');await manual(cp);}","if(!getProject(p.id)){if(!cp)throw Error('案件を確認できません。');if(cp.retired)throw Error('この端末に残っている記録はありません。使用終了の案件は自動で取得しません。');await manual(cp);}")
change(p,"archiveView?'保管中・手動同期／端末データは保持':'自動同期'","cp?.retired?'使用終了（不要）／残存データは保持・一式保管は未確認':archiveView?'保管中・手動同期／端末データは保持':'自動同期'")
change(p,"if(archiveView){actions.append(createButton('この案件を手動同期',()=>action(()=>manual(cp))),createButton('使用中に戻す',()=>action(()=>reopen(cp))));}\n        else actions.append(createButton(cp?.checking?'保管を確認':'保管へ移す',()=>action(()=>start(p))));", "if(archiveView){if(!cp?.retired)actions.append(createButton('この案件を手動同期',()=>action(()=>manual(cp))));actions.append(createButton('使用中に戻す',()=>action(()=>reopen(cp))));}\n        else {\n          actions.append(createButton(cp?.checking?'保管を確認':'保管へ移す',()=>action(()=>start(p))));\n          actions.append(createButton('使用終了にする',()=>action(async()=>{if(!window.SentlogManagement)throw Error('管理機能を更新してください。');await window.SentlogManagement.retire(p);})));\n        }")
change(p,"const label=document.createElement('span');label.textContent=c.checking?", "const label=document.createElement('span');label.textContent=c.retired?'使用終了（不要）。残っている記録は閲覧できます。一式のバックアップ確認済みではありません。':c.checking?")
p='sentlog/cloud-sync.js'
change(p, "    try{\n      const q=await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id)+'&select=id,active');", "    {\n      const q=await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id)+'&select=id,active');\n      if(q?.[0]&&q[0].active!==true)throw Error('この端末登録は停止中です。「設定 → 登録端末」で再開してください。');")
change(p, "    }catch{}\n  }\n  const body={p_device_name:deviceName(),p_device_type:deviceType()};", "    }\n  }\n  const body={p_device_name:deviceName(),p_device_type:deviceType()};")
with (ROOT/p).open('a') as out:out.write('\nwindow.sentlogManagementSession=ensureSession;\n')
p='sentlog-pc/index.html'
change(p,"  if(id){try{const q=await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id)+'&select=id,active');if(q?.[0]?.active)return id}catch{}}", "  if(id){const q=await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id)+'&select=id,active');if(q?.[0]){if(q[0].active!==true)throw Error('このPC同期の登録は停止中です。セントログの「設定 → 登録端末」で再開してください。');await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_seen_at:new Date().toISOString()})});return id;}}")
change(p,"    await ensureSession();if(!(await permission()))", "    await ensureSession();await ensureDevice();if(!(await permission()))")
change(p,"catch(e){saveSession(null);log('再ログインが必要です')}","catch(e){log('接続確認: '+e.message)}")
change(p,'v1.33 · 案件一式の保管確認','v1.35 · 案件一式の保管確認')
change(p,'archive-core.js?v=133','archive-core.js?v=135')
change(p,'pdf-recovery.js?v=133','pdf-recovery.js?v=135')
p='sentlog/pdf-recovery.js'
change(p,"  try{\n    const assets=await api('sentlog_assets?", "  try{\n    const registration=await api('sentlog_devices?id=eq.'+enc(id)+'&select=id,active');\n    if(!registration?.[0]||registration[0].active!==true){status('この端末登録は停止中、または未確認です。セントログの「設定 → 登録端末」を確認してください。');return;}\n    const assets=await api('sentlog_assets?")
p='sentlog/index.html'
for old,new in [('phone-runtime.js?v=134','phone-runtime.js?v=136'),('archive-core.js?v=133','archive-core.js?v=135'),('archive.js?v=134','archive.js?v=135'),('pdf-recovery.js?v=133','pdf-recovery.js?v=135'),('cloud-sync.js?v=20261008-archive-133','cloud-sync.js?v=20261009-management-135')]:change(p,old,new,2)
change(p,"'v1.34'","'v1.36'")
change(p,"['archive.js?v=135','v1.34 archive']","['archive.js?v=135','v1.35 archive'],['management.js?v=136','v1.36 management']")
change(p,'<script src="./archive.js?v=135"><\\/script>', '<script src="./archive.js?v=135"><\\/script><script src="./management.js?v=136"><\\/script>')
p='sentlog/phone-runtime.js';change(p,'v1.34','v1.36',4)
p='sentlog/sw.js';change(p,"const CACHE='sentlog-pwa-v147';","const CACHE='sentlog-pwa-v149';")
change(p,"'archive-core.js','archive.js','record-store.js'","'archive-core.js','archive.js','management.js','record-store.js'")
print('Built Sentlog v1.36: stopped registrations can leave list; no local/file/history deletion')

change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.34'","window.SENTLOG_BUILD==='v1.36'")

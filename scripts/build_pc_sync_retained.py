"""Final PC-sync guard for retained active-project drawing PDFs.

Runs after the existing Sentlog build chain. It changes only the PC sync page:
- already PC-verified drawing PDFs in active projects stay in Supabase for mobile use,
  but are not counted/processed again by PC auto sync;
- an Edge Function "retained" response is not counted as a cloud deletion.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'sentlog-pc/index.html'
s = path.read_text()

old_filter = "  const active=(q||[]).filter(a=>states.some(c=>c.id===a.project_id&&c.status==='active'&&!c.checking));"
new_filter = "  const active=(q||[]).filter(a=>states.some(c=>c.id===a.project_id&&c.status==='active'&&!c.checking)&&!(a.kind==='drawing'&&a.status==='pc_verified'));"
if s.count(old_filter) != 1:
    raise RuntimeError('PC sync pending filter integration point changed')
s = s.replace(old_filter, new_filter)

old_delete = """  const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||j.detail||'クラウド削除失敗');
  deletedCount++;$('deletedCount').textContent=deletedCount;log('Supabase一時ファイル削除: '+a.file_name)"""
new_delete = """  const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||j.detail||'クラウド削除失敗');
  if(j.retained){log('PC同期済み・クラウド保持: '+a.file_name);return}
  deletedCount++;$('deletedCount').textContent=deletedCount;log('Supabase一時ファイル削除: '+a.file_name)"""
if s.count(old_delete) != 1:
    raise RuntimeError('PC sync retained-response integration point changed')
s = s.replace(old_delete, new_delete)

path.write_text(s)
print('Built PC sync retained-drawing guard: cloud PDF kept, PC loop skipped')

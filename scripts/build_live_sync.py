"""Apply focused live-editor synchronization safety adjustments after all guarded builders.

The original files are checksum-guarded by build_archive.py, so this step runs
only after all build-time transformations have completed. It never touches
production user data, backups, Supabase tables, or IndexedDB content.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def replace(path,old,new):
    target=ROOT/path
    source=target.read_text(encoding='utf-8')
    count=source.count(old)
    if count!=1:
        raise RuntimeError(f'Live sync integration mismatch: {path}, count={count}, anchor={old[:100]!r}')
    target.write_text(source.replace(old,new),encoding='utf-8')

replace('sentlog/sync-view.js',
    """    if(focus && focus.matches('input,select,textarea,[contenteditable="true"]'))return true;""",
    """    // Focus by itself is not a pending edit. Check the saved inspector fields
    // below, but retain the guard for unknown inputs and contenteditable.
    if(focus && focus.matches('input,select,textarea,[contenteditable="true"]')){
      const safeFields=['damageType','member','memo','lineWidth','globalNo','typeNo','frRecordMemo'];
      if(focus.isContentEditable||!safeFields.includes(focus.id))return true;
    }""")

replace('sentlog/sync-view.js',
    "    if(loading.style.display==='grid')return true;",
    "    if(loading.style.display==='grid')return true;\n    if(window.SentlogFieldRecords?.isMemoEditing?.())return true;")

replace('sentlog/sync-view.js',
    "      const expected={damageType:s.type||'腐食',member:s.member||'',memo:s.memo||'',lineWidth:String(s.strokeWidth||1.2)};",
    """      // Survey points have their own memo editor. Hidden damage controls
      // retain old values and must not indefinitely defer incoming comments.
      const expected=(s.recordKind==='field-record'||s.kind==='field-record')?
        {frRecordMemo:s.memo||''}:
        {damageType:s.type||'腐食',member:s.member||'',memo:s.memo||'',lineWidth:String(s.strokeWidth||1.2)};""")

replace('sentlog/cloud-sync.js',
    """    else if(pulled.blocked.size)syncStatus.finish(statusCycle,{level:'pending',label:'作業後に反映',message:'操作中の変更は保留しています。入力・描画を終えると次の同期で反映します。PDFの差し替えや削除は図面を閉じた後に反映します。'});""",
    """    else if(pulled.blocked.size)syncStatus.finish(statusCycle,{level:'pending',label:'一部反映待ち',
      message:'安全確認のため '+pulled.blocked.size+' 件の案件が反映待ちです。保留対象以外の案件は引き続き同期します。編集中の記録は端末内に保存したまま保護し、操作が落ち着いたら再確認します。同じ記録の競合は確認が必要です。'});""")

for file in ('sentlog/sync-view.js','sentlog/cloud-sync.js'):
    subprocess.run(['node','--check',file],cwd=ROOT,check=True)
print('Built Sentlog live-editor sync: settled field-record memo receives updates; unfinished text and composition stay protected')

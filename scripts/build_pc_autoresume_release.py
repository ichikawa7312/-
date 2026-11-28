"""Safely resume explicitly enabled PC synchronization after reloading Edge.

Install only after the complete v2.21 production build.  Do not change photo
or PDF bytes, server calls, cloud cleanup conditions, or filesystem writes.
Background ticks query permission but never request it without user gesture.
"""
from pathlib import Path
import subprocess
import re

ROOT=Path(__file__).resolve().parents[1]
path=ROOT/'sentlog-pc/index.html'
text=path.read_text(encoding='utf-8')


def change(old,new,count=1):
    global text
    actual=text.count(old)
    if actual!=count:
        raise RuntimeError(f'PC auto-resume anchor mismatch: {old[:140]!r}: {actual}/{count}')
    text=text.replace(old,new)


change('let session=null, rootHandle=null, timer=null, busy=false, savedCount=0, deletedCount=0;',
       "const PC_AUTO_SYNC_PREF='sentlogPcAutoSyncEnabledV1';\nlet session=null, rootHandle=null, timer=null, busy=false, savedCount=0, deletedCount=0;")
change("""function start(){if(timer)return;syncOnce();timer=setInterval(syncOnce,5000);setSync('自動同期ON','ok');refreshUI();log('自動同期を開始')}
function stop(){if(timer){clearInterval(timer);timer=null}setSync('停止中');refreshUI();log('自動同期を停止')}""",
"""async function pcFolderGranted(){
  if(!rootHandle||typeof rootHandle.queryPermission!=='function')return false;
  try{return (await rootHandle.queryPermission({mode:'readwrite'}))==='granted';}catch{return false;}
}
async function autoSyncOnce(){
  if(busy||document.hidden||!navigator.onLine||!session)return;
  if(!await pcFolderGranted()){
    setSync('PC保管先の許可待ち：保存許可を確認してください','warn');return;
  }
  await syncOnce();
}
async function start(userInitiated=false){
  if(timer)return;
  try{
    if(!session||!rootHandle)throw Error('ログインとPCの保存先を確認してください');
    // Only an explicit click may open the browser's permission dialog.
    const permitted=userInitiated?await permission():await pcFolderGranted();
    if(!permitted){setSync('PC保管先の許可が必要です。保存許可を確認してください','warn');return;}
    if(userInitiated)localStorage.setItem(PC_AUTO_SYNC_PREF,'1');
    timer=setInterval(()=>{void autoSyncOnce()},15000);
    setSync('PC自動同期ON（登録済みファイルを順次保管）','ok');
    refreshUI();log('PC自動同期を開始');
    void autoSyncOnce();
  }catch(error){setSync('PC同期開始の確認が必要です：'+error.message,'err');log('PC自動同期の開始を保留: '+error.message);}
}
function stop(){
  if(timer){clearInterval(timer);timer=null;}
  try{localStorage.setItem(PC_AUTO_SYNC_PREF,'0');}catch(error){log('自動同期停止設定の保存を確認できません: '+error.message);}
  setSync('停止中');refreshUI();log('自動同期を停止');
}
async function resumeAutoSync(){
  if(localStorage.getItem(PC_AUTO_SYNC_PREF)!=='1'||timer||!session||!rootHandle)return;
  if(!await pcFolderGranted()){setSync('自動同期の再開待ち：PCの保存許可を確認してください','warn');return;}
  await start(false);
}""")
change("await ensureSession();await ensureDevice();if(!(await permission()))throw Error('保存先フォルダへの書き込み許可が必要です');",
       "await ensureSession();await ensureDevice();if(!(await pcFolderGranted()))throw Error('保存先フォルダへの書き込み許可が必要です');")
change("setSync(remaining.length?'未完了：PC処理待ち '+remaining.length+'件'+(problems?'（今回の処理保留 '+problems+'件）':''):'PC同期完了：未処理データはありません',remaining.length?'warn':'ok');",
       "setSync(remaining.length?'未完了：PC処理待ち '+remaining.length+'件'+(problems?'（今回の処理保留 '+problems+'件）':''):'クラウド登録済みファイルのPC処理完了（端末から未送信のファイルは未確認）',remaining.length?'warn':'ok');")
change("$('permissionBtn').onclick=permission;$('startBtn').onclick=start;$('stopBtn').onclick=stop;$('onceBtn').onclick=syncOnce;",
       "$('permissionBtn').onclick=async()=>{if(await permission())await resumeAutoSync()};"
       "$('startBtn').onclick=()=>start(true);$('stopBtn').onclick=stop;"
       "$('onceBtn').onclick=async()=>{if(await permission())await syncOnce()};")
change("window.addEventListener('online',()=>{if(timer)syncOnce()});window.addEventListener('offline',()=>setSync('オフライン待機','warn'));",
       "window.addEventListener('online',()=>{if(timer)void autoSyncOnce()});"
       "window.addEventListener('offline',()=>setSync('オフライン待機','warn'));"
       "window.addEventListener('pageshow',()=>{if(timer)void autoSyncOnce()});"
       "document.addEventListener('visibilitychange',()=>{if(!document.hidden&&timer)void autoSyncOnce()});")
change("await updateFolder();log('保存先を選択: '+rootHandle.name)",
       "await updateFolder();log('保存先を選択: '+rootHandle.name);await resumeAutoSync()")
change("saveSession(j);await ensureDevice();log('ログインしました')",
       "saveSession(j);await ensureDevice();log('ログインしました');await resumeAutoSync()")
change("  log('PC同期画面を起動しました');",
       "  await resumeAutoSync();\n  log('PC同期画面を起動しました');")

path.write_text(text,encoding='utf-8')
inline=re.findall(r'<script(?:\s[^>]*)?>(.*?)</script\s*>',text,re.S|re.I)
if not inline:raise RuntimeError('PC sync scripts not found after release')
for script in inline:
    if script.strip():
        subprocess.run(['node','--check'],input=script,text=True,check=True,cwd=ROOT)
print('PC sync: opt-in automatic resume, no background permission prompts; unregistered files never marked verified')

"""Install per-project recovery controls and release the isolated sync worker.

Run after all production builders. This changes static resources only; local
records, original files and the database safety guards keep their formats.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261119-project-sync-1'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Project sync integration changed: {path}: {old[:90]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


cloud = (ROOT / 'sentlog/cloud-sync.js').read_text(encoding='utf-8')
if 'project-sync-controls-v1' in cloud:
    raise RuntimeError('Project sync is already built; use a pristine production build')
if 'collaboration-sync-v1' not in cloud:
    raise RuntimeError('Build project sync after collaborative synchronization')
controls = (ROOT / 'sentlog/project-sync-controls.txt').read_text(encoding='utf-8').strip()
change('sentlog/cloud-sync.js', 'function modalHtml(){', controls + '\n\nfunction modalHtml(){')
change('sentlog/cloud-sync.js',
       '        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudSyncNow"',
       '        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #d1d5db">'
       '<label for="sentlogSyncProjectSelect" style="font-size:13px">案件を選んで同期</label>'
       '<select id="sentlogSyncProjectSelect" style="display:block;width:100%;min-height:40px;margin-top:6px"></select>'
       '<button type="button" id="sentlogSyncProjectNow" style="width:100%;min-height:40px;margin-top:8px">この案件だけ同期</button>'
       '<p style="font-size:12px;color:#4b5563;margin:6px 0 0">新しく作った案件も個別に同期できます。</p></div>\n'
       '        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudSyncNow"')
change('sentlog/cloud-sync.js',
       "  document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow({force:true})};",
       "  document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow({force:true})};\n"
       "  document.getElementById('sentlogSyncProjectNow').onclick=syncSelectedProject;")
change('sentlog/cloud-sync.js', 'function updateCloudUI(){', 'function updateCloudUI(){\n  renderProjectSyncControls();')

# Both bootstrap references and the preflight marker change together so an old
# cached worker cannot satisfy the new loader after an interrupted app update.
index = (ROOT / 'sentlog/index.html').read_text(encoding='utf-8')
versions = re.findall(r'cloud-sync\.js\?v=([A-Za-z0-9._-]+)', index)
if len(versions) != 2 or len(set(versions)) != 1:
    raise RuntimeError('Expected matching cloud-sync bootstrap references')
old_token = versions[0]
change('sentlog/index.html', 'cloud-sync.js?v=' + old_token, 'cloud-sync.js?v=' + TOKEN, 2)
change('sentlog/index.html', "'collaboration-sync-v1'", "'project-sync-controls-v1'")
worker = (ROOT / 'sentlog/sw.js').read_text(encoding='utf-8')
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Offline cache revision missing')
old_cache = match.group(0)
new_cache = 'sentlog-pwa-v' + str(int(match.group(1)) + 1)
pending['sentlog/sw.js'] = worker.replace(old_cache, new_cache)
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    source = file.read_text(encoding='utf-8')
    revised = source.replace(old_cache, new_cache)
    revised = revised.replace('cloud-sync.js?v=' + old_token, 'cloud-sync.js?v=' + TOKEN)
    revised = revised.replace(r'cloud-sync\.js\?v=' + old_token, r'cloud-sync\.js\?v=' + TOKEN)
    if revised != source:
        pending[str(file.relative_to(ROOT))] = revised
for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
# Run PC outage safeguards only after strict pristine-source checks and all
# other generators. Do not alter the source PC page or change any record format.
pc_path = ROOT / 'sentlog-pc/index.html'
pc_page = pc_path.read_text(encoding='utf-8')
if pc_page.count('timer=setInterval(syncOnce,5000)') != 1:
    raise RuntimeError('PC scan interval integration changed')
pc_page = pc_page.replace('timer=setInterval(syncOnce,5000)',
                          'timer=setInterval(syncOnce,60000)')
pc_page = pc_page.replace('約5秒ごとに確認します', '約60秒ごとに確認します')
if 'function pcServiceUnavailable(e)' not in pc_page:
    pc_helpers = '''// A Data API outage must not trigger repeated full inventory scans.
let pcRetryAfter=0,pcFailureStreak=0;
function pcServiceUnavailable(e){
  const message=String(e?.message||e||'');
  return /(?:^|\\D)(?:500|502|503|504|522|524)(?:\\D|$)|PGRST00[0-3]|57014|timeout|timed out|connection|network|Failed to fetch|通信が.*切れ|接続.*失敗/i.test(message);
}
function pcScheduleBackoff(e){
  if(!pcServiceUnavailable(e))return false;
  pcFailureStreak=Math.min(6,pcFailureStreak+1);
  const delay=Math.min(300000,30000*Math.pow(2,pcFailureStreak-1));
  pcRetryAfter=Date.now()+delay;
  log('クラウド接続不調：ファイルを保持し、'+Math.ceil(delay/1000)+'秒後以降に再確認します。');
  return true;
}
'''
    if pc_page.count('async function syncOnce(){') != 1:
        raise RuntimeError('PC synchronization integration changed')
    pc_page = pc_page.replace('async function syncOnce(){', pc_helpers+'async function syncOnce(){')
    old = "if(busy)return;busy=true;setSync('同期中…','busy');"
    if pc_page.count(old) != 1:
        raise RuntimeError('PC retry gate integration changed')
    pc_page = pc_page.replace(old, "if(busy||Date.now()<pcRetryAfter)return;busy=true;setSync('同期中…','busy');")
    if "if(e.code==='REAUTH_REQUIRED'||e.code==='SESSION_CHANGED')throw e;" in pc_page:
        pc_page=pc_page.replace("if(e.code==='REAUTH_REQUIRED'||e.code==='SESSION_CHANGED')throw e;",
            "if(e.code==='REAUTH_REQUIRED'||e.code==='SESSION_CHANGED'||pcServiceUnavailable(e))throw e;")
        pc_page=pc_page.replace('  const remaining=await pendingAssets();',
            '  const remaining=await pendingAssets();\\n  pcFailureStreak=0;pcRetryAfter=0;')
        pc_page=pc_page.replace("}catch(e){setSync('同期は完了していません：'+e.message,'err');log('同期確認: '+e.message)}",
            "}catch(e){pcScheduleBackoff(e);setSync('同期は完了していません：'+e.message,'err');log('同期確認: '+e.message)}")
    else:
        pc_page=pc_page.replace("}catch(e){log('処理待ち: '+(a.file_name||a.id)+' / '+e.message)}",
            "}catch(e){log('処理待ち: '+(a.file_name||a.id)+' / '+e.message);if(pcServiceUnavailable(e))throw e}")
        pc_page=pc_page.replace("    setSync(list.length?'同期完了':'新しいデータはありません','ok')",
            "    pcFailureStreak=0;pcRetryAfter=0;\\n    setSync(list.length?'同期完了':'新しいデータはありません','ok')")
        pc_page=pc_page.replace("}catch(e){setSync('同期エラー: '+e.message,'err');log('同期エラー: '+e.message)}",
            "}catch(e){pcScheduleBackoff(e);setSync('同期エラー: '+e.message,'err');log('同期エラー: '+e.message)}")
if 'pcRetryAfter' not in pc_page or 'pcServiceUnavailable' not in pc_page:
    raise RuntimeError('PC outage guard not present in output')
pc_path.write_text(pc_page, encoding='utf-8')

subprocess.run(['node', '--check', 'sentlog/cloud-sync.js'], cwd=ROOT, check=True)
print('Built isolated project synchronization and local-project recovery controls')

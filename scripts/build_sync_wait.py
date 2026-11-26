"""v2.02: bounded modal observation and visible, scoped synchronization stages.

Run after the complete v2.01 build. No stored data or server schema changes.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-sync-wait-202'
MARKER = 'sentlog-sync-wait-v202'


def replace(source, old, new, count=1):
    if source.count(old) != count:
        raise RuntimeError('Sync wait integration changed: ' + old[:100])
    return source.replace(old, new)


path = ROOT / 'sentlog/cloud-sync.js'
cloud = path.read_text(encoding='utf-8')
if MARKER in cloud:
    raise RuntimeError('Sync wait integration requires a pristine build')
cloud = replace(cloud, 'const syncStatus=createSyncStatusView();',
                "const syncStatus=attachSyncWorkStatus(createSyncStatusView());")
cloud = "import {attachSyncWorkStatus} from './sync-work-status.js?v=" + TOKEN + "';\n" + cloud
cloud = replace(cloud, 'sync-status.js?v=189', 'sync-status.js?v=' + TOKEN)
start = cloud.index('async function downloadPrivateAsset(asset){')
end = cloud.index('async function ackAsset(', start)
old = cloud[start:end]
if 'const blob=await syncStatus.track(' not in old or 'return await r.blob();' not in old or 'SHA-256照合NG' not in old:
    raise RuntimeError('Unexpected original-file download implementation')
cloud = cloud[:start] + (ROOT / 'sentlog/bounded-asset-download.txt').read_text().strip() + '\n' + cloud[end:]

cloud = replace(cloud,
    '  await window.sentlogAppReady;await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();context.assertCurrent();',
    "  context.report('アプリの準備を待っています');await window.sentlogAppReady;\n"
    "  context.report('端末への保存が終わるのを待っています');await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();context.assertCurrent();")
cloud = replace(cloud,
    '  await ensureSession();context.assertCurrent();const deviceId=await ensureDevice();context.assertCurrent();',
    "  context.report('ログインと端末情報を確認しています');await ensureSession();context.assertCurrent();const deviceId=await ensureDevice();context.assertCurrent();")
cloud = replace(cloud,
    '  await collaborationRefreshArchive(context);const cps=await collaborationProjects(ids,context)',
    "  context.report('同期する案件の一覧を確認しています');await collaborationRefreshArchive(context);const cps=await collaborationProjects(ids,context)")
cloud = replace(cloud,
    'async function collaborationFileRound(ids,context){',
    "async function collaborationFileRound(ids,context){\n  context.report('記録の確認が終わるのを待っています');")

# Report the real per-project stage immediately before its original awaits.
# Only these two round functions have a local `id` and a scoped observer.
for function_name, next_function in [
    ('collaborationMetadataRound', 'collaborationCollectPhotos'),
    ('collaborationFileRound', None),
]:
    start = cloud.index('async function ' + function_name + '(')
    end = cloud.index('function ' + next_function + '(', start) if next_function else cloud.index('const collaborationMetadataWorker=', start)
    section = cloud[start:end]
    section, count = re.subn(r"stage='([^']+)';", r"stage='\1';context.report(stage,id);", section)
    if count < 4:
        raise RuntimeError('Missing per-project sync stages: ' + function_name)
    if function_name == 'collaborationFileRound':
        section = replace(section, '    await window.SentlogRecords.settled();',
                          "    context.report('端末への保存が終わるのを待っています');await window.SentlogRecords.settled();")
    cloud = cloud[:start] + section + cloud[end:]

observer = '''async function collaborationObservedRound(kind,ids,context,run){
  let work;try{work=syncStatus.beginWork?.(kind,kind==='metadata'?'記録の確認を開始しています':'図面・写真の確認を開始しています');}catch{}
  const report=(description,id=null)=>{
    try{
      if(!context.current())return;
      const name=id?(workspace().projects.find(project=>project.id===id)?.name||[...knownCloudProjects.values()].find(project=>project.client_key===id)?.name||'案件'):null;
      work?.update(name?'「'+name+'」：'+description:description,id);
    }catch{}
  };
  try{return await run(ids,{...context,report});}finally{try{work?.finish();}catch{}}
}
'''
cloud = replace(cloud, 'const collaborationMetadataWorker=', observer + 'const collaborationMetadataWorker=')
cloud = replace(cloud, 'run:collaborationMetadataRound,', "run:(ids,context)=>collaborationObservedRound('metadata',ids,context,collaborationMetadataRound),")
cloud = replace(cloud, 'run:collaborationFileRound,', "run:(ids,context)=>collaborationObservedRound('files',ids,context,collaborationFileRound),")
path.write_text('// ' + MARKER + '\n' + cloud, encoding='utf-8')

# Do not let a prior orange warning look like the stage currently in progress.
path = ROOT / 'sentlog/sync-status.js'
status = path.read_text(encoding='utf-8')
status = replace(status, "(outcome.message || '')", "((running?'前回の結果：':'')+(outcome.message || ''))")
path.write_text('// ' + MARKER + '\n' + status, encoding='utf-8')
path = ROOT / 'sentlog/delta-sync-app-migration.js'
path.write_text('// ' + MARKER + '\n' + path.read_text(encoding='utf-8'), encoding='utf-8')

changes = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    for name in ['cloud-sync', 'delta-sync-app-migration']:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        changes.update((name, prior) for prior in re.findall(pattern, source))
        source = re.sub(pattern, name + '.js?v=' + TOKEN, source)
        source = re.sub(r"\['" + name + r"\.js\?v=" + TOKEN + r"','[^']+'\]",
                        "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']", source)
    if filename == 'sentlog/index.html':
        source = replace(source, 'const deps=[',
            "const deps=[['sync-work-status.js?v=" + TOKEN + "','attachSyncWorkStatus'],['sync-status.js?v=" + TOKEN + "','" + MARKER + "'],")
    source = source.replace('phone-runtime.js?v=201', 'phone-runtime.js?v=202')
    source = source.replace('v2.01', 'v2.02').replace('同期が止まった図面の確認・復旧', '同期の待機状況・進行表示')
    path.write_text(source, encoding='utf-8')
path = ROOT / 'sentlog/phone-runtime.js'
path.write_text(path.read_text(encoding='utf-8').replace('v2.01', 'v2.02'), encoding='utf-8')
path = ROOT / 'sentlog/sw.js'
source = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', source).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
source = replace(source, "'sync-status.js'", "'sync-status.js','sync-work-status.js'")
path.write_text(source.replace(old_cache, new_cache), encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    original = path.read_text(encoding='utf-8')
    source = original.replace(old_cache, new_cache).replace("'v2.01'", "'v2.02'")
    source = source.replace('phone-runtime.js?v=201', 'phone-runtime.js?v=202').replace(r'phone-runtime\.js\?v=201', r'phone-runtime\.js\?v=202')
    source = source.replace('v2.01 · 同期が止まった図面の確認・復旧', 'v2.02 · 同期の待機状況・進行表示')
    for name, prior in changes:
        source = source.replace(name + '.js?v=' + prior, name + '.js?v=' + TOKEN)
        source = source.replace(name + r'\.js\?v=' + prior, name + r'\.js\?v=' + TOKEN)
    if source != original:
        path.write_text(source, encoding='utf-8')

for name in ['cloud-sync', 'sync-status', 'sync-work-status', 'delta-sync-app-migration']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
for test in ['project_sync_controls', 'sync_status_pending', 'sync_work_status', 'asset_download_budget', 'drawing_resume_wait']:
    subprocess.run(['node', 'tests/' + test + '.test.cjs'], cwd=ROOT, check=True)
print('Built v2.02: bounded UI observation, original-file download deadlines and scoped progress; ' + new_cache)

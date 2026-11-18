"""Separate metadata CAS rounds from serialized original-file transfers.

Run after build_edit_sync.py and the collaboration model merge builder. All
original asset verification remains in place; this is a final cloud-module pass.
"""
from pathlib import Path
import subprocess
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'sentlog/cloud-sync.js'
source = PATH.read_text(encoding='utf-8')
TOKEN = '20261118-collaboration-sync-1'
runtime = (ROOT / 'sentlog/collaboration-sync-runtime.txt').read_text(encoding='utf-8')


def update_loader():
    path = ROOT / 'sentlog/index.html'
    html = path.read_text(encoding='utf-8')
    versions = re.findall(r'cloud-sync\.js\?v=([0-9A-Za-z._-]+)', html)
    if len(versions) != 2 or len(set(versions)) != 1:
        raise RuntimeError('Collaboration cloud loader must have two matching versioned references')
    old = versions[0]
    html = html.replace('cloud-sync.js?v=' + old, 'cloud-sync.js?v=' + TOKEN)
    if old != TOKEN:
        if html.count("'edit-sync-v20261118'") != 1:
            raise RuntimeError('Collaboration cloud preflight marker changed')
        html = html.replace("'edit-sync-v20261118'", "'collaboration-sync-v1'")
    if html.count("'collaboration-sync-v1'") != 1:
        raise RuntimeError('Collaboration cloud preflight marker missing')
    path.write_text(html, encoding='utf-8')
    for test in (ROOT / 'tests').iterdir():
        if test.suffix not in ('.cjs', '.py'):
            continue
        value = test.read_text(encoding='utf-8')
        next_value = value.replace('cloud-sync.js?v=' + old, 'cloud-sync.js?v=' + TOKEN)
        next_value = next_value.replace(r'cloud-sync\.js\?v=' + old, r'cloud-sync\.js\?v=' + TOKEN)
        if next_value != value:
            test.write_text(next_value, encoding='utf-8')


if '/* collaboration-sync-v1:' in source:
    installed = source[source.index('/* collaboration-sync-v1:'):source.index('\nloadSession();editSyncSessionChanged();')]
    if installed.strip() != runtime.strip():
        raise RuntimeError('Collaboration runtime changed: rebuild from a fresh source checkout')
    update_loader()
    print('Collaboration synchronization already installed and loader verified')
    raise SystemExit(0)


def change(old, new, count=1):
    global source
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Collaboration sync anchor changed: {old[:110]!r}; expected {count}, found {actual}')
    source = source.replace(old, new)


def region(start, end, replacement):
    global source
    if source.count(start) != 1 or source.count(end) != 1:
        raise RuntimeError(f'Collaboration sync region changed: {start!r}')
    begin = source.index(start)
    finish = source.index(end, begin)
    source = source[:begin] + replacement.rstrip() + '\n' + source[finish:]


change('  const {response:r,text:txt}=await readSyncResponse(path,opts);',
       "  const requestOptions=path.startsWith('/rest/v1/sentlog_project_snapshots')&&opts.method&&opts.method!=='GET'?"
       "{...opts,headers:{...(opts.headers||{}),'x-client-info':'sentlog-collaboration/1'}}:opts;\n"
       '  const {response:r,text:txt}=await readSyncResponse(path,requestOptions);')
change("  if(!r.ok)throw new Error(data?.message||data?.msg||data?.error_description||String(data||r.status));",
       "  if(!r.ok)throw Object.assign(new Error(data?.message||data?.msg||data?.error_description||String(data||r.status)),{status:r.status,code:data?.code});")
region('async function ensureDevice(){', '\nfunction openDB(){',
       'async function ensureDevice(){return collaborationEnsureDevice();}')
region('function projectSnapshot(localProject){', '\nasync function upsertSnapshot(',
       'function projectSnapshot(localProject){return collaborationProjectSnapshot(localProject);}')
# The old upsert/pull combined functions are removed so no second metadata writer
# or asset pipeline can accidentally be entered through a legacy call site.
region('async function upsertSnapshot(', '\nfunction collectPhotos(', '')
region('async function pullRemoteProjects(', '\nasync function syncNow(', '')
region('async function syncNow(options={}){', '\n// Integrated in the cloud module by build_sync_merge.py;',
       'async function syncNow(options={}){return collaborationSyncNow(options);}')
change('async function checkMergeFiles(cp,local,remote){',
       'async function checkMergeFiles(cp,local,remote,base){\n'
       '  if(base&&collaborationCanSkipFileCheck(local,remote,base))return {};\n'
       '  return checkMergeFilesLegacy(cp,local,remote);\n}\n'
       'async function checkMergeFilesLegacy(cp,local,remote){')
change('  const verifiedPdfPageCounts=await checkMergeFiles(cp,local,remote);',
       '  const verifiedPdfPageCounts=await checkMergeFiles(cp,local,remote,verifiedBase);')
change('async function tryMergeProject(cp,snap,{manual=false,review=null}={}){',
       'async function tryMergeProject(cp,snap,{manual=false,review=null}={}){\n  const mergeOwner=session?.user?.id;')
change('  const committed=await window.sentlogSyncView.mergeCommit(',
       '  collaborationAssertOwner(mergeOwner);\n  const committed=await window.sentlogSyncView.mergeCommit(')
change('!window.sentlogImporting&&!syncing&&!mergeBusy;', '!window.sentlogImporting&&!mergeBusy;')
change('  editSyncOwner=owner;knownCloudProjects.clear();editSync.reset();syncHeads.reset();',
       '  editSyncOwner=owner;knownCloudProjects.clear();editSync.reset();syncHeads.reset();collaborationSessionChanged();')
change('function wakeEditSync(){editSync.wake();syncHeads.wake();}',
       'function wakeEditSync(){editSync.wake();syncHeads.wake();collaborationWake();}')
# Retained worker scopes own retries; a revision notification is not considered
# applied merely because the revision watcher has already notified it once.
change('window.sentlogCloudIdle=async()=>{const deadline=',
       'window.sentlogCloudIdle=async()=>{if(window.sentlogImporting||mergeBusy){collaborationMetadataWorker.releaseWaiters();collaborationFileWorker.releaseWaiters();}const deadline=')
change('while(syncing){if(Date.now()>deadline)',
       'while(syncing||collaborationMetadataWorker.running||collaborationFileWorker.running){if(Date.now()>deadline)')
# Account changes during file hashing/network waits must not commit an old
# account's bytes or acknowledgements into the current account's records.
change('async function dbPut(key,value){return window.putDBFile(key,value);}',
       'async function dbPut(key,value){if(collaborationAssetOwner)collaborationAssertOwner(collaborationAssetOwner);return window.putDBFile(key,value);}')
change('async function uploadAsset({cloudProject,deviceId,clientKey,kind,fileName,blob,storageFolder,metadata,capturedAt,knownAssets}){',
       'async function uploadAsset({cloudProject,deviceId,clientKey,kind,fileName,blob,storageFolder,metadata,capturedAt,knownAssets}){\n'
       '  const assetOwner=collaborationAssetOwner||session?.user?.id;collaborationAssertOwner(assetOwner);')
change("  const isDxf=kind==='drawing' && (", "  collaborationAssertOwner(assetOwner);\n  const isDxf=kind==='drawing' && (")
change("  const storagePath=session.user.id+'/'+cloudProject.id+'/'", "  const storagePath=assetOwner+'/'+cloudProject.id+'/'")
change("  if(!up.ok)throw new Error('ファイル送信に失敗: '+await up.text());",
       "  collaborationAssertOwner(assetOwner);\n  if(!up.ok)throw new Error('ファイル送信に失敗: '+await up.text());")
change('  }catch(e){\n    const dup=await existingAsset(clientKey).catch(()=>null);',
       '  }catch(e){\n    collaborationAssertOwner(assetOwner);\n    const dup=await existingAsset(clientKey).catch(()=>null);')
change('    owner_id:session.user.id,project_id:cloudProject.id,source_device_id:deviceId,',
       '    owner_id:assetOwner,project_id:cloudProject.id,source_device_id:deviceId,')
change("        if(a.source_device_id!==deviceId)await ackAsset(a,deviceId,!same);",
       "        if(collaborationAssetOwner)collaborationAssertOwner(collaborationAssetOwner);\n        if(a.source_device_id!==deviceId)await ackAsset(a,deviceId,!same);")
change('\nloadSession();editSyncSessionChanged();', '\n' + runtime + '\nloadSession();editSyncSessionChanged();')
# Check the complete transformed ES module before changing the build tree.
with tempfile.NamedTemporaryFile(mode='w', suffix='.mjs', encoding='utf-8') as check:
    check.write(source)
    check.flush()
    subprocess.run(['node', '--check', check.name], check=True)
PATH.write_text(source, encoding='utf-8')
update_loader()
print('Installed independent record and file synchronization workers')

"""On iOS, avoid loading every stored cutoff Blob at boot and doing inactive sync cleanup.

Run only after the complete v2.18 build. Does not change the durable schema,
assets, writer ownership, pending outbox, or data deletion predicates.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_TOKEN = '20261128-iphone-lazy-records-218'
TOKEN = '20261128-iphone-cutoff-memory-219'
OLD_MARKER = 'sentlog-iphone-lazy-records-v218'
MARKER = 'sentlog-iphone-cutoff-memory-v219'
OLD_LABEL = 'v2.18 · iPhoneの記録読込を分割'
LABEL = 'v2.19 · iPhoneの保存・同期負荷を軽減'
pending = {}


def source(path):
    return pending.get(path, (ROOT / path).read_text(encoding='utf-8'))


def change(path, old, new, count=1):
    text = source(path)
    if text.count(old) != count:
        raise RuntimeError(f'v2.19 release anchor changed {path}: {old[:130]!r} ({text.count(old)} != {count})')
    pending[path] = text.replace(old, new)


if re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != ['sentlog-pwa-v260']:
    raise RuntimeError('v2.18 production build is required')
for name in ('record-store', 'delta-sync-app-journal'):
    if not source('sentlog/' + name + '.js').startswith('// ' + OLD_MARKER + '\n'):
        raise RuntimeError('The tested v2.18 module is required: ' + name)

writer = 'sentlog/record-store.js'
# Deliberately keep every complete protection/restore API. Binding ownership
# and phases are available at startup; the actual native Blob copies remain in
# IndexedDB until the exact project is needed for recovery.
change(writer, '  async function ensureCutoffFiles(){', '''  function releaseIdleCutoffFiles(localProjectId){
    if(!lazyRecordStartup)return;
    const binding=bindings.get(localProjectId);
    if(!binding)return;
    for(const file of binding.cutoff?.files||[])if(typeof file?.valueRef==='string')
      cutoffFiles.delete(file.valueRef);
  }
  async function ensureCutoffFiles(){
    if(lazyRecordStartup){
      const keys=await retainedBindingKeys(),next=new Map();
      // The index/key cursor does not materialize PDF/photo Blob values.
      // Each binding is validated, but its cutoff-file rows stay on disk.
      for(const key of keys){
        const binding=await readControl(key);
        if(!binding||binding.kind!=='binding'||binding.localProjectId!==String(key).slice('binding:'.length))
          throw journalError('JOURNAL_BINDING','既存の共有記録を確認できません。元の記録を保持して停止しました');
        bindingState(binding);
        if(next.has(binding.localProjectId))throw journalError('JOURNAL_BINDING','案件の保存先が重複しています');
        next.set(binding.localProjectId,binding);
      }
      // Preserve the old startup protection: a referenced original row must
      // exist. Inspect only its primary key, never the photo/PDF Blob body.
      const referenced=[];
      for(const binding of next.values())for(const file of binding.cutoff?.files||[])
        if(typeof file?.valueRef==='string')referenced.push(file.valueRef);
      if(referenced.length){
        const tx=transaction('readonly'),done=complete(tx),store=tx.objectStore(CONTROL),present=new Set();
        const q=store.openKeyCursor(IDBKeyRange.bound('cutoff-file:','cutoff-file:\uffff'));
        q.onsuccess=()=>{try{const item=q.result;if(!item)return;
          present.add(item.primaryKey);item.continue();
        }catch(error){tx.sentlogJournalError=error;tx.abort();}};
        await done;
        for(const key of referenced)if(!present.has(key))
          throw journalError('JOURNAL_CUTOFF_REF','保護したPDF・写真の控えが見つかりません。上書きせず起動を停止しました');
      }
      bindings=next;cutoffFiles=new Map();return;
    }''')
# A read-only binding-state inspection must not hydrate all of the prior PDFs
# merely because auto sync checks a project for its ownership fence.
change(writer, "      const state=bindingState(binding);\n      if(binding){", """      const state=bindingState(binding);
      if(lazyRecordStartup){
        const prior=bindings.get(localProjectId);
        if(prior?.id!==binding?.id)releaseIdleCutoffFiles(localProjectId);
        if(binding)bindings.set(localProjectId,binding);else bindings.delete(localProjectId);
        return state;
      }
      if(binding){""")
# On-demand full proofs use the old one-transaction reader, with all byte and
# scope checks intact. Old proof rows from this project can then be released.
change(writer, "    const hydrated=hydrateBinding(binding,files);\n    bindings.set(localProjectId,binding);for(const [id,row]of files)cutoffFiles.set(id,row);",
       "    const hydrated=hydrateBinding(binding,files);\n    if(lazyRecordStartup)releaseIdleCutoffFiles(localProjectId);\n    bindings.set(localProjectId,binding);for(const [id,row]of files)cutoffFiles.set(id,row);")
# The existing v2.18 eviction already refuses to run during writes, pending
# flushes, or a pinned editor; release only that project's hydrated cutoffs.
change(writer, "      memory.delete(meta);durableMemory.delete(meta);coldRecordKeys.add(meta);\n    }\n    return true;",
       "      memory.delete(meta);durableMemory.delete(meta);coldRecordKeys.add(meta);\n    }\n    releaseIdleCutoffFiles(localProjectId);\n    return true;")
# A full public binding reader still requires proof bytes. An ordinary read of
# the binding *state* does not; never silently return an incomplete cutoff.
# ACK always commits its verified proof before optional cleanup. iOS must not
# run the old full 1,024-row cleanup here and then a second pass in drain().
# Never hydrate massive cutoff PDF/photo copies merely to return an ACK that
# the mobile controller deliberately discards. Its ownership state is enough.
change(writer,
       "      try{await this.compact();}catch(error){console.warn('Journal retention cleanup deferred',error);}",
       "      if(!lazyRecordStartup)try{await this.compact();}catch(error){console.warn('Journal retention cleanup deferred',error);}")
change(writer,
       "      return hydrateBinding(result);\n    },\n    async compactRedundantRecords(",
       "      return lazyRecordStartup?bindingState(result):hydrateBinding(result);\n    },\n    async compactRedundantRecords(")
change(writer, '    storageLifecycleVersion:1,', '    storageLifecycleVersion:1,\n    deferredCutoffStartupVersion:1,')

journal = 'sentlog/delta-sync-app-journal.js'
change(journal, "      flight=(async()=>{\n        status({phase:'replaying',lastError:null});",
       "      flight=(async()=>{\n        const acknowledgedAtStart=acknowledged;\n        status({phase:'replaying',lastError:null});")
change(journal, '''          try{await journal.compact();status({retentionError:null});}
          catch(error){status({retentionError:{code:error.code||error.name||'ERROR',message:error.message}});}''',
       '''          // Empty background polls do not need to walk 1,024 historical
          // WAL entries and materialize old photo/PDF preimages on iOS.
          // After an actual ACK, apply the same proof checks with a smaller
          // scan budget. Explicit maintenance remains independent.
          if(!records.lazyStartup||acknowledged>acknowledgedAtStart){
            try{await journal.compact(records.lazyStartup?{limit:8,scanLimit:64}:{});status({retentionError:null});}
            catch(error){status({retentionError:{code:error.code||error.name||'ERROR',message:error.message}});}
          }''')

# Advance the full set of v2.18 version-locked normal modules as a group.
# This avoids stale individually cached scripts after a Home Screen PWA wakes,
# while every module's behavior other than the two above stays byte-identical.
index='sentlog/index.html'
for name in ('record-store','storage-maintenance-ui','sync-view',
             'delta-sync-app-runtime','photo-thumbnails','cloud-sync'):
    file='sentlog/'+name+'.js'
    pending[file]='// '+MARKER+'\n'+source(file)
    change(index,name+'.js?v='+OLD_TOKEN,name+'.js?v='+TOKEN,2)
    change(index,"['"+name+".js?v="+TOKEN+"','"+OLD_MARKER+"']",
           "['"+name+".js?v="+TOKEN+"','"+MARKER+"']")
# The app journal itself now changes behavior; its prior versioned URL came
# from delta integration and was not previously advanced with v2.18's change.
name='delta-sync-app-journal'
file='sentlog/'+name+'.js'
pending[file]='// '+MARKER+'\n'+source(file)
urls=re.findall(re.escape(name)+r'\.js\?v=([A-Za-z0-9._-]+)',source(index))
if len(urls)!=2 or len(set(urls))!=1:
    raise RuntimeError('v2.19 journal URL changed: '+repr(urls))
change(index,name+'.js?v='+urls[0],name+'.js?v='+TOKEN,2)
check="['"+name+".js?v="+TOKEN+"','"
found=re.search(re.escape(check)+r"([^']+)'\]",source(index))
if not found:raise RuntimeError('v2.19 journal identity missing')
change(index,check+found.group(1)+"']",check+MARKER+"']")

# The independent storage-maintenance route must not be left with old
# unversioned JS after a Home Screen update, but remains entirely separate.
change('sentlog/startup-storage-maintenance.js', '// '+OLD_MARKER+'\n',
       '// '+MARKER+'\n')
change('sentlog/storage-maintenance.html', OLD_TOKEN, TOKEN, 3)
change(index,'storage-maintenance.html?v='+OLD_TOKEN,'storage-maintenance.html?v='+TOKEN)
change(index,'if(window.SentlogRecords?.lazyStartupVersion!==1||',
       'if(window.SentlogRecords?.deferredCutoffStartupVersion!==1||window.SentlogRecords?.lazyStartupVersion!==1||')
change(index,'phone-runtime.js?v=218','phone-runtime.js?v=219',2)
change(index,"['phone-runtime.js?v=219','v2.18']","['phone-runtime.js?v=219','v2.19']")
change('sentlog/phone-runtime.js','v2.18','v2.19',4)
change('sentlog/phone-runtime.js','v2.19 · iPhoneの記録読込を分割',LABEL)
change('sentlog-pc/index.html',OLD_LABEL,LABEL)
change('sentlog/sw.js','sentlog-pwa-v260','sentlog-pwa-v261')

# Keep the existing behavioral checks byte-for-byte. Only the fixed resource
# identities and explicitly new startup capability in test fixtures advance.
identities=[('sentlog-pwa-v260','sentlog-pwa-v261'),
            (OLD_TOKEN,TOKEN),(OLD_MARKER,MARKER),(OLD_LABEL,LABEL),
            ('phone-runtime.js?v=218','phone-runtime.js?v=219'),
            (r'phone-runtime\.js\?v=218',r'phone-runtime\.js\?v=219'),
            ("'v2.18'","'v2.19'")]
for path in (ROOT/'tests').iterdir():
    if path.suffix not in ('.py','.cjs') or path.name=='iphone_cutoff_memory.test.cjs':continue
    name=str(path.relative_to(ROOT));before=source(name);value=before
    for old,new in identities:value=value.replace(old,new)
    if path.name in ('startup_protection_release.test.cjs','storage_lifecycle_release.test.cjs',
        'recovery_retry_release.test.cjs','reliability_release.test.cjs',
        'capacity_maintenance_release.test.cjs','operation_memory_release.test.cjs'):
        value=value.replace('const records={lazyStartupVersion:1,',
            'const records={deferredCutoffStartupVersion:1,lazyStartupVersion:1,')
    if path.name=='startup_backup_recovery_release.test.cjs':
        value=value.replace('window:{SentlogRecords:{lazyStartupVersion:1,',
            'window:{SentlogRecords:{deferredCutoffStartupVersion:1,lazyStartupVersion:1,')
    if path.name=='iphone_stability_release.test.cjs':
        value=value.replace('const records={lazyStartupVersion:1,',
            'const records={deferredCutoffStartupVersion:1,lazyStartupVersion:1,')
    if path.name=='metadata_choice_release.test.cjs':
        value=value.replace('if(window.SentlogRecords?.lazyStartupVersion!==1||',
            'if(window.SentlogRecords?.deferredCutoffStartupVersion!==1||window.SentlogRecords?.lazyStartupVersion!==1||')
    if value!=before:pending[name]=value

for name,value in pending.items():
    (ROOT/name).write_text(value,encoding='utf-8')
for name in ['record-store','delta-sync-app-journal','delta-sync-app-runtime','cloud-sync','photo-thumbnails']:
    subprocess.run(['node','--check','sentlog/'+name+'.js'],cwd=ROOT,check=True)
print('Built v2.19: deferred iPhone cutoff-file rows and bounded post-ACK WAL compaction')
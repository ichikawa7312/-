"""Guarded v1.37 capacity + restoration integration after archive and management builds.
Every storage mutation stays user-triggered. No test or build touches real user data.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError("Capacity integration point changed: "+path+": "+repr(old[:85]))
 p.write_text(s.replace(old,new))

# Add one device-local record, deliberately excluded from Supabase snapshots.
p='sentlog/record-store.js'
change(p,"const DRAW='surveyFieldNoteDrawingV1:', SYNC='sentlogCloudProjectSyncV2:';",
 "const DRAW='surveyFieldNoteDrawingV1:', SYNC='sentlogCloudProjectSyncV2:', LOCAL_ARCH='sentlogArchiveLocalV1';")
change(p,"const managed=k=>k===WS ||", "const managed=k=>k===LOCAL_ARCH || k===WS ||")
storage_code=r'''
  // Atomically change only selected records/files in the active browser.
  // The stored workspace and per-file sizes are checked again in the same
  // IndexedDB transaction before any mutation; server authorization is
  // separately required by the capacity UI.
  async function archiveAtomic({writes=[],deleteFiles=[],expectedWorkspace}={}){
    assertReady();await settled();assertSafe();
    if(exclusive)throw Error('ほかの保存操作が進行しています');
    const updates=[...writes],files=[...deleteFiles];
    if(typeof expectedWorkspace!=='string'||memory.get(WS)!==expectedWorkspace)
      throw Error('別の操作で案件一覧が更新されています。削除を中止しました。');
    if(updates.some(([k,v])=>!managed(k)||(v!==null&&typeof v!=='string')))
      throw Error('保管の記録形式を確認できません。');
    if(files.some(x=>!x||typeof x.key!=='string'||!/^(background:[^:]+|photo:[^:]+:[^:]+)$/.test(x.key)
       ||!Number.isSafeInteger(x.size)||x.size<0)
       ||new Set(files.map(x=>x.key)).size!==files.length)
      throw Error('容量整理の対象ファイルを確認できません。');
    exclusive=true;operation=true;notify();
    try{
      await connect();
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);let conflict=false;
      let oldMeta=null;
      function stop(){conflict=true;tx.abort();}
      function commit(){
        if(conflict)return;
        for(const f of files)s.delete(f.key);
        for(const [k,v] of updates)if(v===null)s.delete(PREFIX+k);else s.put(v,PREFIX+k);
        s.put({...oldMeta,revision:revision+1,updatedAt:new Date().toISOString()},META);
      }
      s.get(META).onsuccess=e=>{
        oldMeta=e.target.result;
        if(!oldMeta||Number(oldMeta.revision)!==revision||memory.get(WS)!==expectedWorkspace){
          stop();return;
        }
        if(!files.length){commit();return;}
        let remaining=files.length;
        for(const f of files){
          s.get(f.key).onsuccess=e=>{
            const v=e.target.result;
            if(!(v instanceof Blob)||v.size!==f.size){stop();return;}
            if(--remaining===0)commit();
          };
        }
      };
      try{await done;}catch(e){
        if(conflict)throw Error('確認中にファイルまたは案件情報が変更されました。何も削除せず中止しました。');
        throw e;
      }
      revision++;
      for(const [k,v] of updates)if(v===null)memory.delete(k);else memory.set(k,v);
      notify();
    }finally{exclusive=false;operation=false;notify();}
  }
'''
change(p,"  async function stats(){",storage_code+"\n  async function stats(){")
change(p,"window.SentlogRecords={init,flush,settled,writeFile,retry,batch,replaceAll,stats,",
 "window.SentlogRecords={init,flush,settled,writeFile,retry,batch,replaceAll,archiveAtomic,stats,")

# Install buttons only inside the existing Archive folder and never for retired cases.
p='sentlog/archive.js'
change(p,"  async function manual(cp){\n",
 "  async function manual(cp){\n    if(window.SentlogCapacity?.isCleared(cp.id))throw Error('端末から外した案件です。「PCから復旧」を選んでください。');\n")
change(p,"  async function reopen(cp){\n",
 "  async function reopen(cp){\n    if(window.SentlogCapacity?.isCleared(cp.id))throw Error('この端末への復旧を終えてから使用中に戻してください。');\n")
change(p,"if(cp.retired)throw Error('この端末に残っている記録はありません。使用終了の案件は自動で取得しません。');await manual(cp);",
 "if(cp.retired)throw Error('この端末に残っている記録はありません。使用終了の案件は自動で取得しません。');if(window.SentlogCapacity?.isCleared(cp.id))throw Error('この端末から外しています。「PCから復旧」を押してください。');await manual(cp);")
change(p,"card.append(actions);grid.append(card);",
 "if(archiveView&&!cp?.retired)window.SentlogCapacity?.renderActions(actions,cp,p);\n        card.append(actions);grid.append(card);")
change(p,"if(archiveView){if(!cp?.retired)actions.append(createButton('この案件を手動同期',()=>action(()=>manual(cp))));",
 "if(archiveView){if(!cp?.retired&&!window.SentlogCapacity?.isCleared(cp.id))actions.append(createButton('この案件を手動同期',()=>action(()=>manual(cp)));")
change(p,"if(!getProject(p.id)){if(!cp)throw Error('案件を確認できません。');",
 "if(window.SentlogCapacity?.isCleared(cp?.id))throw Error('この端末のデータは容量整理済みです。「PCから復旧」から戻してください。');if(!getProject(p.id)){if(!cp)throw Error('案件を確認できません。');")

# Append the feature script before the normal cloud synchronization starts.
p='sentlog/index.html'
change(p,"['management.js?v=136','v1.36 management']",
 "['management.js?v=136','v1.36 management'],['archive-capacity.js?v=137','SentlogCapacity']")
change(p,'<script src="./management.js?v=136"><\\/script>',
 '<script src="./management.js?v=136"><\\/script><script src="./archive-capacity.js?v=137"><\\/script>')
change(p,"'v1.36'","'v1.37'")
change(p,'phone-runtime.js?v=136','phone-runtime.js?v=137',2)
p='sentlog/phone-runtime.js'
change(p,'v1.36','v1.37',4)
p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v149';","const CACHE='sentlog-pwa-v150';")
change(p,"'management.js','record-store.js'","'management.js','archive-capacity.js','record-store.js'")

p='sentlog-pc/index.html'
change(p,'<script src="../sentlog/archive-pc.js?v=133"></script>',
 '<script src="../sentlog/archive-pc.js?v=133"></script>\n<script src="../sentlog/archive-restore-pc.js?v=137"></script>')
change(p,'v1.35 · 案件一式の保管確認','v1.37 · 復旧・容量整理対応')

change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.36'","window.SENTLOG_BUILD==='v1.37'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.36'","window.SENTLOG_BUILD==='v1.37'")
print('Built Sentlog v1.37 capacity stage: archived-only actions, atomic local transaction, PC data preserved')

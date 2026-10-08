from pathlib import Path
p=Path('.sentlog-storage/site/sentlog')
s=(p/'record-store.js').read_text()
if 'function writeFile(' not in s:
 s=s.replace('  const listeners=new Set(), failures=new Map();','  const listeners=new Set(), failures=new Map(), fileTasks=new Set(), failedFiles=new Map();')
 a=s.index('  async function retry()');b=s.index('  async function replaceAll(',a)
 s=s[:a]+'''  function writeFile(key,value){
    assertReady();
    if(exclusive) return Promise.reject(Error('復元中です'));
    let task;
    task=(async()=>{
      try{
        await connect();const tx=transaction('readwrite'),done=complete(tx);
        tx.objectStore(STORE).put(value,key);await done;
        failedFiles.delete(key);recovered('file:'+key);
      }catch(error){failedFiles.set(key,value);report('file:'+key,error);throw error;}
      finally{fileTasks.delete(task);notify();}
    })();fileTasks.add(task);notify();return task;
  }
  async function settled(){
    while(fileTasks.size)await Promise.all([...fileTasks]);
    await flush();
  }
  async function retry(){
    failure=null;
    for(const [key,value] of [...failedFiles])await writeFile(key,value);
    try{await flush();recovered('import');}catch(e){report('records',e);throw e;}
  }
'''+s[b:]
 s=s.replace('    await flush();exclusive=true;', '    await settled();exclusive=true;')
 s=s.replace("revision++;memory=new Map(records);recovered('import');", "revision++;memory=new Map(records);failedFiles.clear();failures.clear();notify();")
 s=s.replace('window.SentlogRecords={init,flush,retry,batch,replaceAll,stats,','window.SentlogRecords={init,flush,settled,writeFile,retry,batch,replaceAll,stats,\n    uncommittedFiles:()=>[...failedFiles].map(([key,value])=>({key,value})),')
 s=s.replace('return pending.size+inFlight>0||operation;', 'return pending.size+inFlight>0||fileTasks.size>0||operation;')
(p/'record-store.js').write_text(s)
s=(p/'part05.txt').read_text();a=s.index('async function putDBFile(');b=s.index('async function getDBFile(',a)
s=s[:a]+"async function putDBFile(key,file){return window.SentlogRecords.writeFile(key,file);}\n"+s[b:]
s=s.replace('if(!options.allowPending)await window.SentlogRecords.flush();','if(!options.allowPending){await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();}')
s=s.replace('  for(const item of await getAllDBFiles()){const v=item.value;', '  const backupFiles=new Map((await getAllDBFiles()).map(f=>[f.key,f.value]));\n  if(options.allowPending)for(const f of window.SentlogRecords.uncommittedFiles())backupFiles.set(f.key,f.value);\n  for(const [key,value] of backupFiles){const item={key,value};const v=item.value;')
s=s.replace('if(window.sentlogCloudIdle)await window.sentlogCloudIdle();','if(window.sentlogCloudIdle)await window.sentlogCloudIdle();\n    if(window.sentlogPdfRecoveryIdle)await window.sentlogPdfRecoveryIdle();')
(p/'part05.txt').write_text(s)
# Retain the photo metadata for a failed file save, so retry restores the same photo.
s=(p/'part06.txt').read_text()
s=s.replace("const id=uid();await savePhotoBlob(id,blob);const target=state.shapes.find", "const id=uid();const target=state.shapes.find")
s=s.replace("size:blob?.size||f.size||0});added++;", "size:blob?.size||f.size||0});await savePhotoBlob(id,blob);added++;")
(p/'part06.txt').write_text(s)
for name in ['phone-runtime.js','cloud-sync.js']:
 s=(p/name).read_text().replace('await window.SentlogRecords.flush();window.SentlogRecords.assertSafe();','await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();');(p/name).write_text(s)
s=(p/'pdf-recovery.js').read_text()
s=s.replace('async function db(name,store,key,value){','async function db(name,store,key,value){\n  if(value!==undefined && name===\'surveyFieldNoteDB\' && window.SentlogRecords?.ready)return window.SentlogRecords.writeFile(key,value);')
s=s.replace('window.sentlogCheckPdfRecovery=run;','window.sentlogPdfRecoveryIdle=async()=>{while(busy)await new Promise(resolve=>setTimeout(resolve,30));};\nwindow.sentlogCheckPdfRecovery=run;')
(p/'pdf-recovery.js').write_text(s)
s=(p/'storage-ui.js').read_text().replace('await store.retry();','await store.retry();if(typeof renderSelectedPhotos===\'function\')renderSelectedPhotos();')
s=s.replace('PDF・写真は、空き容量を確保してから同じ操作で追加し直してください。','PDF・写真もこの画面を開いている間は再保存できます。')
(p/'storage-ui.js').write_text(s)
# Reject mixed old/new cached scripts before executing the editor.
s=(p/'index.html').read_text()
check="for(const [i,token] of [[4,'window.SentlogRecords'],[5,'await savePhotoBlob(id,blob)'],[6,'window.SentlogRecords'],[8,'window.sentlogAppReady']]){if(!parts[i].includes(token))throw Error('最新版の表示データが揃っていません。通信できる場所でもう一度開いてください。');}const deps=[['cloud-sync.js?v=20261008-storage-130','await window.sentlogAppReady'],['sync-view.js?v=130','window.SentlogRecords.batch'],['pdf-recovery.js?v=130','window.SentlogRecords.getItem'],['phone-runtime.js?v=130','v1.30'],['storage-ui.js?v=130','sentlogStorageWarning']];await Promise.all(deps.map(async([file,token])=>{const r=await fetch('./'+file,{cache:'no-store'});if(!r.ok||!(await r.text()).includes(token))throw Error('最新版を取得できませんでした。記録は残して起動を止めています。通信状態を確認してください。');}));"
s=s.replace("let html=parts.join('');",check+"let html=parts.join('');")
(p/'index.html').write_text(s)

from pathlib import Path
p=Path('.sentlog-storage/site/sentlog')
def patch(name,old,new):
 s=(p/name).read_text(); assert old in s,(name,old[:80]); (p/name).write_text(s.replace(old,new))
for name in ['part05.txt','part07.txt','sync-view.js']:
 s=(p/name).read_text().replace('localStorage.getItem','window.SentlogRecords.getItem').replace('localStorage.setItem','window.SentlogRecords.setItem').replace('localStorage.removeItem','window.SentlogRecords.removeItem')
 (p/name).write_text(s)
patch('part05.txt',"  saveStatus.textContent='保存済み';setTimeout(()=>saveStatus.textContent='端末内保存',900)","  // Writes are batched atomically before the microtask queue drains.")
s=(p/'part05.txt').read_text();a=s.index('async function putDBFile(');b=s.index('async function getDBFile(',a)
s=s[:a]+'''async function putDBFile(key,file){
  let db;
  try{
    db=await openDB();
    await new Promise((resolve,reject)=>{
      let tx;try{tx=db.transaction('files','readwrite',{durability:'strict'})}catch(_){tx=db.transaction('files','readwrite')}
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('ファイルの保存が中断されました'));tx.onerror=()=>{};
      tx.objectStore('files').put(file,key);
    });
    window.SentlogRecords.recovered('file:'+key);
  }catch(error){window.SentlogRecords.report('file:'+key,error);throw error;}
  finally{if(db)db.close();}
}
'''+s[b:]
a=s.index('async function clearDBFiles(');b=s.index('function blobToDataURL',a)
s=s[:a]+'''async function clearDBFiles(){
  const db=await openDB();try{await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
    const q=tx.objectStore('files').openCursor();q.onsuccess=()=>{const c=q.result;if(!c)return;if(c.value instanceof Blob)c.delete();c.continue();};
  });}finally{db.close();}
}
'''+s[b:]
a=s.index('async function exportSentlogBackup(');b=s.index('async function saveBackgroundFile',a)
s=s[:a]+'''async function exportSentlogBackup(options={}){
  if(currentView==='editor'&&activeDrawingId)persist();
  saveWorkspace();
  if(!options.allowPending)await window.SentlogRecords.flush();
  const drawingStates={};
  for(const p of workspace.projects||[])for(const d of p.drawings||[]){const raw=window.SentlogRecords.getItem(drawingStorageKey(d.id));if(raw)drawingStates[d.id]=JSON.parse(raw)}
  const files=[];
  for(const item of await getAllDBFiles()){const v=item.value;if(v instanceof Blob){files.push({key:item.key,type:v.type||'application/octet-stream',name:v.name||'',lastModified:v.lastModified||null,data:await blobToDataURL(v)})}}
  const payload={format:'sentlog-backup',version:1,exportedAt:new Date().toISOString(),workspace,drawingStates,files};
  const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');const d=new Date();const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');a.href=url;a.download=`セントログ_バックアップ_${y}${m}${day}.sentlog.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function importSentlogBackup(file){
  let pack,records,files;
  try{
    pack=JSON.parse(await file.text());
    if(pack?.format!=='sentlog-backup'||pack.version!==1||!Array.isArray(pack.workspace?.projects)||!Array.isArray(pack.files))throw Error('バックアップの形式が不正です');
    const ids=new Set(),projectIds=new Set();
    for(const p of pack.workspace.projects){
      if(typeof p.id!=='string'||!p.id||projectIds.has(p.id)||!Array.isArray(p.drawings))throw Error('案件情報が不正です');
      projectIds.add(p.id);
      for(const d of p.drawings){if(typeof d.id!=='string'||!d.id||ids.has(d.id))throw Error('図面情報が不正です');ids.add(d.id);}
    }
    records=new Map([[WORKSPACE_KEY,JSON.stringify(pack.workspace)]]);
    for(const [id,st] of Object.entries(pack.drawingStates||{})){
      if(!ids.has(id)||!st||!Array.isArray(st.shapes))throw Error('変状記録が不正です');
      records.set(drawingStorageKey(id),JSON.stringify(st));
    }
    for(const p of pack.workspace.projects)records.set('sentlogCloudProjectSyncV2:'+p.id,JSON.stringify({revision:0,restored_backup:true,local_updated_at:p.updatedAt||0}));
    const fileKeys=new Set();files=[];
    for(const f of pack.files){
      if(typeof f.key!=='string'||!(/^(background:|photo:)/.test(f.key)||f.key==='background')||fileKeys.has(f.key)||!/^data:[^;]+;base64,/.test(f.data||''))throw Error('添付ファイルの形式が不正です');
      fileKeys.add(f.key);const blob=dataURLToBlob(f.data);
      const value=f.name?new File([blob],f.name,{type:f.type||blob.type,lastModified:f.lastModified||Date.now()}):blob;
      files.push({key:f.key,value});
    }
  }catch(error){alert('バックアップを読み込めませんでした。現在のデータは変更していません。'+(error.message||error));return;}
  if(!confirm('現在この端末にある案件データを、読み込むバックアップで置き換えます。よろしいですか？'))return;
  if(window.SentlogRecords.pending)await window.SentlogRecords.flush();
  window.sentlogImporting=true;
  try{
    if(window.sentlogCloudIdle)await window.sentlogCloudIdle();
    await window.SentlogRecords.replaceAll(records,files);
    workspace=pack.workspace;activeDrawingId=null;activeProjectId=null;
    alert('バックアップを読み込みました。案件一覧を更新します。');location.reload();
  }catch(error){alert('復元に失敗しました。元の記録を残して処理を中止しました。'+(error.message||error));}
  finally{window.sentlogImporting=false;}
}
'''+s[b:];(p/'part05.txt').write_text(s)
patch('part07.txt',"async function initApp(){\n", "async function initApp(){\n  await window.SentlogRecords.init();\n")
patch('part09.txt','initApp();', 'window.sentlogAppReady=initApp();')
patch('part09.txt',"    if(swReloaded)return;\n    swReloaded=true;\n    location.reload();","    // Explicit reload awaits IndexedDB commits; worker activation never interrupts edits.\n    swReloaded=true;")
s=(p/'cloud-sync.js').read_text()
for expr in ['WORKSPACE_KEY','DRAWING_KEY_PREFIX+id','SYNC_META_PREFIX+projectId']:
 s=s.replace('localStorage.getItem('+expr+')','window.SentlogRecords.getItem('+expr+')')
 s=s.replace('localStorage.setItem('+expr+',','window.SentlogRecords.setItem('+expr+',')
s=s.replace("if(syncing||!navigator.onLine||!session)return;", "if(syncing||!navigator.onLine||!session||window.sentlogImporting)return;")
s=s.replace("  try{\n    await ensureSession();\n    const deviceId", "  try{\n    await window.sentlogAppReady;\n    await window.SentlogRecords.flush();window.SentlogRecords.assertSafe();\n    await ensureSession();\n    const deviceId")
s=s.replace('const result=window.sentlogSyncView?.commit(cp,snap,expectedLocal);','const result=await window.sentlogSyncView?.commit(cp,snap,expectedLocal);')
s=s.replace('const localChanged=lp && meta && (meta.fingerprint?', 'const localChanged=lp && meta && (meta.restored_backup || (meta.fingerprint?').replace('Number(meta.local_updated_at||0));','Number(meta.local_updated_at||0)));')
s=s.replace("    if(drawingErrors.length)syncStatus.finish", "    await window.SentlogRecords.flush();window.SentlogRecords.assertSafe();\n    if(drawingErrors.length)syncStatus.finish")
a=s.index('async function dbPut(');b=s.index('async function sha256Hex(',a)
s=s[:a]+'''async function dbPut(key,value){return window.putDBFile(key,value);}
'''+s[b:]
s=s.replace('loadSession();\nwindow.addEventListener',"window.sentlogCloudIdle=async()=>{while(syncing)await sleep(30);};\nawait window.sentlogAppReady;\nloadSession();\nwindow.addEventListener")
(p/'cloud-sync.js').write_text(s)
s=(p/'sync-view.js').read_text().replace('function commit(cloudProject','async function commit(cloudProject')
a=s.index('    try{\n      for(const [key,value] of writes)');b=s.index('    // Update the application',a)
s=s[:a]+"    window.SentlogRecords.batch(writes);\n"+s[b:]
s=s.replace('    return {applied:true};','    await window.SentlogRecords.flush();\n    return {applied:true};')
(p/'sync-view.js').write_text(s)
patch('phone-runtime.js',"      btn.disabled=true;\n      try { const reg=", "      btn.disabled=true;\n      try { await window.SentlogRecords.flush();window.SentlogRecords.assertSafe(); }\n      catch(error){btn.disabled=false;note.textContent='未保存の記録があります。画面を閉じず、保存警告を確認してください。';return;}\n      try { const reg=")
s=(p/'phone-runtime.js').read_text().replace('v1.29','v1.30').replace('PDF高精細表示・画質優先同期','大容量記録保存・保存容量表示');(p/'phone-runtime.js').write_text(s)
s=(p/'pdf-recovery.js').read_text().replace("localStorage.getItem('surveyFieldNoteWorkspaceV1')", "window.SentlogRecords.getItem('surveyFieldNoteWorkspaceV1')")
s=s.replace('if(busy || !navigator.onLine || document.hidden)return;', 'if(busy || !navigator.onLine || document.hidden || window.sentlogImporting || (!IS_PC && !window.SentlogRecords?.ready))return;')
s=s.replace("setTimeout(run,2500);", "if(!IS_PC)await window.sentlogAppReady;\nsetTimeout(run,2500);")
(p/'pdf-recovery.js').write_text(s)
s=(p/'index.html').read_text()
s=s.replace('<title>セントログ</title>','<title>セントログ</title><script src="./record-store.js?v=130"></script>')
s=s.replace('(async()=>{try{const files=', '(async()=>{try{await window.SentlogRecords.init();const files=')
s=s.replace('./phone-runtime.js?v=129','./phone-runtime.js?v=130').replace('./sync-view.js?v=123','./sync-view.js?v=130').replace('./cloud-sync.js?v=20261008-quiet-127','./cloud-sync.js?v=20261008-storage-130').replace('./pdf-recovery.js?v=126','./pdf-recovery.js?v=130')
s=s.replace('<script src="./sync-view.js?v=130">','<script src="./storage-ui.js?v=130"><\\/script><script src="./sync-view.js?v=130">')
a=s.index("}catch(e){document.body.innerHTML=");s=s[:a]+'''}catch(e){document.body.replaceChildren();const box=document.createElement('div');box.style.cssText='max-width:440px;padding:24px;line-height:1.7;';const title=document.createElement('strong');title.textContent='セントログを開始できませんでした';const message=document.createElement('p');message.textContent=e?.message||'通信状態を確認して再読み込みしてください。保存済みデータは削除していません。';const retry=document.createElement('button');retry.textContent='もう一度開く';retry.onclick=()=>location.reload();box.append(title,message,retry);document.body.append(box)}})();</script></body></html>'''
(p/'index.html').write_text(s)
s=(p/'sw.js').read_text().replace("sentlog-pwa-v142","sentlog-pwa-v143").replace("'app-settings.js',","'app-settings.js','record-store.js','storage-ui.js',")
(p/'sw.js').write_text(s)

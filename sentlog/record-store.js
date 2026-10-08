/* v1.30. IndexedDB is the durable source of truth for records, not localStorage.
   The synchronous read mirror supports the existing canvas editor. Writes commit in
   ordered, atomic transactions; sync/export/reload explicitly await flush(). */
(function () {
  'use strict';
  if (window.SentlogRecords) return;
  const DB='surveyFieldNoteDB', STORE='files', PREFIX='__sentlog_record__:';
  const META='__sentlog_records_meta_v130__', ARCHIVE='__sentlog_records_archive_v130__';
  const MARKER='sentlogRecordsReadyV130', WS='surveyFieldNoteWorkspaceV1';
  const DRAW='surveyFieldNoteDrawingV1:', SYNC='sentlogCloudProjectSyncV2:';
  const managed=k=>k===WS || k==='surveyFieldNoteV2' || k.startsWith(DRAW) || k.startsWith(SYNC);
  let memory=new Map(), pending=new Map(), revision=0, connection=null;
  let initialized=false, boot=null, flight=null, queued=false, inFlight=0, exclusive=false;
  let migrationInfo=null, operation=false, failure=null;
  const listeners=new Set(), failures=new Map();
  function notify(){for(const fn of listeners){try{fn()}catch(e){console.warn('Storage status',e)}}}
  function report(key,error){failures.set(String(key),error?.message||String(error));notify();}
  function recovered(key){if(failures.delete(String(key)))notify();}
  function assertReady(){if(!initialized)throw Error('保存先の準備が完了していません');}
  function transaction(mode){
    if(!connection)throw Error('保存先との接続が切れました。画面を閉じず、再保存を試してください。');
    try{return connection.transaction(STORE,mode,{durability:'strict'})}
    catch(e){if(e.name==='TypeError')return connection.transaction(STORE,mode);throw e;}
  }
  function complete(tx){return new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('端末への保存が中断されました'));
    tx.onerror=()=>{};
  });}
  async function connect(){
    if(connection)return;
    connection=await new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,1);
      q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains(STORE))q.result.createObjectStore(STORE);};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
      q.onblocked=()=>reject(Error('別のセントログ画面が保存先を使用中です。ほかの画面を閉じて再試行してください。'));
    });
    connection.onversionchange=()=>{connection.close();connection=null;failure=Error('保存先が別の画面で更新されました。未保存の記録を退避してから更新してください。');report('records',failure);};
  }
  async function editorLock(){
    if(!navigator.locks?.request)return;
    await new Promise((resolve,reject)=>{
      navigator.locks.request('sentlog-record-writer-v130',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock){reject(Error('同じブラウザでセントログが別に開いています。ほかのセントログ本体を閉じて再読み込みしてください。PC自動同期の画面は閉じなくて大丈夫です。'));return;}
        resolve();await new Promise(()=>{});
      }).catch(reject);
    });
  }
  async function readAll(){
    const tx=transaction('readonly'),done=complete(tx),s=tx.objectStore(STORE);
    let meta=null,archive=null,keys=[],values=[];
    s.get(META).onsuccess=e=>meta=e.target.result;
    s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
    const range=IDBKeyRange.bound(PREFIX,PREFIX+'\uffff');
    s.getAllKeys(range).onsuccess=e=>keys=e.target.result;
    s.getAll(range).onsuccess=e=>values=e.target.result;
    await done;
    return {meta,archive,map:new Map(keys.map((k,i)=>[k.slice(PREFIX.length),values[i]]))};
  }
  function legacy(){
    const out=new Map();
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(key && managed(key))out.set(key,localStorage.getItem(key));
    }
    for(const [key,value] of out){
      if(typeof value!=='string')throw Error('旧保存データを読み取れません。元データは削除していません。');
      try{const obj=JSON.parse(value);if(key===WS && (!obj || !Array.isArray(obj.projects)))throw Error();}
      catch(_){throw Error('旧保存データに読み取れない記録があります。元データを残して移行を停止しました。');}
    }
    return out;
  }
  function cleanLegacy(entries){
    // Delete only exact copies verified after the IndexedDB transaction committed.
    for(const [key,value] of entries){if(localStorage.getItem(key)===value)localStorage.removeItem(key);}
  }
  async function initialize(){
    await editorLock();await connect();
    let disk=await readAll();
    const old=legacy();
    if(!disk.meta){
      if(localStorage.getItem(MARKER) && !old.size)throw Error('以前の端末内データを確認できません。空のデータで上書きせず起動を停止しました。バックアップの復旧が必要です。');
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);
      const info={schema:1,revision:0,migratedAt:new Date().toISOString(),legacyCount:old.size};
      let already=false;
      s.get(META).onsuccess=e=>{
        if(e.target.result){already=true;return;}
        for(const [key,value] of old)s.put(value,PREFIX+key);
        if(!old.has(WS))s.put('{"projects":[]}',PREFIX+WS);
        s.put({migratedAt:info.migratedAt,entries:[...old]},ARCHIVE);
        s.put(info,META);
      };
      await done;disk=await readAll();
      if(!already){
        for(const [key,value] of old)if(disk.map.get(key)!==value)throw Error('移行後の記録照合に失敗しました。元データは削除していません。');
        cleanLegacy(old);
      }
    }else if(old.size){
      // A pre-migration tab must not silently revive/overwrite newer records.
      const archived=new Map(disk.archive?.entries||[]);
      for(const [key,value] of old)if(archived.get(key)!==value && disk.map.get(key)!==value)
        throw Error('旧版の画面で変更された記録があります。どちらも上書きせず停止しました。旧版の控えを書き出してから確認してください。');
      cleanLegacy(old);
    }
    for(const [key,value] of disk.map){if(!managed(key)||typeof value!=='string')throw Error('保存記録の形式を確認できません');JSON.parse(value);}
    memory=disk.map;revision=Number(disk.meta.revision)||0;migrationInfo=disk.meta;
    try{localStorage.setItem(MARKER,'1');}catch(_){}
    initialized=true;notify();return true;
  }
  function init(){if(!boot)boot=initialize();return boot;}
  async function commitBatch(batch){
    const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);let conflict=false;
    s.get(META).onsuccess=e=>{
      if(!e.target.result || Number(e.target.result.revision)!==revision){conflict=true;tx.abort();return;}
      for(const [key,value] of batch){if(value===null)s.delete(PREFIX+key);else s.put(value,PREFIX+key);}
      s.put({...e.target.result,revision:revision+1,updatedAt:new Date().toISOString()},META);
    };
    try{await done;}catch(e){if(conflict)throw Error('別の画面で記録が変更されています。上書きを止めました。未保存の記録を退避してから画面を更新してください。');throw e;}
    revision++;
  }
  function kick(){if(queued || failure)return;queued=true;queueMicrotask(()=>{queued=false;flush().catch(()=>{});});}
  function batch(writes){
    assertReady();if(exclusive)throw Error('バックアップの復元中です');
    const entries=[...writes];
    for(const [key,value] of entries)if(!managed(key)||(value!==null&&typeof value!=='string'))throw Error('保存する記録の形式が不正です');
    for(const [key,value] of entries){
      if((memory.get(key)??null)===value)continue;
      if(value===null)memory.delete(key);else memory.set(key,value);
      pending.set(key,value);
    }
    if(pending.size){notify();kick();}
  }
  function flush(){
    assertReady();if(flight)return flight;if(failure)return Promise.reject(failure);
    if(!pending.size)return Promise.resolve();
    flight=(async()=>{
      try{
        await connect();
        while(pending.size){
          const write=pending;pending=new Map();inFlight=write.size;notify();
          try{await commitBatch(write);}catch(error){
            for(const [k,v] of write)if(!pending.has(k))pending.set(k,v);
            failure=error;report('records',error);throw error;
          }finally{inFlight=0;}
        }
        recovered('records');
      }finally{flight=null;notify();}
    })();
    return flight;
  }
  async function retry(){failure=null;try{await flush();}catch(e){report('records',e);throw e;}}
  async function replaceAll(records,files){
    await flush();exclusive=true;operation=true;notify();
    try{
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);let conflict=false;
      let archive=null;
      s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
      s.get(META).onsuccess=e=>{
        if(!e.target.result || Number(e.target.result.revision)!==revision){conflict=true;tx.abort();return;}
        s.clear();s.put(archive,ARCHIVE);
        for(const [k,v] of records)s.put(v,PREFIX+k);
        for(const f of files)s.put(f.value,f.key);
        s.put({...e.target.result,revision:revision+1,restoredAt:new Date().toISOString()},META);
      };
      try{await done;}catch(e){if(conflict)throw Error('別の画面で記録が更新されたため復元を中止しました');throw e;}
      revision++;memory=new Map(records);recovered('import');
    }catch(e){report('import',e);throw e;}
    finally{exclusive=false;operation=false;notify();}
  }
  async function stats(){
    assertReady();const totals={records:0,drawings:0,photos:0,archive:0,other:0,drawingCount:0,photoCount:0};
    const tx=transaction('readonly'),done=complete(tx),q=tx.objectStore(STORE).openCursor();
    q.onsuccess=()=>{
      const c=q.result;if(!c)return;const k=String(c.key),v=c.value;
      if(k.startsWith(PREFIX))totals.records+=new Blob([v]).size;
      else if(k===ARCHIVE)totals.archive+=new Blob([JSON.stringify(v||{})]).size;
      else if(v instanceof Blob){
        if(k.startsWith('background:')||k==='background'){totals.drawings+=v.size;totals.drawingCount++;}
        else if(k.startsWith('photo:')){totals.photos+=v.size;totals.photoCount++;}
        else totals.other+=v.size;
      }c.continue();
    };
    await done;return totals;
  }
  window.SentlogRecords={init,flush,retry,batch,replaceAll,stats,
    get ready(){return initialized;},get pending(){return pending.size+inFlight>0||operation;},get failed(){return failures.size>0;},
    get issues(){return [...failures];},get migration(){return migrationInfo;},
    getItem:k=>{assertReady();return memory.get(k)??null;},
    setItem:(k,v)=>batch([[k,String(v)]]),removeItem:k=>batch([[k,null]]),keys:()=>[...memory.keys()],
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},report,recovered,
    assertSafe(){assertReady();if(failure || failures.size)throw failure||Error('端末内の保存エラーを確認してください');}
  };
})();

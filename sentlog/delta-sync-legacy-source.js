/* Read-only source capture for the isolated delta migration prototype.
 * No upgrade, put, delete, clear, legacy cleanup, or activation is performed.
 * The record database is read in one readonly transaction. Original photos
 * and the capture intent live elsewhere: callers must recheck before calling
 * a staged copy verified. A verified copy is never a writer fence or a receipt.
 */
(function(root){
  'use strict';
  const DB='surveyFieldNoteDB', ORIGINALS='sentlog-original-photos-v1';
  const STORE='files', PREFIX='__sentlog_record__:', META='__sentlog_records_meta_v130__';
  const WS='surveyFieldNoteWorkspaceV1', DRAW='surveyFieldNoteDrawingV1:';
  const SYNC='sentlogCloudProjectSyncV2:', INTENT='sentlogPhotoCaptureIntentV1';
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
  const isBlob=x=>x&&typeof x.size==='number'&&typeof x.type==='string'&&typeof x.arrayBuffer==='function';
  function problem(code,message){return Object.assign(Error(message),{code});}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  function sorted(values){return [...values].sort((a,b)=>String(a.key).localeCompare(String(b.key),'en'));}
  function canonical(value,seen=new Set()){
    if(value===undefined)return ['undefined'];
    if(value===null)return ['null'];
    if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
    if(typeof value==='number'){
      insist(Number.isFinite(value),'LEGACY_SOURCE_FORMAT','旧保存情報に不正な数値があります');
      return ['number',Object.is(value,-0)?'-0':value];
    }
    insist(typeof value==='object'&&!seen.has(value),'LEGACY_SOURCE_FORMAT','旧保存情報の構造を確認できません');
    insist(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,
      'LEGACY_SOURCE_FORMAT','旧保存情報に未対応の形式があります');
    seen.add(value);
    const result=Array.isArray(value)?['array',value.map(v=>canonical(v,seen))]:
      ['object',Object.keys(value).sort().map(k=>[k,canonical(value[k],seen)])];
    seen.delete(value);return result;
  }
  function createSource(options={}){
    const factory=options.indexedDB||root.indexedDB;
    const storage=options.localStorage||root.localStorage;
    const crypto=options.crypto||root.crypto;
    const name=options.databaseName||DB,originalName=options.originalDatabaseName||ORIGINALS;
    const permitted=(value,expected)=>value===expected||/^sentlog-delta-test-[a-zA-Z0-9_-]{1,120}$/.test(value);
    insist(permitted(name,DB)&&permitted(originalName,ORIGINALS)&&name!==originalName,
      'LEGACY_SOURCE_CONFIG','旧保存先の名前を確認できません');
    insist(factory&&typeof factory.open==='function'&&typeof root.structuredClone==='function'&&
      storage&&typeof storage.getItem==='function'&&crypto?.subtle?.digest,
      'LEGACY_SOURCE_CONFIG','旧保存情報を安全に読み取る機能がありません');
    const copy=x=>root.structuredClone(x);
    const connections=new Set();let closed=false;
    function active(){insist(!closed,'LEGACY_SOURCE_CLOSED','旧保存情報の確認は終了しています');}
    function readIntent(){
      active();const value=storage.getItem(INTENT);
      insist(value===null||typeof value==='string','LEGACY_SOURCE_INTENT','撮影操作の控えを読み取れません');
      return value;
    }
    async function hash(blob){
      active();const bytes=await blob.arrayBuffer();active();
      const digest=await crypto.subtle.digest('SHA-256',bytes);active();
      return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    }
    async function openExisting(databaseName,stores){
      active();
      if(typeof factory.databases==='function'){
        const listed=await factory.databases();active();
        if(!listed.some(x=>x.name===databaseName))return null;
      }
      return new Promise((resolve,reject)=>{
        let request,missing=false,ended=false;
        const fail=e=>{if(!ended){ended=true;reject(e);}};
        try{request=factory.open(databaseName);}catch(e){fail(e);return;}
        // With no databases() support, abort the implicit creation of an absent
        // DB. We never request a version and never create/upgrade a store.
        request.onupgradeneeded=()=>{missing=true;request.transaction.abort();};
        request.onerror=()=>{
          if(missing&&!ended){ended=true;resolve(null);}
          else fail(request.error||problem('LEGACY_SOURCE_OPEN','旧保存先を開けません'));
        };
        request.onblocked=()=>fail(problem('LEGACY_SOURCE_BLOCKED','旧保存先を別の処理が使用しています'));
        request.onsuccess=()=>{
          const db=request.result;
          if(ended||closed||missing){db.close();fail(problem('LEGACY_SOURCE_CLOSED','旧保存先の確認を中止しました'));return;}
          if(db.version!==1||stores.some(s=>!db.objectStoreNames.contains(s))){
            db.close();fail(problem('LEGACY_SOURCE_SCHEMA','旧保存先の版または形式が未対応です。変更せず停止しました'));return;
          }
          connections.add(db);db.onversionchange=()=>{db.close();connections.delete(db);};
          ended=true;resolve(db);
        };
      });
    }
    function release(db){if(db){db.close();connections.delete(db);}}
    function readTransaction(db,stores,read){
      active();return new Promise((resolve,reject)=>{
        let tx;
        try{tx=db.transaction(stores,'readonly');}catch(e){reject(e);return;}
        const context={value:null,error:null};
        const abort=error=>{context.error=error;try{tx.abort();}catch(_){reject(error);}};
        tx.oncomplete=()=>{try{active();resolve(context.value);}catch(e){reject(e);}};
        tx.onabort=()=>reject(context.error||tx.error||problem('LEGACY_SOURCE_ABORTED','旧保存情報の読取りが中断されました'));
        tx.onerror=()=>{};
        try{read(tx,context,abort);}catch(e){abort(e);}
      });
    }
    function issue(list,code,message,details={}){list.push({code,message,blocking:true,...details});}
    function parseRaw(raw,label,issues){
      if(typeof raw!=='string'){
        issue(issues,'LEGACY_SOURCE_MISSING',label+'の保存内容を読み取れません');return null;
      }
      try{return JSON.parse(raw);}catch(_){issue(issues,'LEGACY_SOURCE_JSON',label+'の保存形式が不正です');return null;}
    }
    async function captureRecords(projectId,issues){
      const db=await openExisting(name,[STORE]);
      if(!db){
        issue(issues,'LEGACY_SOURCE_DATABASE_MISSING','旧版の記録保存先が見つかりません');
        return {present:false,meta:null,entries:[],blobs:[],drawings:[],states:new Map(),photoRefs:[]};
      }
      try{return await readTransaction(db,[STORE],(tx,context,abort)=>{
        const store=tx.objectStore(STORE),entries=new Map(),blobs=new Map(),states=new Map();
        const result={present:true,meta:null,entries,blobs,drawings:[],states,photoRefs:[]};context.value=result;
        let workspaceRaw,keys,meta,waiting=3;
        function select(){
          if(--waiting)return;
          try{
            result.meta=meta??null;entries.set(WS,workspaceRaw??null);
            if(!object(meta)||meta.schema!==1||!Number.isSafeInteger(meta.revision)||meta.revision<0)
              issue(issues,'LEGACY_SOURCE_META','旧版の保存履歴を確認できません');
            const workspace=parseRaw(workspaceRaw,'案件一覧',issues);
            if(!Array.isArray(workspace?.projects)){issue(issues,'LEGACY_SOURCE_WORKSPACE','案件一覧の構造を確認できません');return;}
            const projects=workspace.projects.filter(p=>p?.id===projectId);
            if(projects.length!==1){issue(issues,'LEGACY_SOURCE_PROJECT','対象案件を一意に特定できません');return;}
            if(!Array.isArray(projects[0].drawings)){issue(issues,'LEGACY_SOURCE_DRAWINGS','対象案件の図面一覧を確認できません');return;}
            const ids=new Set();
            for(const drawing of projects[0].drawings){
              if(!valid(drawing?.id)||ids.has(drawing.id)){
                issue(issues,'LEGACY_SOURCE_DRAWING_ID','図面IDが不正または重複しています');continue;
              }
              ids.add(drawing.id);result.drawings.push(copy(drawing));
            }
            const rawKeys=new Set([SYNC+projectId,'sentlogArchiveLocalV1']);
            for(const id of ids){rawKeys.add(DRAW+id);rawKeys.add('sentlogReplaceBackupV1:'+id);}
            for(const key of keys){
              if(typeof key==='string'&&key.startsWith(PREFIX+'sentlogSyncMergeCheckpointV1:'+projectId+':'))
                rawKeys.add(key.slice(PREFIX.length));
            }
            function getBlob(key){
              if(blobs.has(key))return;
              blobs.set(key,null);const q=store.get(key);
              q.onsuccess=()=>blobs.set(key,q.result??null);
            }
            // Include every stored shared asset for these drawings, including
            // an unattached capture or a photo kept in collaboration history.
            for(const key of keys){
              if(typeof key!=='string')continue;
              if([...ids].some(id=>key==='background:'+id||key.startsWith('photo:'+id+':')))getBlob(key);
            }
            for(const drawing of result.drawings)getBlob('background:'+drawing.id);
            for(const key of rawKeys){
              const q=store.get(PREFIX+key);
              q.onsuccess=()=>{
                try{
                  const raw=q.result??null;entries.set(key,raw);
                  if(!key.startsWith(DRAW)){
                    if(raw!==null)parseRaw(raw,key,issues);return;
                  }
                  const drawingId=key.slice(DRAW.length),state=parseRaw(raw,'図面 '+drawingId,issues);
                  states.set(drawingId,state);
                  if(!Array.isArray(state?.shapes)){issue(issues,'LEGACY_SOURCE_RECORDS','図面の記録一覧を確認できません',{drawingId});return;}
                  const records=new Set();
                  for(const record of state.shapes){
                    if(!valid(record?.id)||records.has(record.id)){
                      issue(issues,'LEGACY_SOURCE_RECORD_ID','記録IDが不正または重複しています',{drawingId});continue;
                    }
                    records.add(record.id);
                    if(own(record,'photos')&&!Array.isArray(record.photos)){
                      issue(issues,'LEGACY_SOURCE_PHOTOS','写真一覧の形式を確認できません',{drawingId,recordId:record.id});continue;
                    }
                    for(const photo of record.photos||[]){
                      if(!valid(photo?.id)){
                        issue(issues,'LEGACY_SOURCE_PHOTO_ID','写真IDを確認できません',{drawingId,recordId:record.id});continue;
                      }
                      result.photoRefs.push({drawingId,recordId:record.id,photo:copy(photo)});
                      getBlob('photo:'+drawingId+':'+photo.id);
                    }
                  }
                }catch(e){abort(e);}
              };
            }
          }catch(e){abort(e);}
        }
        const qw=store.get(PREFIX+WS),qm=store.get(META),qk=store.getAllKeys();
        qw.onsuccess=()=>{workspaceRaw=qw.result;select();};
        qm.onsuccess=()=>{meta=qm.result;select();};
        qk.onsuccess=()=>{keys=qk.result;select();};
      });}finally{release(db);}
    }
    function relevant(target,projectId,drawingIds){
      return target?.projectId===projectId||drawingIds.has(target?.drawingId)||drawingIds.has(target?.storageDrawingId);
    }
    function captureIntents(raw,projectId,drawingIds,issues){
      const ids=new Set();
      if(raw===null)return ids;
      const journal=parseRaw(raw,'撮影操作の控え',issues);
      if(!object(journal)||journal.version!==1||!object(journal.entries)||!object(journal.operations)){
        issue(issues,'LEGACY_SOURCE_CAPTURE_FORMAT','撮影操作の控えを確認できません');return ids;
      }
      for(const entry of Object.values(journal.entries)){
        if(!object(entry)){issue(issues,'LEGACY_SOURCE_CAPTURE_FORMAT','撮影待ちの内容を確認できません');continue;}
        const unassigned=!valid(entry.target?.projectId)&&!valid(entry.target?.drawingId);
        if(relevant(entry.target,projectId,drawingIds)||relevant(entry,projectId,drawingIds)||unassigned){
          if(valid(entry.photoId)&&valid(entry.storageDrawingId))ids.add(entry.storageDrawingId+':'+entry.photoId);
          if(entry.status!=='attached')issue(issues,'LEGACY_SOURCE_PENDING_CAPTURE','記録に追加する前の写真があります。撮影操作の控えを保持しました',
            {photoId:entry.photoId||null,operationId:entry.operationId||null});
        }
      }
      for(const operation of Object.values(journal.operations)){
        const unassigned=!valid(operation?.target?.projectId)&&!valid(operation?.target?.drawingId);
        if(relevant(operation?.target,projectId,drawingIds)||unassigned)
          issue(issues,'LEGACY_SOURCE_CAPTURE_IN_PROGRESS','完了を確認できない撮影操作があります。控えを保持しました',
            {operationId:operation?.operationId||null});
      }
      return ids;
    }
    async function captureOriginals(projectId,drawingIds,intentIds,issues){
      let db;
      try{db=await openExisting(originalName,['photos','meta']);}
      catch(e){
        issue(issues,'LEGACY_SOURCE_ORIGINALS_UNAVAILABLE','原本写真の保存先を確認できません。旧保存先は変更していません',{reasonCode:e.code||e.name||'ERROR'});
        return {present:null,metas:[],blobs:[]};
      }
      if(!db){
        issue(issues,'LEGACY_SOURCE_ORIGINALS_MISSING','この端末に原本写真の保存先はありません。別端末やPCにある原本の完全性は未確認です',{blocking:false});
        for(const key of intentIds)issue(issues,'LEGACY_SOURCE_EXPECTED_ORIGINAL_MISSING',
          '撮影操作が参照する原本を確認できません。撮影操作の控えを保持しました',{key});
        return {present:false,metas:[],blobs:[]};
      }
      try{return await readTransaction(db,['photos','meta'],(tx,context,abort)=>{
        const metas=tx.objectStore('meta'),photos=tx.objectStore('photos');
        const result={present:true,metas:new Map(),blobs:new Map()};context.value=result;
        let allKeys,allMeta,photoKeys,waiting=3;
        function select(){
          if(--waiting)return;
          try{
            const wanted=new Set(intentIds);
            for(let i=0;i<allKeys.length;i++){
              const key=allKeys[i],meta=allMeta[i],association=meta?.photoAssociation;
              const unassignedPending=association&&association.status!=='attached'&&
                !valid(association.target?.projectId)&&!valid(meta?.projectId)&&!valid(meta?.drawingId);
              if(relevant(meta,projectId,drawingIds)||relevant(association?.target,projectId,drawingIds)||
                 wanted.has(key)||unassignedPending){
                result.metas.set(key,meta);wanted.add(key);
                if((drawingIds.has(meta?.drawingId)&&valid(meta?.projectId)&&meta.projectId!==projectId)||
                   (relevant(meta,projectId,drawingIds)&&valid(association?.target?.projectId)&&association.target.projectId!==projectId))
                  issue(issues,'LEGACY_SOURCE_ORIGINAL_SCOPE','原本写真の案件情報が図面または撮影先と一致しません',{key});
                if(association&&association.status!=='attached')issue(issues,'LEGACY_SOURCE_PENDING_ORIGINAL',
                  '原本保存後、記録への追加が完了していない写真があります',{key});
              }
            }
            for(const key of photoKeys){
              if(typeof key==='string'&&[...drawingIds].some(id=>key.startsWith(id+':')))wanted.add(key);
            }
            for(const key of wanted){
              if(!result.metas.has(key)){
                result.metas.set(key,null);issue(issues,'LEGACY_SOURCE_ORIGINAL_META_MISSING','原本写真に対応する保存情報がありません',{key});
              }
              const q=photos.get(key);q.onsuccess=()=>result.blobs.set(key,q.result??null);
            }
          }catch(e){abort(e);}
        }
        const qk=metas.getAllKeys(),qm=metas.getAll(),qp=photos.getAllKeys();
        qk.onsuccess=()=>{allKeys=qk.result;select();};qm.onsuccess=()=>{allMeta=qm.result;select();};
        qp.onsuccess=()=>{photoKeys=qp.result;select();};
      });}finally{release(db);}
    }
    function material(snapshot){
      return {version:snapshot.version,kind:snapshot.kind,projectId:snapshot.projectId,source:snapshot.source,
        rawEntries:snapshot.rawEntries,captureIntentRaw:snapshot.captureIntentRaw,originals:snapshot.originals,
        files:snapshot.files.map(({blob,...descriptor})=>descriptor),manifest:snapshot.manifest,
        issues:snapshot.issues,readyForStaging:snapshot.readyForStaging,readyForActivation:false};
    }
    async function fingerprint(snapshot){return hash(new Blob([JSON.stringify(canonical(material(snapshot)))]));}
    async function capture(projectId){
      active();insist(valid(projectId),'LEGACY_SOURCE_PROJECT','確認する案件IDが不正です');
      const issues=[],captureIntentRaw=readIntent();
      const records=await captureRecords(projectId,issues);
      const drawingIds=new Set(records.drawings.map(d=>d.id));
      const intentIds=captureIntents(captureIntentRaw,projectId,drawingIds,issues);
      const originals=await captureOriginals(projectId,drawingIds,intentIds,issues);
      const snapshot={version:1,kind:'sentlog-legacy-source',projectId,
        source:{databaseName:name,originalDatabaseName:originalName,recordsPresent:records.present,
          recordRevision:records.meta?.revision??null,recordMeta:copy(records.meta),originalsPresent:originals.present,
          originalCompleteness:'unknown',capturedOriginalCount:0},
        rawEntries:sorted([...records.entries].map(([key,value])=>({key,value:copy(value)}))),captureIntentRaw,
        originals:sorted([...originals.metas].map(([key,meta])=>({key,meta:copy(meta)}))),
        files:[],manifest:[],issues,readyForStaging:false,readyForActivation:false};
      if(!records.present)snapshot.manifest.push({key:name,kind:'database',status:'missing'});
      if(originals.present!==true)snapshot.manifest.push({key:originalName,kind:'original-database',
        status:originals.present===false?'not-present-in-source':'unavailable'});
      const metadata=new Map();
      for(const ref of records.photoRefs){
        const key='photo:'+ref.drawingId+':'+ref.photo.id,rows=metadata.get(key)||[];
        rows.push(ref);metadata.set(key,rows);
      }
      async function addFile(descriptor,value,required,expected=[]){
        if(!isBlob(value)||value.size===0){
          if(value!==null&&value!==undefined||required){
            issue(issues,'LEGACY_SOURCE_FILE_MISSING','写真または図面ファイルを確認できません',{key:descriptor.key});
            snapshot.manifest.push({...descriptor,status:'recovery-required'});
          }else snapshot.manifest.push({...descriptor,status:'not-present',required:false});
          return;
        }
        const sha256=await hash(value),file={...descriptor,blob:value,size:value.size,type:value.type,sha256};
        let status='verified-copy-source';
        for(const spec of expected){
          if((own(spec,'size')&&(!Number.isSafeInteger(spec.size)||spec.size!==value.size))||
             (own(spec,'sha256')&&(typeof spec.sha256!=='string'||spec.sha256.toLowerCase()!==sha256))){
            status='content-mismatch';issue(issues,'LEGACY_SOURCE_FILE_MISMATCH','保存情報と写真の内容が一致しません。両方を保持しました',{key:descriptor.key});break;
          }
        }
        snapshot.files.push(file);const {blob,...manifest}=file;snapshot.manifest.push({...manifest,status});
      }
      for(const [key,value]of [...records.blobs].sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'en'))){
        const candidates=records.drawings.filter(d=>key==='background:'+d.id||key.startsWith('photo:'+d.id+':'));
        if(candidates.length!==1)issue(issues,'LEGACY_SOURCE_ASSET_ID_COLLISION','ファイルキーから図面を一意に特定できません',{key});
        const drawing=candidates[0];
        const background=key==='background:'+drawing?.id,drawingId=drawing?.id||'';
        const refs=metadata.get(key)||[],state=records.states.get(drawingId);
        const required=!background||!!(drawing?.sourceType||drawing?.fileName||state?.sourceType||state?.fileName);
        const descriptor={key,kind:background?'background':'photo',sourceDatabase:name,sourceKey:key,drawingId,
          ...(background?{}:{photoId:key.slice(('photo:'+drawingId+':').length)})};
        // Conflicting metadata are kept, never collapsed to the last record.
        const signatures=new Set(refs.map(r=>JSON.stringify(canonical([r.photo.name??null,r.photo.size??null,r.photo.sha256??null]))));
        if(signatures.size>1)issue(issues,'LEGACY_SOURCE_PHOTO_COLLISION','同じ写真IDに異なる保存情報があります',{key});
        await addFile(descriptor,value,required,refs.map(r=>r.photo));
      }
      for(const [key,value]of [...originals.blobs].sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'en'))){
        const meta=originals.metas.get(key),drawingId=meta?.drawingId||[...drawingIds].find(id=>String(key).startsWith(id+':'))||'';
        const photoId=meta?.photoId||String(key).slice(drawingId.length+1);
        if(!valid(key)||!valid(drawingId)||!valid(photoId)||key!==drawingId+':'+photoId||meta?.key!==key)
          issue(issues,'LEGACY_SOURCE_ORIGINAL_ID','原本写真の保存場所と識別情報が一致しません',{key});
        await addFile({key:'original:'+key,kind:'original-photo',sourceDatabase:originalName,sourceKey:key,drawingId,photoId},value,true,meta?[meta]:[]);
      }
      const originalKeys=new Set([...originals.metas].map(([key])=>key));
      const originalRefs=new Map(records.photoRefs.map(ref=>[ref.drawingId+':'+ref.photo.id,ref]));
      let absentOriginal=false;
      for(const [key,ref]of originalRefs){
        if(originalKeys.has(key))continue;
        absentOriginal=true;
        issue(issues,'LEGACY_SOURCE_ORIGINAL_NOT_LOCAL','この写真の原本は旧保存先にありません。別端末撮影または原本保存機能追加前の写真の可能性があります',
          {key,blocking:false,status:'original-not-present-in-source'});
        snapshot.manifest.push({key:'original:'+key,kind:'original-photo',sourceDatabase:originalName,sourceKey:key,
          drawingId:ref.drawingId,photoId:ref.photo.id,status:'original-not-present-in-source'});
      }
      snapshot.source.capturedOriginalCount=snapshot.files.filter(f=>f.kind==='original-photo').length;
      const incompleteOriginal=issues.some(x=>x.blocking&&(/ORIGINAL/.test(x.code)||
        x.key?.startsWith('original:')));
      snapshot.source.originalCompleteness=incompleteOriginal?'incomplete':
        originals.present===true&&!absentOriginal?'verified-local':'unknown';
      // This comparison detects same-tab intent changes while hashing. A final
      // recheck is still required because these stores cannot share one tx.
      const after=readIntent();
      if(after!==captureIntentRaw){
        snapshot.source.captureIntentAfterRaw=after;
        issue(issues,'LEGACY_SOURCE_CHANGED','確認中に撮影操作が変更されました。控えを確定しません');
      }
      snapshot.files=sorted(snapshot.files);snapshot.manifest=sorted(snapshot.manifest);
      snapshot.issues.sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)),'en'));
      snapshot.readyForStaging=!issues.some(x=>x.blocking);
      snapshot.fingerprint=await fingerprint(snapshot);return snapshot;
    }
    async function recheck(snapshot){
      active();insist(snapshot?.version===1&&snapshot.kind==='sentlog-legacy-source'&&valid(snapshot.projectId)&&
        snapshot.source?.databaseName===name&&snapshot.source?.originalDatabaseName===originalName&&
        typeof snapshot.fingerprint==='string','LEGACY_SOURCE_SNAPSHOT','確認する旧保存情報が一致しません');
      insist(await fingerprint(snapshot)===snapshot.fingerprint,'LEGACY_SOURCE_SNAPSHOT_CHANGED','確認用の控えが変更されています');
      const current=await capture(snapshot.projectId);
      const unchanged=current.fingerprint===snapshot.fingerprint;
      return {unchanged,sourceChanged:!unchanged,expectedFingerprint:snapshot.fingerprint,
        actualFingerprint:current.fingerprint,issues:current.issues,
        readyForStaging:unchanged&&current.readyForStaging,readyForActivation:false};
    }
    function close(){closed=true;for(const db of connections)db.close();connections.clear();}
    return {capture,recheck,close};
  }
  const api={version:1,createSource};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaLegacySource=api;
})(typeof window!=='undefined'?window:globalThis);

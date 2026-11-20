/* Release redundant local copies only after the company PC re-verifies the
 * complete certified archive. Other histories and camera originals remain.
 * Cross-database copies are released before the visible-file transaction;
 * interruption therefore leaves the ordinary local files available to retry.
 */
(function(root){
  'use strict';
  const req=name=>typeof module==='object'&&module.exports?require('./'+name+'.js'):null;
  const Migration=root.SentlogDeltaMigration||req('delta-sync-migration');
  const Assets=root.SentlogDeltaAssets||req('delta-sync-assets');
  const copy=value=>root.structuredClone(value),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function assert(ok,code,message){if(!ok)throw fail(code,message);}
  function checked(fn){
    assert(typeof fn==='function','CAPACITY_GC_GUARD','整理中の保存先を確認する方法が必要です');
    const result=fn();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
    assert(result===true&&!(result&&typeof result.then==='function'),'CAPACITY_GC_CHANGED','確認中に保存先または記録が変更されました');
  }
  function catalog(info,cp,scope){
    const operation=info?.operation,job=info?.job,certificate=job?.delta_checkpoint;
    assert(cp.status==='archived'&&!cp.retired&&!cp.checking&&object(operation)&&object(job)&&
      operation.state==='ready'&&operation.action==='verify'&&['files','project'].includes(operation.mode)&&
      operation.project_id===cp.id&&operation.owner_id===scope.ownerId&&operation.device_id===scope.deviceId&&
      operation.job_id===job.id&&job.project_id===cp.id&&job.payload?.project?.id===cp.client_key&&
      typeof operation.id==='string'&&operation.id&&typeof operation.pc_device_id==='string'&&operation.pc_device_id&&
      Number.isFinite(Date.parse(operation.pc_ready_at))&&Date.parse(operation.expires_at)>Date.now()&&
      certificate?.schema===1&&certificate.projectId===cp.id&&certificate.revision===job.revision&&
      Number.isSafeInteger(certificate.headSeq)&&certificate.headSeq>=0&&Number.isSafeInteger(certificate.revision)&&certificate.revision>0&&
      digest(certificate.payloadSha256)&&digest(job.catalog_hash)&&digest(job.pc_receipt?.package_sha256)&&
      job.pc_receipt.catalog_hash===job.catalog_hash&&Array.isArray(job.manifest)&&Array.isArray(info.files)&&
      job.pc_receipt.file_count===job.manifest.length&&info.files.length===job.manifest.length,
      'CAPACITY_GC_PROOF','会社PCの最新の保管照合と、この端末の整理対象が一致しません');
    const allowed=new Set(),drawings=[...(job.payload.drawings||[]),...(job.payload.project.deltaMetadata?.retainedDrawings||[])];
    for(const drawing of drawings){
      const id=drawing?.meta?.id;assert(typeof id==='string'&&id,'CAPACITY_GC_PROOF','保管図面の識別情報が不正です');
      allowed.add('background:'+id);
      for(const record of [...(drawing.state?.shapes||[]),...(drawing.state?.collabDeletedRecords||[])]){
        for(const photo of record.photos||[])if(typeof photo?.id==='string'&&photo.id)allowed.add('photo:'+id+':'+photo.id);
        for(const [photoId,entry]of Object.entries(record.collab?.photos||{})){
          for(const revision of entry.revisions||[]){assert(revision.value?.id===photoId,'CAPACITY_GC_PROOF','写真の保管履歴を照合できません');allowed.add('photo:'+id+':'+photoId);}
        }
      }
    }
    function normalize(rows){
      const files=new Map(),ids=new Set();
      for(const item of rows){
        assert(object(item)&&typeof item.id==='string'&&item.id&&!ids.has(item.id)&&typeof item.key==='string'&&allowed.has(item.key)&&!files.has(item.key)&&
          (item.kind==='drawing'&&item.key.startsWith('background:')||item.kind==='photo'&&item.key.startsWith('photo:'))&&
          Number.isSafeInteger(Number(item.byte_size))&&Number(item.byte_size)>0&&digest(item.sha256)&&typeof item.mime_type==='string'&&item.mime_type,
          'CAPACITY_GC_CATALOG','保管対象外または不完全なファイルを整理することはできません');
        ids.add(item.id);files.set(item.key,{key:item.key,assetId:item.id,kind:item.kind,sha256:item.sha256,size:Number(item.byte_size),mimeType:item.mime_type});
      }
      return files;
    }
    const saved=normalize(job.manifest),selected=normalize(info.files);
    assert([...saved].every(([key,file])=>JSON.stringify(file)===JSON.stringify(selected.get(key))),
      'CAPACITY_GC_CATALOG','PCの保管一覧と端末の整理一覧が一致しません');
    return [...saved.values()];
  }
  async function release({records,cloudProject:inputProject,info:inputInfo,proof,getScope,validateScope,apply,factories={}}={}){
    assert(typeof apply==='function','CAPACITY_GC_CONFIG','端末の整理処理が必要です');
    // A legacy archive has no delta migration/replica copies to collect.
    if(!inputInfo?.job?.delta_checkpoint){const value=await apply(null);return {releasedCopies:0,releasedBytes:0,value};}
    assert(records?.deltaJournal?.prepareArchivedRelease&&records.deltaJournal.archivedReleaseResult&&proof?.delta===true&&
      typeof proof.validate==='function'&&typeof proof.validateSync==='function'&&typeof getScope==='function',
      'CAPACITY_GC_CONFIG','差分保存と保管控えの照合機能が必要です');
    const cp=copy(inputProject),info=copy(inputInfo),identity=copy(getScope());
    const scope={ownerId:identity?.ownerId,projectId:cp.id,deviceId:identity?.deviceId};
    assert(scope.ownerId&&scope.deviceId,'CAPACITY_GC_SCOPE','ログインと端末を確認してください');
    const files=catalog(info,cp,scope),certificate=info.job.delta_checkpoint;
    function validate(){
      const current=getScope();assert(current?.ownerId===scope.ownerId&&current?.deviceId===scope.deviceId,
        'CAPACITY_GC_SCOPE','ログインまたは端末が変更されました');
      assert(Date.parse(info.operation.expires_at)>Date.now(),'CAPACITY_GC_EXPIRED','PCの照合期限が切れました。もう一度確認してください');
      checked(validateScope);checked(proof.validateSync);return true;
    }
    validate();await proof.validate();validate();
    const args={scope,localProjectId:cp.client_key,certificate,jobId:info.job.id,operationId:info.operation.id,mode:info.operation.mode,files,validate};
    const ticket=await records.deltaJournal.prepareArchivedRelease(args);validate();
    const opened=[],totals={releasedCopies:0,releasedBytes:0};
    function add(result){
      assert(Number.isSafeInteger(result?.releasedCopies)&&result.releasedCopies>=0&&Number.isSafeInteger(result?.releasedBytes)&&result.releasedBytes>=0&&
        Number.isSafeInteger(totals.releasedCopies+result.releasedCopies)&&Number.isSafeInteger(totals.releasedBytes+result.releasedBytes),
        'CAPACITY_GC_RESULT','保管済みコピーの整理結果を確認できません');
      totals.releasedCopies+=result.releasedCopies;totals.releasedBytes+=result.releasedBytes;
    }
    try{
      for(const factory of [factories.migrationStore||Migration.createStore,factories.assetStore||Assets.createIndexedDBStore]){
        const store=factory(scope);opened.push(store);
        assert(typeof store?.releaseArchivedCopies==='function','CAPACITY_GC_CONFIG','保管済みコピーの整理機能を読み込めません');
        await proof.validate();validate();
        const result=await store.releaseArchivedCopies(args);validate();
        add(result);
      }
      await proof.validate();validate();
      const value=await apply(ticket);
      const result=records.deltaJournal.archivedReleaseResult(ticket);
      add(result);
      return {...totals,avoidedPreimageCopies:result.avoidedPreimageCopies,value};
    }finally{for(const store of opened)store?.close?.();}
  }
  const api={version:1,release};if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaCapacityGC=api;
})(typeof window!=='undefined'?window:globalThis);

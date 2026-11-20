/* A local capacity operation proves both the shared checkpoint and the exact
 * browser rows/file generations it will mutate. Hashing happens between
 * capture and validation; archiveAtomic repeats the comparisons in its write.
 */
(function(root){
  'use strict';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOCAL='sentlogArchiveLocalV1';
  const copy=x=>root.structuredClone(x),object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function assert(ok,code,message){if(!ok)throw fail(code,message);}
  function parse(value){try{return JSON.parse(value);}catch{throw fail('DELTA_CAPACITY_RECORDS','端末の保存内容を読み取れません。変更せず中止しました');}}
  function scopeGuard(validate){
    assert(typeof validate==='function','DELTA_CAPACITY_RESTORE_SCOPE','復旧中のログインを確認する方法が必要です');
    const result=validate();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
    assert(result===true,'DELTA_CAPACITY_RESTORE_SCOPE','復旧中にログインまたは保存先が変更されました');
  }
  function restorationFiles(cp,info,scope){
    const operation=info?.operation,job=info?.job,sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    assert(cp.status==='archived'&&!cp.retired&&!cp.checking&&operation?.action==='restore'&&operation.state==='ready'&&
      ['files','project'].includes(operation.mode)&&operation.owner_id===scope.ownerId&&operation.device_id===scope.deviceId&&
      operation.project_id===cp.id&&typeof operation.id==='string'&&operation.id&&operation.job_id===job?.id&&
      job.project_id===cp.id&&job.payload?.project?.id===cp.client_key&&typeof operation.pc_device_id==='string'&&operation.pc_device_id&&
      Number.isFinite(Date.parse(operation.pc_ready_at))&&Date.parse(operation.expires_at)>Date.now()&&sha(job.catalog_hash)&&
      sha(job.pc_receipt?.package_sha256)&&job.pc_receipt.catalog_hash===job.catalog_hash&&Array.isArray(job.manifest)&&Array.isArray(info.files)&&
      job.pc_receipt.file_count===job.manifest.length&&info.files.length===job.manifest.length,
      'DELTA_CAPACITY_RESTORE_PROOF','会社PCの復旧照合と、この端末の対象が一致しません');
    function normalize(rows){const keys=new Set(),ids=new Set();return rows.map(file=>{
      assert(object(file)&&typeof file.id==='string'&&file.id&&!ids.has(file.id)&&typeof file.key==='string'&&!keys.has(file.key)&&
        (file.kind==='drawing'&&/^background:[^:]+$/.test(file.key)||file.kind==='photo'&&/^photo:[^:]+:[^:]+$/.test(file.key))&&
        Number.isSafeInteger(Number(file.byte_size))&&Number(file.byte_size)>=0&&sha(file.sha256)&&typeof file.mime_type==='string'&&file.mime_type,
        'DELTA_CAPACITY_RESTORE_PROOF','復旧する共有ファイルの一覧が不正です');
      keys.add(file.key);ids.add(file.id);return {key:file.key,assetId:file.id,kind:file.kind,sha256:file.sha256,size:Number(file.byte_size),mimeType:file.mime_type};
    });}
    const expected=normalize(job.manifest),actual=new Map(normalize(info.files).map(file=>[file.key,file]));
    assert(expected.every(file=>JSON.stringify(file)===JSON.stringify(actual.get(file.key))),
      'DELTA_CAPACITY_RESTORE_PROOF','PCの保管一覧と復旧一覧が一致しません');return expected;
  }
  function restoreFileOptions({cloudProject:cp,info,getScope,validateScope}={}){
    assert(typeof getScope==='function','DELTA_CAPACITY_RESTORE_SCOPE','復旧する利用者・端末を確認できません');
    const identity=copy(getScope()),scope={ownerId:identity?.ownerId,projectId:cp?.id,deviceId:identity?.deviceId};
    restorationFiles(cp,info,scope);const certificate=copy(info.job.delta_checkpoint||null),expires=Date.parse(info.operation.expires_at);
    function validate(){const current=getScope();assert(current?.ownerId===scope.ownerId&&current?.deviceId===scope.deviceId&&Date.now()<expires,
      'DELTA_CAPACITY_RESTORE_SCOPE','復旧中にログイン・端末またはPCの照合期限が変わりました');scopeGuard(validateScope);return true;}
    validate();return {onlyIfMissing:true,origin:'device',operation:'archive-file-restore',validate,
      context:{archiveRestore:{version:1,scope,localProjectId:cp.client_key,jobId:info.job.id,operationId:info.operation.id,certificate}}};
  }
  function fileStates(rows,keys){
    assert(Array.isArray(rows)&&rows.length===keys.length,'DELTA_CAPACITY_FILES','ファイルの保存位置を照合できません');const map=new Map();
    for(const row of rows){assert(object(row)&&typeof row.key==='string'&&keys.includes(row.key)&&!map.has(row.key)&&Number.isSafeInteger(row.sequence)&&row.sequence>=0,'DELTA_CAPACITY_FILES','ファイルの変更履歴を照合できません');map.set(row.key,row.sequence);}
    return keys.map(key=>({key,sequence:map.get(key)}));
  }
  async function createProof({records,cloudProject:cp,info,archiveProof,getScope,snapshotText,validateScope,
    mode='cleanup',isWholeRemoved=()=>false}={}){
    assert(records?.ready===true&&typeof records.getItem==='function'&&typeof records.settled==='function'&&typeof records.assertSafe==='function'&&
      typeof getScope==='function'&&object(cp)&&typeof cp.id==='string'&&typeof cp.client_key==='string'&&
      object(info?.job)&&info.job.project_id===cp.id&&info.job.payload?.project?.id===cp.client_key&&Array.isArray(info.files)&&
      ['cleanup','restore-project'].includes(mode),'DELTA_CAPACITY_CONFIG','保管対象と端末の保存先を確認できません');
    const scope=copy(getScope());assert(scope?.ownerId&&scope?.deviceId,'DELTA_CAPACITY_SCOPE','ログインと端末を確認してください');
    const sameScope=()=>{const next=getScope();return next?.ownerId===scope.ownerId&&next?.deviceId===scope.deviceId;};
    const checkScope=()=>{assert(sameScope(),'DELTA_CAPACITY_SCOPE','確認中にログインまたは端末が変わりました。変更せず中止しました');
      if(mode==='restore-project'&&info.operation)assert(Date.parse(info.operation.expires_at)>Date.now(),
        'DELTA_CAPACITY_RESTORE_EXPIRED','PCの復旧照合期限が切れました。もう一度確認してください');
      if(validateScope!==undefined)scopeGuard(validateScope);return true;};
    const certificate=info.job.delta_checkpoint;let delta=null,restorationProof=null;
    await records.settled();records.assertSafe();checkScope();
    if(certificate){
      assert(certificate.schema===1&&certificate.projectId===cp.id&&Number.isSafeInteger(certificate.headSeq)&&certificate.headSeq>=0&&
        Number.isSafeInteger(certificate.revision)&&certificate.revision>=1,'DELTA_CAPACITY_PROOF','保管版の識別情報が不正です');
      assert(typeof archiveProof==='function','DELTA_CAPACITY_PROOF','差分同期の保管照合を読み込めません');
      if(mode==='restore-project'&&records.deltaJournal?.bindingFor?.(cp.client_key)){
        scopeGuard(validateScope);const files=restorationFiles(cp,info,{...scope,projectId:cp.id});
        assert(info.operation.mode==='project'&&typeof records.deltaJournal.proveArchiveRestore==='function',
          'DELTA_CAPACITY_RESTORE_PROOF','案件復旧の保存証明を確認できません');
        restorationProof=await records.deltaJournal.proveArchiveRestore({scope:{...scope,projectId:cp.id},localProjectId:cp.client_key,
          certificate,jobId:info.job.id,files,snapshot:info.job.payload,validate:checkScope});checkScope();
      }
      delta=await archiveProof(cp,info.job,...(restorationProof?[{restorationProof}]:[]));checkScope();
      assert(object(delta)&&typeof delta.validate==='function'&&delta.schema===1&&delta.pending===0&&
        delta.headSeq===certificate.headSeq&&delta.revision===info.job.revision&&delta.revision===certificate.revision&&
        delta.payloadSha256===certificate.payloadSha256&&/^[a-f0-9]{64}$/.test(delta.payloadSha256||''),
        'DELTA_CAPACITY_PROOF','保管時と同じ共有履歴を確認できません');
      if(mode==='cleanup')assert(delta.absent!==true&&delta.cursor===delta.headSeq,'DELTA_CAPACITY_PROOF','この端末の受信済み記録を確認できません');
    }
    const raw=records.getItem(WS),ws=parse(raw||'null');
    assert(object(ws)&&Array.isArray(ws.projects),'DELTA_CAPACITY_RECORDS','端末の案件一覧を照合できません');
    const matches=ws.projects.filter(p=>p?.id===cp.client_key);assert(matches.length<=1,'DELTA_CAPACITY_RECORDS','同じ案件が複数保存されています');const p=matches[0]||null;
    if(mode==='cleanup')assert(p&&Array.isArray(p.drawings)&&!isWholeRemoved(cp.id),'DELTA_CAPACITY_RECORDS','この端末の案件を先に復旧してください');
    else assert(!p,'DELTA_CAPACITY_EXISTS','復旧先に同じ案件があります。上書きせず中止しました');
    const targets=[...(p?.drawings||[]),...(p?.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta),
      ...(info.job.payload.drawings||[]).map(d=>d.meta),...(info.job.payload.project.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta)];
    assert(targets.every(d=>typeof d?.id==='string'&&d.id.length),'DELTA_CAPACITY_RECORDS','図面の識別情報が不正です');
    const targetIds=new Set(targets.map(d=>d.id));
    for(const project of ws.projects)if(project.id!==cp.client_key){
      const other=[...(project.drawings||[]),...(project.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta)];
      assert(!other.some(d=>targetIds.has(d?.id)),'DELTA_CAPACITY_IDENTITY','別の案件と図面の識別情報が重複しています。変更せず中止しました');
    }
    const keys=[WS,...new Set(targets.map(d=>DRAW+d.id)),LOCAL],expectedRecords=keys.map(key=>[key,records.getItem(key)??null]);
    assert(expectedRecords[0][1]===raw&&expectedRecords.every(([key,value])=>(records.getItem(key)??null)===value),'DELTA_CAPACITY_CHANGED','確認中に記録が変わりました');
    if(mode==='restore-project')assert(expectedRecords.filter(([key])=>key.startsWith(DRAW)).every(([,value])=>value===null),'DELTA_CAPACITY_EXISTS','復旧先に図面記録が残っています。上書きせず中止しました');
    if(!delta&&mode==='cleanup'){
      assert(typeof snapshotText==='function','DELTA_CAPACITY_CONFIG','従来形式の保管照合を読み込めません');
      const values=new Map(expectedRecords),snapshot={project:p,drawings:p.drawings.map(meta=>({meta,state:parse(values.get(DRAW+meta.id)||'null')}))};
      assert(snapshotText(snapshot)===snapshotText(info.job.payload),'DELTA_CAPACITY_CHANGED','この端末の記録が保管時と異なります。変更せず中止しました');
    }
    const fileKeys=info.files.map(f=>f?.key);assert(fileKeys.every(key=>typeof key==='string'&&key.length)&&new Set(fileKeys).size===fileKeys.length,'DELTA_CAPACITY_FILES','ファイル一覧が不正です');
    assert(typeof records.writerState==='function'&&typeof records.readFileStates==='function','DELTA_CAPACITY_FILES','ファイルの変更を検出する保存処理が必要です');
    const generations=fileKeys.map(key=>{const value=records.writerState(key);assert(!value.pending&&!value.failed&&Number.isSafeInteger(value.generation)&&value.generation>=0,'DELTA_CAPACITY_FILES','ファイルの保存完了を待ってください');return [key,value.generation];});
    const expectedFileStates=fileStates(await records.readFileStates(fileKeys),fileKeys);checkScope();
    function validateSync(){
      checkScope();
      assert(expectedRecords.every(([key,value])=>(records.getItem(key)??null)===value)&&
        generations.every(([key,generation])=>{const value=records.writerState(key);return !value.pending&&!value.failed&&value.generation===generation;}),
        'DELTA_CAPACITY_CHANGED','確認中に記録またはファイルが変わりました。変更せず中止しました');
      return true;
    }
    async function validate(){
      checkScope();await records.settled();records.assertSafe();checkScope();if(delta)await delta.validate();checkScope();validateSync();
      const actual=fileStates(await records.readFileStates(fileKeys),fileKeys);checkScope();
      assert(actual.every((row,i)=>row.sequence===expectedFileStates[i].sequence),'DELTA_CAPACITY_CHANGED','別の画面でファイルが更新されました。変更せず中止しました');
      return validateSync();
    }
    await validate();
    return {raw,ws:copy(ws),p:copy(p),expectedRecords:copy(expectedRecords),expectedFileStates:copy(expectedFileStates),delta:!!delta,restorationProof,validate,validateSync};
  }
  const api={version:1,createProof,restoreFileOptions};if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaCapacity=api;
})(typeof window!=='undefined'?window:globalThis);

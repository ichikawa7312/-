/* Bounded, authenticated recovery for a protected migration cutoff.
 * Only the journal's restore callback may persist bytes. It verifies their
 * SHA-256 and preserves any newer live file; this helper never acknowledges,
 * uploads, removes, or automatically substitutes a different drawing revision.
 * Review tickets hold read-only candidates. A separate journal operation must
 * verify their bytes and obtain the user's explicit choice before saving them.
 */
(function(root){
  'use strict';
  const hash=x=>/^[a-f0-9]{64}$/i.test(String(x||''))?String(x).toLowerCase():'';
  const canonical=x=>JSON.stringify(x&&typeof x==='object'&&!Array.isArray(x)?
    Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):
    Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):x??null);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function assert(ok,code,message){if(!ok)throw fail(code,message);}
  const copy=x=>root.structuredClone(x);
  const cloudKey=item=>item.kind==='photo'?item.key:'drawing:'+item.drawingId;
  function expectedRevision(item){
    const markers=item.state?.pageReplacements||{};
    return Object.values(markers).filter(x=>x&&Number(x.updatedAt)>0)
      .sort((a,b)=>Number(b.updatedAt)-Number(a.updatedAt))[0]||null;
  }
  const sourceOf=x=>({id:x?.meta?.id,fileName:x?.state?.fileName??x?.meta?.fileName??'',
    sourceType:x?.state?.sourceType??x?.meta?.sourceType??null,
    pageCount:x?.state?.pageCount??x?.meta?.pageCount??null,
    pageReplacements:x?.state?.pageReplacements??{}});
  const sourceFor=item=>sourceOf({meta:item.drawing,state:item.state});
  const sameSource=(a,b)=>canonical(sourceOf(a))===canonical(sourceOf(b));
  const hasReplacements=item=>{
    const value=item.state?.pageReplacements;
    return value!=null&&(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>0);
  };
  const reviewableSource=item=>item.kind==='background'&&item.recoverable!==false&&
    !hasReplacements(item)&&sourceFor(item).sourceType==='pdf';
  const snapshotSignature=snapshot=>canonical({revision:Number(snapshot.revision),payload:snapshot.payload});
  function check(validate){
    assert(typeof validate==='function','DELTA_RECOVERY_GUARD','復旧する利用者・案件の確認が必要です');
    const result=validate();
    if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
    assert(result!==false&&!(result&&typeof result.then==='function'),
      'DELTA_RECOVERY_SCOPE','復旧中に利用者または案件が変わりました');
  }
  function issue(item,reason,message,reviewable=false){return {key:item.key,kind:item.kind,drawingId:item.drawingId,
    ...(item.photoId?{photoId:item.photoId}:{}),reason,message,reviewable};}
  function signature(asset){return canonical({id:asset.id,owner_id:asset.owner_id,project_id:asset.project_id,
    client_key:asset.client_key,kind:asset.kind,storage_path:asset.storage_path,status:asset.status,
    sha256:hash(asset.sha256),byte_size:Number(asset.byte_size),metadata:asset.metadata,file_name:asset.file_name,mime_type:asset.mime_type});}
  function safePath(asset,scope){
    const p=String(asset.storage_path||'').split('/');
    if(p.length<4||p[0]!==scope.ownerId||p[1]!==scope.projectId||
      p.some(x=>!x||x==='.'||x==='..'||/[\\\u0000-\u001f]/.test(x)))return false;
    if(p[2]==='active-restore')return p.length===7&&p[3]===asset.id&&p[4]===hash(asset.sha256)&&!!hash(p[5])&&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/i.test(p[6]);
    if(['redelivery','device-redelivery'].includes(p[2]))return p.length===5&&p[3]===asset.id;
    return p.length===4&&p[2]===(asset.kind==='photo'?'photos':'drawings');
  }
  function assetProblem(item,asset,scope,localProjectId){
    const m=asset.metadata||{},size=Number(asset.byte_size),sha256=hash(asset.sha256);
    if(asset.project_id!==scope.projectId||asset.owner_id!==scope.ownerId||
      asset.kind!==(item.kind==='photo'?'photo':'drawing')||asset.client_key!==cloudKey(item)||
      m.drawing_id!==item.drawingId||(m.local_project_key&&m.local_project_key!==localProjectId)||
      (item.kind==='photo'&&m.photo_id!==item.photoId))
      return issue(item,'ASSET_IDENTITY_MISMATCH','写真・図面の共有先または識別情報が一致しません');
    if(asset.status==='storage_deleted')return issue(item,'ASSET_UNAVAILABLE','共有先にファイルの実体がありません');
    if(typeof asset.id!=='string'||!asset.id||!asset.storage_path||!sha256||!Number.isSafeInteger(size)||size<=0)
      return issue(item,'ASSET_METADATA_INVALID','写真・図面のファイル情報を照合できません');
    if(!safePath(asset,scope))return issue(item,'ASSET_PATH_INVALID','写真・図面の保存先を照合できません');
    return null;
  }
  function sourceProblem(item,asset,snapshot,localProjectId){
    if(!snapshot||!Number.isSafeInteger(Number(snapshot.revision))||Number(snapshot.revision)<1||
      snapshot.payload?.project?.id!==localProjectId)
      return issue(item,'SNAPSHOT_UNVERIFIED','共有先の案件と保存版を確認できません');
    const rows=Array.isArray(snapshot.payload.drawings)?snapshot.payload.drawings.filter(d=>d?.meta?.id===item.drawingId):[];
    if(rows.length!==1||!sameSource({meta:item.drawing,state:item.state},rows[0]))
      return issue(item,'DRAWING_SOURCE_MISMATCH','保護した図面と共有先の図面情報が一致しません');
    const source=sourceFor(item);
    if(source.fileName&&asset.file_name!==source.fileName)
      return issue(item,'DRAWING_FILE_NAME_MISMATCH','図面のファイル名が保存情報と一致しません');
    if(source.sourceType&&asset.metadata?.source_type!==source.sourceType)
      return issue(item,'DRAWING_SOURCE_TYPE_MISMATCH','図面の形式が保存情報と一致しません');
    return null;
  }
  function proofFor(item,asset,scope,serverRevision){return {assetId:asset.id,projectId:scope.projectId,
    clientKey:asset.client_key,kind:asset.kind,sha256:hash(asset.sha256),size:Number(asset.byte_size),drawingId:item.drawingId,
    ...(item.kind==='photo'?{photoId:item.photoId}:{drawingRevision:expectedRevision(item)||null,
      snapshotRevision:Number(serverRevision),sourceType:sourceFor(item).sourceType,fileName:sourceFor(item).fileName})};}
  function createRecovery({listAssets,readAsset,download,readSnapshot,maxFiles=16,maxBytes=64*1024*1024,timeoutMs=30000}={}){
    assert([listAssets,readAsset,download,readSnapshot].every(x=>typeof x==='function'),
      'DELTA_RECOVERY_CONFIG','不足ファイルの確認方法が未設定です');
    assert(Number.isSafeInteger(maxFiles)&&maxFiles>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0,
      'DELTA_RECOVERY_CONFIG','不足ファイルの取得上限が不正です');
    assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0,'DELTA_RECOVERY_CONFIG','不足ファイルの通信期限が不正です');
    async function downloadBounded(asset){
      const controller=new AbortController();let timer;
      const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(fail('DELTA_RECOVERY_TIMEOUT','写真・図面の受信が時間切れになりました。保存済みの記録を保持して再試行します'));
      },timeoutMs);});
      try{return await Promise.race([download(asset,{signal:controller.signal}),expired]);}
      finally{clearTimeout(timer);}
    }
    const cursors=new Map(),reviews=new WeakMap();
    async function recover({scope,localProjectId,serverRevision,missing,validate,restore}={}){
      check(validate);
      const issues=(missing||[]).filter(item=>item.recoverable===false).map(item=>
        issue(item,'PROTECTED_FILE_UNREADABLE','保存済みのファイルを自動で置き換えず保持しています'));
      const eligible=(missing||[]).filter(x=>x.recoverable!==false),cursorKey=JSON.stringify([scope,localProjectId]);
      const start=eligible.length?(cursors.get(cursorKey)||0)%eligible.length:0;
      const wanted=[...eligible.slice(start),...eligible.slice(0,start)].slice(0,maxFiles);
      cursors.set(cursorKey,start+wanted.length);
      if(!wanted.length)return {restored:0,bytes:0,remaining:(missing||[]).length,issues};
      const assets=await listAssets(scope,wanted.map(cloudKey));check(validate);
      assert(Array.isArray(assets),'DELTA_RECOVERY_ASSETS','不足ファイルの一覧を確認できません');
      let snapshot=null,snapshotRead=false,restored=0,bytes=0;
      for(const item of wanted){
        check(validate);
        const expectedKey=item.kind==='photo'?'photo:'+item.drawingId+':'+item.photoId:'background:'+item.drawingId;
        assert(item.key===expectedKey&&['photo','background'].includes(item.kind),
          'DELTA_RECOVERY_KEY','復旧対象と保存先が一致しません');
        const candidates=assets.filter(a=>a?.client_key===cloudKey(item));
        // A duplicate is ambiguous even if one version happens to match.
        if(candidates.length!==1){issues.push(issue(item,candidates.length?'ASSET_AMBIGUOUS':'ASSET_NOT_FOUND',
          candidates.length?'同じファイルに複数の共有情報があります':'共有先に対応するファイルが見つかりません'));continue;}
        const a=candidates[0],size=Number(a.byte_size),sha256=hash(a.sha256),problem=assetProblem(item,a,scope,localProjectId);
        if(problem){issues.push(problem);continue;}
        if(item.kind==='photo'){
          const specs=item.expected||[];
          if(!specs.length||specs.some(p=>p?.id!==item.photoId||
            (p.sha256!==undefined&&hash(p.sha256)!==sha256)||
            (p.size!==undefined&&Number(p.size)!==size))){
            issues.push(issue(item,'PHOTO_METADATA_MISMATCH','保護した写真情報と共有ファイルの内容が一致しません'));continue;}
        }else{
          const revision=expectedRevision(item),expected=hash(revision?.pdfHash);
          if(expected){
            if(expected!==sha256||(revision.pdfSize&&Number(revision.pdfSize)!==size)){
              issues.push(issue(item,'DRAWING_REVISION_MISMATCH','保護した差替え版と共有ファイルの内容が一致しません'));continue;}
          }else{
            // Old drawings have no content hash. They can be received only
            // while the exact frozen server revision still names this source.
            if(!Number.isSafeInteger(Number(serverRevision))||Number(serverRevision)<=0){
              issues.push(issue(item,'SNAPSHOT_REVISION_UNVERIFIED','保護した図面の保存版を確認できません'));continue;}
            if(revision){issues.push(issue(item,'DRAWING_REVISION_UNVERIFIED','差替え済み図面の内容照合情報が不足しています'));continue;}
            if(!snapshotRead){snapshot=await readSnapshot(scope);check(validate);snapshotRead=true;}
            const problem=sourceProblem(item,a,snapshot,localProjectId);
            if(problem){issues.push(problem);continue;}
            if(Number(snapshot.revision)!==Number(serverRevision)){
              const reviewable=Number(snapshot.revision)>Number(serverRevision)&&reviewableSource(item);
              issues.push(issue(item,'SNAPSHOT_REVISION_MISMATCH',reviewable?
                '図面「'+(sourceFor(item).fileName||item.drawingId)+'」：以前の図面とクラウドのPDFが同じ内容か自動では確認できません。候補PDFを確認して復旧できます':
                '案件の更新後、以前の図面との照合を完了できていません',reviewable));continue;
            }
          }
        }
        // Permit one large drawing so it cannot starve forever. It is the
        // only download in that round, and is never decoded as an image.
        if(bytes+size>maxBytes&&(bytes>0||item.kind!=='background')){
          issues.push(issue(item,'RECOVERY_BATCH_LIMIT','次回の同期でファイルの受信を続けます'));continue;}
        bytes+=size; // Count attempted bytes even if a later version check rejects them.
        const before=signature(a),blob=await downloadBounded(a);check(validate);
        assert(blob&&typeof blob.arrayBuffer==='function'&&blob.size===size,
          'DELTA_RECOVERY_BYTES','復旧ファイルのサイズが保存情報と一致しません');
        const current=await readAsset(scope,a.id);check(validate);
        if(!current||signature(current)!==before){issues.push(issue(item,'ASSET_CHANGED','受信中に共有ファイルの情報が変わりました'));continue;}
        if(item.kind==='background'&&!hash(expectedRevision(item)?.pdfHash)){
          const latest=await readSnapshot(scope);check(validate);
          if(!latest||Number(latest.revision)!==Number(serverRevision)||
            latest.payload?.project?.id!==localProjectId){issues.push(issue(item,'SNAPSHOT_CHANGED','受信中に案件の保存版が変わりました'));continue;}
          const problem=sourceProblem(item,current,latest,localProjectId);
          if(problem){issues.push(problem);continue;}
        }
        await restore({key:item.key,blob,size,sha256,proof:proofFor(item,a,scope,serverRevision)});
        check(validate);restored++;
        if(bytes>=maxBytes)break;
      }
      return {restored,bytes,remaining:Math.max(0,(missing||[]).length-restored),issues};
    }
    recover.prepareReview=async function({scope:inputScope,localProjectId,serverRevision,missing,key,validate}={}){
      check(validate);
      const scope=copy(inputScope);
      assert(scope&&['ownerId','projectId','deviceId'].every(name=>typeof scope[name]==='string'&&scope[name])&&
        typeof localProjectId==='string'&&localProjectId&&Number.isSafeInteger(Number(serverRevision))&&Number(serverRevision)>0,
        'DELTA_RECOVERY_REVIEW_SCOPE','候補PDFの利用者・案件・保存版を確認できません');
      const matches=Array.isArray(missing)?missing.filter(item=>item?.key===key):[];
      assert(matches.length===1,'DELTA_RECOVERY_REVIEW_KEY','確認する不足図面を一意に特定できません');
      const item=copy(matches[0]);
      assert(item.key==='background:'+item.drawingId&&typeof item.drawingId==='string'&&item.drawingId&&reviewableSource(item),
        'DELTA_RECOVERY_REVIEW_UNAVAILABLE','このファイルは候補PDFの確認による復旧に対応していません');
      const assets=await listAssets(scope,[cloudKey(item)]);check(validate);
      assert(Array.isArray(assets),'DELTA_RECOVERY_ASSETS','候補PDFの一覧を確認できません');
      const candidates=assets.filter(asset=>asset?.client_key===cloudKey(item));
      assert(candidates.length===1,'DELTA_RECOVERY_REVIEW_ASSET','候補PDFを一意に特定できません');
      const asset=copy(candidates[0]),problem=assetProblem(item,asset,scope,localProjectId);
      assert(!problem,'DELTA_RECOVERY_REVIEW_ASSET',problem?.message);
      const snapshot=copy(await readSnapshot(scope));check(validate);
      const sourceIssue=sourceProblem(item,asset,snapshot,localProjectId);
      assert(!sourceIssue,'DELTA_RECOVERY_REVIEW_SOURCE',sourceIssue?.message);
      assert(Number(snapshot.revision)>=Number(serverRevision),'DELTA_RECOVERY_REVIEW_SOURCE',
        '共有先の保存版が保護した控えより古いため、候補PDFとして使用できません');
      const before=signature(asset),snapshotBefore=snapshotSignature(snapshot),size=Number(asset.byte_size),sha256=hash(asset.sha256);
      const blob=await downloadBounded(asset);check(validate);
      assert(blob&&typeof blob.arrayBuffer==='function'&&blob.size===size,
        'DELTA_RECOVERY_BYTES','候補PDFのサイズが共有ファイルの情報と一致しません');
      const current=await readAsset(scope,asset.id);check(validate);
      assert(current&&signature(current)===before,'DELTA_RECOVERY_REVIEW_CHANGED','候補PDFの取得中に共有ファイルが変わりました');
      const latest=await readSnapshot(scope);check(validate);
      assert(latest&&snapshotSignature(latest)===snapshotBefore,
        'DELTA_RECOVERY_REVIEW_CHANGED','候補PDFの取得中に案件の保存版または内容が変わりました');
      const source=copy(sourceFor(item)),selectedSnapshotRevision=Number(snapshot.revision);
      const payload={key:item.key,blob,size,sha256,fileName:source.fileName,
        drawingName:typeof item.drawing?.name==='string'?item.drawing.name:source.fileName,source,
        originalSnapshotRevision:Number(serverRevision),selectedSnapshotRevision,
        proof:{...proofFor(item,asset,scope,selectedSnapshotRevision),ownerId:scope.ownerId,source:copy(source)}};
      const ticket=Object.freeze({});
      reviews.set(ticket,{scope,localProjectId,validate,assetId:asset.id,assetSignature:before,snapshotSignature:snapshotBefore,payload});
      return {ticket,...copy(payload)};
    };
    recover.validateReview=async function(ticket){
      const entry=reviews.get(ticket);
      assert(entry,'DELTA_RECOVERY_REVIEW_TICKET','候補PDFの確認が終了しています。候補をもう一度開いてください');
      const current=()=>{
        assert(reviews.get(ticket)===entry,'DELTA_RECOVERY_REVIEW_TICKET','候補PDFの確認が取り消されました');
        check(entry.validate);
      };
      try{
        current();const asset=await readAsset(entry.scope,entry.assetId);current();
        assert(asset&&signature(asset)===entry.assetSignature,
          'DELTA_RECOVERY_REVIEW_CHANGED','候補表示後に共有ファイルが変わりました。新しい候補を確認してください');
        const snapshot=await readSnapshot(entry.scope);current();
        assert(snapshot&&snapshotSignature(snapshot)===entry.snapshotSignature,
          'DELTA_RECOVERY_REVIEW_CHANGED','候補表示後に案件の保存版または内容が変わりました。新しい候補を確認してください');
        return copy(entry.payload);
      }catch(error){reviews.delete(ticket);throw error;}
    };
    recover.releaseReview=ticket=>reviews.delete(ticket);
    return recover;
  }
  const api={version:1,createRecovery};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaMigrationRecovery=api;
})(typeof window!=='undefined'?window:globalThis);

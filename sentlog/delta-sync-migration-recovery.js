/* Bounded, authenticated recovery for a protected migration cutoff.
 * Only the journal's restore callback may persist bytes. It verifies their
 * SHA-256 and preserves any newer live file; this helper never acknowledges,
 * uploads, removes, or substitutes a different drawing revision.
 */
(function(root){
  'use strict';
  const hash=x=>/^[a-f0-9]{64}$/i.test(String(x||''))?String(x).toLowerCase():'';
  const canonical=x=>JSON.stringify(x&&typeof x==='object'&&!Array.isArray(x)?
    Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):
    Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):x??null);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function assert(ok,code,message){if(!ok)throw fail(code,message);}
  const cloudKey=item=>item.kind==='photo'?item.key:'drawing:'+item.drawingId;
  function expectedRevision(item){
    const markers=item.state?.pageReplacements||{};
    return Object.values(markers).filter(x=>x&&Number(x.updatedAt)>0)
      .sort((a,b)=>Number(b.updatedAt)-Number(a.updatedAt))[0]||null;
  }
  function sameSource(a,b){
    const view=x=>({id:x?.meta?.id,fileName:x?.state?.fileName??x?.meta?.fileName??'',
      sourceType:x?.state?.sourceType??x?.meta?.sourceType??null,
      pageCount:x?.state?.pageCount??x?.meta?.pageCount??null,
      pageReplacements:x?.state?.pageReplacements??{}});
    return canonical(view(a))===canonical(view(b));
  }
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
    const cursors=new Map();
    return async function recover({scope,localProjectId,serverRevision,missing,validate,restore}={}){
      validate();
      const eligible=(missing||[]).filter(x=>x.recoverable!==false),cursorKey=JSON.stringify([scope,localProjectId]);
      const start=eligible.length?(cursors.get(cursorKey)||0)%eligible.length:0;
      const wanted=[...eligible.slice(start),...eligible.slice(0,start)].slice(0,maxFiles);
      cursors.set(cursorKey,start+wanted.length);
      if(!wanted.length)return {restored:0,bytes:0,remaining:(missing||[]).length};
      const assets=await listAssets(scope,wanted.map(cloudKey));validate();
      assert(Array.isArray(assets),'DELTA_RECOVERY_ASSETS','不足ファイルの一覧を確認できません');
      let snapshot=null,snapshotRead=false,restored=0,bytes=0;
      for(const item of wanted){
        validate();
        const expectedKey=item.kind==='photo'?'photo:'+item.drawingId+':'+item.photoId:'background:'+item.drawingId;
        assert(item.key===expectedKey&&['photo','background'].includes(item.kind),
          'DELTA_RECOVERY_KEY','復旧対象と保存先が一致しません');
        const candidates=assets.filter(a=>a.client_key===cloudKey(item));
        // A duplicate is ambiguous even if one version happens to match.
        if(candidates.length!==1)continue;
        const a=candidates[0],m=a.metadata||{},size=Number(a.byte_size),sha256=hash(a.sha256);
        if(a.project_id!==scope.projectId||a.owner_id!==scope.ownerId||
          a.kind!==(item.kind==='photo'?'photo':'drawing')||a.status==='storage_deleted'||
          !a.id||!a.storage_path||!sha256||!Number.isSafeInteger(size)||size<=0||
          !safePath(a,scope)||
          m.drawing_id!==item.drawingId||(m.local_project_key&&m.local_project_key!==localProjectId)||
          (item.kind==='photo'&&m.photo_id!==item.photoId))continue;
        if(item.kind==='photo'){
          const specs=item.expected||[];
          if(!specs.length||specs.some(p=>p.id!==item.photoId||
            (p.sha256!==undefined&&hash(p.sha256)!==sha256)||
            (p.size!==undefined&&Number(p.size)!==size)))continue;
        }else{
          const revision=expectedRevision(item),expected=hash(revision?.pdfHash);
          if(expected){
            if(expected!==sha256||(revision.pdfSize&&Number(revision.pdfSize)!==size))continue;
          }else{
            // Old drawings have no content hash. They can be received only
            // while the exact frozen server revision still names this source.
            if(!Number.isSafeInteger(Number(serverRevision))||Number(serverRevision)<=0)continue;
            if(revision)continue;
            if(!snapshotRead){snapshot=await readSnapshot(scope);validate();snapshotRead=true;}
            if(!snapshot||Number(snapshot.revision)!==Number(serverRevision)||snapshot.payload?.project?.id!==localProjectId)continue;
            const rows=(snapshot.payload.drawings||[]).filter(d=>d.meta?.id===item.drawingId);
            if(rows.length!==1||!sameSource({meta:item.drawing,state:item.state},rows[0]))continue;
            const fileName=item.state?.fileName??item.drawing?.fileName;
            if(fileName&&a.file_name!==fileName)continue;
            const sourceType=item.state?.sourceType??item.drawing?.sourceType;
            if(sourceType&&m.source_type!==sourceType)continue;
          }
        }
        // Permit one large drawing so it cannot starve forever. It is the
        // only download in that round, and is never decoded as an image.
        if(bytes+size>maxBytes&&(bytes>0||item.kind!=='background'))continue;
        bytes+=size; // Count attempted bytes even if a later version check rejects them.
        const before=signature(a),blob=await downloadBounded(a);validate();
        assert(blob&&typeof blob.arrayBuffer==='function'&&blob.size===size,
          'DELTA_RECOVERY_BYTES','復旧ファイルのサイズが保存情報と一致しません');
        const current=await readAsset(scope,a.id);validate();
        if(!current||signature(current)!==before)continue;
        if(item.kind==='background'&&!hash(expectedRevision(item)?.pdfHash)){
          const latest=await readSnapshot(scope);validate();
          if(!latest||Number(latest.revision)!==Number(serverRevision)||
            latest.payload?.project?.id!==localProjectId)continue;
          const rows=(latest.payload.drawings||[]).filter(d=>d.meta?.id===item.drawingId);
          if(rows.length!==1||!sameSource({meta:item.drawing,state:item.state},rows[0]))continue;
        }
        await restore({key:item.key,blob,size,sha256,proof:{assetId:a.id,projectId:scope.projectId,
          clientKey:a.client_key,kind:a.kind,sha256,size,drawingId:item.drawingId,
          ...(item.kind==='photo'?{photoId:item.photoId}:{drawingRevision:expectedRevision(item)||null,
            snapshotRevision:Number(serverRevision),sourceType:item.state?.sourceType??item.drawing?.sourceType??null,
            fileName:item.state?.fileName??item.drawing?.fileName??''})}});
        validate();restored++;
        if(bytes>=maxBytes)break;
      }
      return {restored,bytes,remaining:Math.max(0,(missing||[]).length-restored)};
    };
  }
  const api={version:1,createRecovery};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaMigrationRecovery=api;
})(typeof window!=='undefined'?window:globalThis);

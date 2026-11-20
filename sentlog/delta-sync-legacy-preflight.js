/* Read-only legacy preflight for the isolated Sentlog delta-sync prototype.
 * It NEVER edits or clears surveyFieldNoteDB, SentlogRecords, or photos.
 * Passing a preflight is NOT migration, not a cloud receipt, and not proof
 * that all photo originals are available. Keep old storage until separately
 * verified new-mode migration and asset delivery are complete.
 */
(function(root){
  'use strict';
  const WORKSPACE='surveyFieldNoteWorkspaceV1', DRAWING='surveyFieldNoteDrawingV1:';
  const META='sentlogCloudProjectSyncV2:';
  const valid=s=>typeof s==='string'&&s.length>0&&s.length<=512;
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function insist(ok,code,msg){if(!ok)throw problem(code,msg);}
  const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
  const parse=(raw,label)=>{
    insist(typeof raw==='string'&&raw,'LEGACY_UNREADABLE',label+'の端末内データを読み取れません');
    try{return JSON.parse(raw);}catch{throw problem('LEGACY_UNREADABLE',label+'の記録形式が不正です');}
  };
  const isBlob=x=>x&&typeof x.size==='number'&&typeof x.arrayBuffer==='function';
  async function hash(blob){
    insist(root.crypto?.subtle?.digest,'LEGACY_HASH_UNAVAILABLE','ファイルの内容照合機能がありません');
    const digest=await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function inspect({legacy,readFile,projectId}={}){
    insist(legacy&&typeof legacy.getItem==='function'&&typeof readFile==='function'&&valid(projectId),
      'LEGACY_AUDIT_CONFIG','旧版の記録と写真を読み取る方法が不明です');
    insist(legacy.ready===true,'LEGACY_AUDIT_NOT_READY','端末の保存準備が完了していません');
    insist(!legacy.pending&&!legacy.failed&&!(legacy.uncommittedFiles?.().length||0),
      'LEGACY_AUDIT_PENDING','端末に未保存の変更があります。旧保存先を変更せず確認を中止しました');
    const workspaceRaw=legacy.getItem(WORKSPACE),workspace=parse(workspaceRaw,'案件一覧');
    insist(Array.isArray(workspace?.projects),'LEGACY_AUDIT_FORMAT','案件一覧を確認できません');
    const found=workspace.projects.filter(x=>x?.id===projectId);
    insist(found.length===1,'LEGACY_PROJECT_MISSING','対象案件を一意に特定できません');
    const project=found[0];
    insist(Array.isArray(project.drawings),'LEGACY_AUDIT_FORMAT','図面一覧を確認できません');
    const ids=new Set(),snapshots=[];
    const report={projectId,readOnly:true,projectName:typeof project.name==='string'?project.name:'',
      drawings:0,recordCount:0,photoRefs:0,verifiedLocalFiles:0,needsPhotoRecovery:0,
      cloudComparisonRequired:true,problems:[],manifest:[],changedWhileAuditing:false};
    for(const drawing of project.drawings){
      insist(valid(drawing?.id)&&!ids.has(drawing.id),'LEGACY_DUPLICATE_DRAWING','図面の識別番号が重複しています');
      ids.add(drawing.id);
      const key=DRAWING+drawing.id,raw=legacy.getItem(key);
      if(raw===null){
        report.problems.push({kind:'missing-drawing-state',drawingId:drawing.id});
        continue;
      }
      const state=parse(raw,'図面 '+drawing.id);
      insist(Array.isArray(state?.shapes),'LEGACY_AUDIT_FORMAT','図面の記録一覧を確認できません');
      const records=new Set(),usedPhotos=new Map();
      const drawingsRow={drawingId:drawing.id,records:0,photoRefs:0,localFiles:0,recoveryNeeded:0};
      for(const shape of state.shapes){
        insist(valid(shape?.id)&&!records.has(shape.id),'LEGACY_DUPLICATE_RECORD','記録IDが重複しています');
        records.add(shape.id);report.recordCount++;drawingsRow.records++;
        insist(!own(shape,'photos')||Array.isArray(shape.photos),'LEGACY_AUDIT_FORMAT','写真一覧を確認できません');
        for(const photo of shape.photos||[]){
          insist(valid(photo?.id),'LEGACY_PHOTO_ID','写真IDが不正です');
          const fileKey='photo:'+drawing.id+':'+photo.id;
          // The photo key is drawing-wide, not shape-wide. Distinct records
          // with the same ID must refer to the same original metadata.
          const signature=JSON.stringify([photo.name||'',photo.size??null,photo.sha256||null]);
          insist(!usedPhotos.has(fileKey)||usedPhotos.get(fileKey)===signature,
            'LEGACY_PHOTO_COLLISION','同じ写真IDに異なる写真情報があります');
          usedPhotos.set(fileKey,signature);
          report.photoRefs++;drawingsRow.photoRefs++;
          const blob=await readFile(fileKey);
          if(!isBlob(blob)||blob.size===0){
            report.needsPhotoRecovery++;drawingsRow.recoveryNeeded++;
            report.problems.push({kind:'photo-recovery-required',drawingId:drawing.id,recordId:shape.id,photoId:photo.id});
            continue;
          }
          const digest=await hash(blob);
          if((photo.sha256&&digest.toLowerCase()!==String(photo.sha256).toLowerCase())||
             (photo.size!==undefined&&Number(photo.size)!==blob.size)){
            report.needsPhotoRecovery++;drawingsRow.recoveryNeeded++;
            report.problems.push({kind:'photo-content-mismatch',drawingId:drawing.id,recordId:shape.id,photoId:photo.id});
            continue;
          }
          report.verifiedLocalFiles++;drawingsRow.localFiles++;
          report.manifest.push({drawingId:drawing.id,recordId:shape.id,photoId:photo.id,
            fileKey,size:blob.size,sha256:digest});
        }
      }
      snapshots.push([key,raw]);
      report.drawings++;report.problems.push(...[]);
      report.manifest.push({drawingId:drawing.id,recordCount:drawingsRow.records,photoRefs:drawingsRow.photoRefs});
    }
    // Never trust a cached "synced" flag as evidence of cloud delivery.
    const syncMetadata=legacy.getItem(META+projectId);
    if(syncMetadata!==null){parse(syncMetadata,'クラウド照合情報');}
    insist(workspaceRaw===legacy.getItem(WORKSPACE)&&snapshots.every(([k,raw])=>raw===legacy.getItem(k))&&
      !legacy.pending&&!legacy.failed&&!(legacy.uncommittedFiles?.().length||0),
      'LEGACY_AUDIT_CHANGED','確認中に端末の内容が変更されました。旧データは保持しています');
    report.readyForStaging=report.problems.length===0;
    report.readyForCloudSync=false; // Requires server baseline, receipts and old-client write guard.
    return report;
  }
  const api={version:1,inspect};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaLegacyPreflight=api;
})(typeof window!=='undefined'?window:globalThis);

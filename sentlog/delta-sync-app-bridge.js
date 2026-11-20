/* Translate actual editor snapshots into atomic delta-record edits.
 * This module never patches SentlogRecords or enables a production project.
 * The old synchronous mirror and a new outbox must not become two independent
 * writers. An activated UI must use the resulting replica projection directly.
 */
(function(root){
  'use strict';
  const C=root.SentlogRecordCollaboration||
    (typeof module==='object'&&module.exports?require('./record-collaboration.js'):null);
  const D=root.SentlogDeltaSyncCore||
    (typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
  const M=root.SentlogDeltaMetadata||
    (typeof module==='object'&&module.exports?require('./delta-sync-metadata.js'):null);
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const SCOPE=['ownerId','projectId','deviceId'];
  // The editor rebuilds both counters from the visible records after every
  // create/delete/transfer. They are not independent shared drawing settings.
  const VIEW=['currentPage','width','height','pdfPageInfo','labelSize','nextGlobalNo','typeCounters'];
  const DERIVED=['globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'];
  const OPERATIONS=['edit','create','delete','restore','copy','move'];
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const copy=x=>root.structuredClone(x);
  function problem(code,message){return Object.assign(Error(message),{code});}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  const sameScope=(a,b)=>object(a)&&object(b)&&SCOPE.every(k=>a[k]===b[k]);
  function parse(raw,label){
    insist(typeof raw==='string','BRIDGE_SOURCE',label+'の保存内容が見つかりません');
    try{return JSON.parse(raw);}catch{throw problem('BRIDGE_SOURCE',label+'の保存形式を確認できません');}
  }
  function scopeOf(input){
    insist(object(input)&&SCOPE.every(k=>valid(input[k])),'BRIDGE_SCOPE','利用者・案件・端末を確認できません');
    return Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,input[k]])));
  }
  function snapshot(input,localProjectId){
    insist(object(input)&&input.kind==='sentlog-app-project'&&input.version===1&&input.localProjectId===localProjectId&&
      object(input.project)&&input.project.id===localProjectId&&Array.isArray(input.project.drawings)&&Array.isArray(input.drawings),
      'BRIDGE_SOURCE','編集する案件と図面を確認できません');
    const ids=new Set();
    for(const meta of input.project.drawings){
      insist(valid(meta?.id)&&!ids.has(meta.id),'BRIDGE_DRAWING','図面の識別情報が重複しています');ids.add(meta.id);
    }
    const actual=new Set();
    for(const drawing of input.drawings){
      insist(object(drawing)&&valid(drawing.meta?.id)&&ids.has(drawing.meta.id)&&!actual.has(drawing.meta.id)&&
        C.equal(drawing.meta,input.project.drawings.find(d=>d.id===drawing.meta.id))&&object(drawing.state)&&Array.isArray(drawing.state.shapes)&&
        (!own(drawing.state,'collabDeletedRecords')||Array.isArray(drawing.state.collabDeletedRecords)),
        'BRIDGE_DRAWING','図面の記録と案件一覧が一致しません');
      actual.add(drawing.meta.id);
    }
    insist(actual.size===ids.size,'BRIDGE_DRAWING','記録を読み取れない図面があります');
    return input;
  }
  function captureProject({records,localProjectId}={}){
    insist(C&&D&&records?.ready===true&&typeof records.getItem==='function'&&valid(localProjectId),
      'BRIDGE_CONFIG','編集画面の保存先が準備できていません');
    const raw=records.getItem(WS),workspace=parse(raw,'案件一覧');
    insist(Array.isArray(workspace?.projects),'BRIDGE_SOURCE','案件一覧を読み取れません');
    const projects=workspace.projects.filter(p=>p?.id===localProjectId);
    insist(projects.length===1&&Array.isArray(projects[0].drawings),'BRIDGE_PROJECT','対象案件を一意に確認できません');
    const project=copy(projects[0]),owners=new Map(),rawEntries=[[WS,raw]];
    for(const p of workspace.projects)for(const meta of p.drawings||[]){
      if(!owners.has(meta.id))owners.set(meta.id,new Set());owners.get(meta.id).add(p.id);
    }
    const drawings=project.drawings.map(meta=>{
      insist(owners.get(meta.id)?.size===1,'BRIDGE_DRAWING','別案件と図面IDが重複しています');
      const key=DRAW+meta.id,value=records.getItem(key);rawEntries.push([key,value]);
      return {meta:copy(meta),state:parse(value,'図面 '+meta.id)};
    });
    insist(rawEntries.every(([key,value])=>records.getItem(key)===value),'BRIDGE_SOURCE_CHANGED','読取中に編集内容が変更されました');
    // This intentionally captures the UI mirror, including pending edits. It is
    // never a substitute for the read-only durable migration source.
    return snapshot({version:1,kind:'sentlog-app-project',localProjectId,project,drawings,rawEntries,
      source:'editor-memory',readyForActivation:false},localProjectId);
  }
  function metadataOf(input){
    const project=copy(input.project);delete project.updatedAt;delete project.deltaMetadata;delete project.collaborationVersion;
    project.drawings=project.drawings.map(meta=>{const value=copy(meta);
      for(const k of ['updatedAt','shapeCount','photoCount'])delete value[k];return value;});
    const drawings=input.drawings.map(d=>{
      const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;
      for(const k of VIEW)delete state[k];
      return {drawingId:d.meta.id,state};
    }).sort((a,b)=>a.drawingId<b.drawingId?-1:a.drawingId>b.drawingId?1:0);
    return {project,drawings};
  }
  function snapshotDrawings(input,includeRetained=false){
    if(!includeRetained)return input.drawings;
    const visible=new Set(input.drawings.map(d=>d.meta.id));
    return [...input.drawings,...(input.project.deltaMetadata?.retainedDrawings||[]).filter(d=>!visible.has(d.meta.id))];
  }
  function recordMap(input,includeRetained=false){
    const result=new Map();
    for(const drawing of snapshotDrawings(input,includeRetained))for(const bucket of ['shapes','collabDeletedRecords'])for(const record of drawing.state[bucket]||[]){
      const key=D.keyOf(drawing.meta.id,record?.id);
      insist(valid(record?.id)&&!result.has(key),'BRIDGE_RECORD','記録の識別情報が重複しています');
      result.set(key,{drawingId:drawing.meta.id,record:copy(record),bucket});
    }
    return result;
  }
  function cleanRecord(input){
    const record=copy(input);
    for(const k of DERIVED)delete record[k];
    insist(!own(record,'photos')||Array.isArray(record.photos),'BRIDGE_RECORD','写真一覧を確認できません');
    for(const photo of record.photos||[]){delete photo.localBlob;delete photo.data;}
    return record;
  }
  function withLocalCache(record,prior){
    const out=copy(record);
    for(const p of out.photos||[]){const cached=(prior?.photos||[]).find(x=>x.id===p.id);
      if(cached){const metadata=copy(cached);delete metadata.localBlob;delete metadata.data;
        if(C.equal(metadata,p))for(const k of ['localBlob','data'])if(own(cached,k))p[k]=copy(cached[k]);}
    }
    return out;
  }
  function issue(code,drawingId,recordId,message){return {code,drawingId,recordId,message};}
  async function digest(value){return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  function restoreCandidate(base,raw,options){
    const backup=raw.collab?C.upgrade(raw):null,joined=backup?C.mergeRecords(base,backup):{ok:true,record:C.upgrade(base)};
    insist(joined.ok,'BRIDGE_HISTORY',joined.reason||'バックアップの履歴を統合できません');let observed=joined.record;
    if(backup&&C.isDeleted(backup)){
      insist(C.matchesProjection(raw,{allowLegacyOrder:true}),'BRIDGE_DELETED_DRAFT','削除済みのバックアップ記録に未反映の入力があります');
      return C.isDeleted(observed)?observed:C.markDeleted(observed,{...options,expectedToken:C.revisionToken(observed),revisionId:options.idFactory()});
    }
    if(C.isDeleted(observed)||C.view(observed).pendingDelete)observed=C.restore(observed,{...options,expectedToken:C.revisionToken(observed),revisionId:options.idFactory()});
    for(const photo of raw.photos||[]){const prior=C.view(observed).photos.find(p=>p.id===photo.id);
      if(prior?.deleted)observed=C.restorePhoto(observed,photo.id,{...options,expectedHeads:prior.headIds,metadata:photo,revisionId:options.idFactory()});}
    // A restored scalar is a new intended revision. Omitted future fields and
    // existing comments/photos remain in the merged immutable history.
    const target={...copy(observed),...copy(raw),collab:copy(observed.collab)};
    if(C.GEOMETRY_KEYS.some(k=>own(raw,k)))for(const key of C.GEOMETRY_KEYS)if(!own(raw,key))delete target[key];
    if((backup&&String(raw.memo||'')===backup.memo)||!(String(raw.memo||''))||
      C.view(observed).comments.some(row=>!row.deleted&&row.text===String(raw.memo||'')))target.memo=observed.memo;
    const photos=new Map((observed.photos||[]).map(p=>[p.id,copy(p)]));for(const photo of raw.photos||[])photos.set(photo.id,copy(photo));target.photos=[...photos.values()];
    return C.applyLocalEdit(observed,target,options);
  }
  function candidate(before,after,options){
    let raw=cleanRecord(after),base=before?cleanRecord(before):null;
    if(base){
      insist(base.collab,'BRIDGE_UNMIGRATED','旧形式の記録は移行の確認を先に行ってください');
      insist(C.matchesProjection(base,{allowLegacyOrder:true}),'BRIDGE_UNTRACKED_BASE','編集開始時点に履歴へ入っていない変更があります');
      const normalized=C.upgrade(base);
      if(!C.equal(base,normalized)&&C.equal(base.collab,raw.collab)){
        if(raw.memo===base.memo)raw.memo=normalized.memo;
        if(C.equal(raw.photos,base.photos))raw.photos=copy(normalized.photos);
      }
      base=normalized;
    }
    if(raw.collab&&C.matchesProjection(raw,{allowLegacyOrder:true}))raw=C.upgrade(raw);
    let out;
    if(base&&options.operation==='restore')out=restoreCandidate(base,raw,options);
    else if(raw.collab&&C.isDeleted(C.upgrade(raw))){
      out=C.upgrade(raw);
      insist(C.equal(raw,out),'BRIDGE_DELETED_DRAFT','削除済みの記録に未反映の入力があります。入力を残して確認が必要です');
    }else out=C.applyLocalEdit(base||(raw.collab?C.upgrade(raw):null),raw,options);
    if(base&&options.operation!=='restore'){
      // The legacy canvas may omit a photo or clear a textarea. Neither is an
      // authenticated deletion intent; only immutable delete revisions count.
      const ids=new Set((raw.photos||[]).map(p=>p.id));
      insist(!(out.photos||[]).some(p=>(base.photos||[]).some(b=>b.id===p.id)&&!ids.has(p.id)),
        'BRIDGE_PHOTO_REMOVAL','写真の削除履歴がありません。元の写真を残して確認が必要です');
      insist(!(String(base.memo||'')&&!String(raw.memo||'')&&String(out.memo||'')),
        'BRIDGE_COMMENT_REMOVAL','コメントの削除履歴がありません。文章を残して確認が必要です');
    }
    return cleanRecord(out);
  }
  function prepare({scope:inputScope,localProjectId,before:inputBefore,after:inputAfter,operation,actor,at=Date.now(),idFactory=()=>root.crypto.randomUUID(),sharedMetadata=false}={}){
    const scope=scopeOf(inputScope),before=copy(snapshot(inputBefore,localProjectId)),after=copy(snapshot(inputAfter,localProjectId));
    insist(object(actor)&&actor.deviceId===scope.deviceId&&typeof actor.deviceName==='string'&&Number.isFinite(at)&&at>=0&&typeof idFactory==='function',
      'BRIDGE_ACTOR','この編集を行った端末を確認できません');
    const includeRetained=operation==='restore',old=recordMap(before,includeRetained),next=recordMap(after,includeRetained),changes=[],issues=[],metadataChanges=[];
    if(!OPERATIONS.includes(operation))issues.push(issue('BRIDGE_OPERATION',null,null,'編集操作の種類が必要です。入力全体を保持しています'));
    const created=[...next.entries()].filter(([key])=>!old.has(key));
    const removed=[...old.entries()].filter(([key])=>!next.has(key));
    const deletionEntries=[...next.entries()].filter(([key,current])=>{
      const prior=old.get(key);if(!prior)return false;
      if(prior.bucket!=='collabDeletedRecords'&&current.bucket==='collabDeletedRecords')return true;
      const oldRows=prior.record.collab?.deletion?.revisions,newRows=current.record.collab?.deletion?.revisions;
      const previous=new Set((Array.isArray(oldRows)?oldRows:[]).map(r=>r?.id));
      return (Array.isArray(newRows)?newRows:[]).some(r=>r?.deleted===true&&!previous.has(r.id));
    });
    const deletionIntent=deletionEntries.length>0;
    const transferMove=created.some(([,entry])=>{
      if(entry.record.transferOrigin?.operation==='move')return true;
      try{return C.upgrade(entry.record).transferOrigin?.operation==='move';}catch{return false;}
    });
    const relocatedId=created.some(([,entry])=>removed.some(([,prior])=>prior.record.id===entry.record.id&&prior.drawingId!==entry.drawingId));
    // A source tombstone must never be publishable without its destination.
    // The bound replica can remove the capability issue only after checking
    // its authenticated transport and preparing a whole atomic group.
    let atomicGroupRequired=operation==='move'||transferMove||relocatedId||
      (created.length>0&&(deletionIntent||removed.length>0));
    if(atomicGroupRequired)issues.push(issue('BRIDGE_ATOMIC_GROUP_REQUIRED',null,null,
      '移動元と移動先を一緒に共有する機能が未接続です。操作全体を保持し、どちらも送信していません'));
    if(operation==='move'&&(!created.length||!deletionIntent))issues.push(issue('BRIDGE_MOVE_INCOMPLETE',null,null,
      '移動元と移動先の両方を確認できません。操作全体を保持しています'));
    for(const [,target]of created){
      let origin=target.record.transferOrigin;
      try{origin=origin||C.upgrade(target.record).transferOrigin;}catch{}
      if(origin?.operation==='move'&&(!valid(origin.drawingId)||!valid(origin.recordId)||
        !old.has(D.keyOf(origin.drawingId,origin.recordId))||!deletionEntries.some(([key])=>key===D.keyOf(origin.drawingId,origin.recordId))))
        issues.push(issue('BRIDGE_MOVE_INCOMPLETE',target.drawingId,target.record.id,'この移動先に対応する移動元の削除操作を確認できません'));
    }
    const a=metadataOf(before),b=metadataOf(after);
    if(!C.equal(a.project,b.project))metadataChanges.push({kind:'project',before:copy(a.project),after:copy(b.project)});
    const am=new Map(a.drawings.map(d=>[d.drawingId,d.state])),bm=new Map(b.drawings.map(d=>[d.drawingId,d.state]));
    for(const drawingId of [...new Set([...am.keys(),...bm.keys()])].sort())if(!C.equal(am.get(drawingId),bm.get(drawingId)))
      metadataChanges.push({kind:'drawing',drawingId,before:copy(am.get(drawingId)??null),after:copy(bm.get(drawingId)??null)});
    const retainedAfter=copy(after),retained=recordMap(retainedAfter,includeRetained);
    for(const key of [...new Set([...old.keys(),...next.keys()])].sort()){
      const previous=old.get(key),current=next.get(key),drawingId=(current||previous).drawingId,recordId=(current||previous).record.id;
      if(!current){
        if(operation==='restore')continue;
        if(sharedMetadata&&!after.project.drawings.some(d=>d.id===drawingId)){
          try{const base=cleanRecord(C.upgrade(cleanRecord(previous.record))),eventId=idFactory();
            const normalized=C.markDeleted(base,{expectedToken:C.revisionToken(base),actor,at,revisionId:idFactory()});
            changes.push({drawingId,before:base,after:normalized,eventId});atomicGroupRequired=true;
          }catch(error){issues.push(issue(error.code||'BRIDGE_RECORD',drawingId,recordId,error.message));}
        }else issues.push(issue('BRIDGE_RECORD_REMOVAL',drawingId,recordId,'削除履歴なしで記録がなくなっています。元の記録を保持しています'));
        continue;
      }
      if(previous&&C.equal(cleanRecord(previous.record),cleanRecord(current.record)))continue;
      try{
        const eventId=idFactory();insist(valid(eventId),'BRIDGE_EVENT_ID','編集の識別番号を作成できません');
        const normalized=candidate(previous?.record||null,current.record,{actor,at,idFactory,operation});
        const base=previous?cleanRecord(C.upgrade(cleanRecord(previous.record))):null;
        const event=D.diffRecord(base,normalized,{eventId,projectId:scope.projectId,deviceId:scope.deviceId,drawingId});
        if(!event)continue;
        changes.push({drawingId,before:base,after:normalized,eventId});
        const d=snapshotDrawings(retainedAfter,includeRetained).find(d=>d.meta.id===drawingId),r=retained.get(key);
        d.state[r.bucket]=d.state[r.bucket].map(x=>x.id===recordId?withLocalCache(normalized,x):x);
      }catch(error){issues.push(issue(error.code||'BRIDGE_RECORD',drawingId,recordId,error.message));}
    }
    if(new Set(changes.map(c=>c.eventId)).size!==changes.length)issues.push(issue('BRIDGE_EVENT_ID',null,null,'編集の識別番号が重複しています'));
    if(changes.length>500)issues.push(issue('BRIDGE_BATCH',null,null,'一括保存できる記録数を超えています。編集全体を保持しています'));
    return {version:1,kind:'sentlog-delta-edit-plan',scope:copy(scope),localProjectId,operation:operation??null,atomicGroupRequired,changes,metadataChanges,issues,
      before,after:retainedAfter,submittedAfter:after,ready:issues.length===0&&metadataChanges.length===0,
      readyForActivation:false};
  }
  function project({template:input,state,scope:inputScope,localProjectId}={}){
    const scope=scopeOf(inputScope),template=copy(snapshot(input,localProjectId));
    insist(state?.version===2&&sameScope(state.scope,scope)&&object(state.records),'BRIDGE_SCOPE','受信した記録の保存先が一致しません');
    const drawings=new Map(template.drawings.map(d=>[d.meta.id,d])),old=recordMap(template);
    for(const drawing of drawings.values()){drawing.state.shapes=[];drawing.state.collabDeletedRecords=[];}
    // Keep the editor's stable record order. Remote-only records are appended
    // deterministically; the editor can then rebuild its display numbering.
    const ordered=[...old.keys()].filter(key=>own(state.records,key));
    ordered.push(...Object.keys(state.records).filter(key=>!old.has(key)).sort((a,b)=>{
      const x=JSON.parse(a),y=JSON.parse(b),compare=C.compareIds||((a,b)=>a<b?-1:a>b?1:0);return compare(x[0],y[0])||compare(x[1],y[1]);
    }));
    for(const key of ordered){const value=state.records[key];
      let parts;try{parts=JSON.parse(key);}catch{}
      insist(Array.isArray(parts)&&parts.length===2&&parts.every(valid)&&D.keyOf(...parts)===key&&parts[1]===value?.id,
        'BRIDGE_RECORD','受信した記録の識別情報が不正です');
      const drawing=drawings.get(parts[0]);insist(drawing,'BRIDGE_DRAWING','受信記録に対応する図面の情報がありません');
      const prior=old.get(key)?.record,record=withLocalCache(C.upgrade(value),prior);
      for(const k of DERIVED){delete record[k];if(prior&&own(prior,k))record[k]=copy(prior[k]);}
      drawing.state[C.isDeleted(record)?'collabDeletedRecords':'shapes'].push(record);
    }
    for(const drawing of drawings.values()){
      // Match the editor/merge numbering model, including its memo/dimension
      // filters. A received addition must not reuse counters from the old view.
      const counters={};let number=0;
      for(const record of drawing.state.shapes){
        if(record.recordKind==='drawing-memo'||record.recordKind==='dimension-line'||record.kind==='dimension')continue;
        const type=record.type||'腐食',typeNo=(own(counters,type)?counters[type]:0)+1;
        Object.defineProperty(counters,type,{value:typeNo,writable:true,enumerable:true,configurable:true});
        record.globalNo=++number;record.typeNo=typeNo;record.autoLabel=type+'-'+typeNo;
        if(record.recordKind==='field-record')record.recordNo=typeNo;
      }
      drawing.state.nextGlobalNo=number+1;drawing.state.typeCounters=counters;
      drawing.meta.shapeCount=number;
      drawing.meta.photoCount=drawing.state.shapes.reduce((n,r)=>n+(r.photos||[]).length,0);
    }
    template.project.drawings=template.project.drawings.map(meta=>copy(drawings.get(meta.id).meta));
    delete template.rawEntries;
    template.source='delta-replica-projection';template.readyForActivation=false;
    return template;
  }
  async function projectReplica({template,state,scope,localProjectId}){
    if(!M||!own(state.records,D.keyOf(M.namespace,'project')))return project({template,state,scope,localProjectId});
    const shared=await M.project({records:state.records,template,localProjectId}),ids=new Set(shared.project.drawings.map(d=>d.id));
    const visible={};for(const [key,record]of Object.entries(state.records)){const pair=JSON.parse(key);if(ids.has(pair[0]))Object.defineProperty(visible,key,{value:record,enumerable:true});}
    return project({template:shared,state:{...state,records:visible},scope,localProjectId});
  }
  function replaySnapshots(options){
    const before=copy(options.before),after=copy(options.after),baseline=options.replayBaseline;
    if(!options.replay)return {before,after};
    const includeRetained=options.operation==='restore',old=recordMap(before,includeRetained),next=recordMap(after,includeRetained),raw=baseline?.before&&recordMap(baseline.before,includeRetained),normalized=baseline?.after&&recordMap(baseline.after,includeRetained);
    for(const [key,entry]of old){
      const rawBefore=cleanRecord(entry.record),tracked=rawBefore.collab&&C.matchesProjection(rawBefore,{allowLegacyOrder:true});
      const previous=raw?.get(key),normal=normalized?.get(key);
      if(!tracked)insist(previous&&normal&&C.equal(cleanRecord(previous.record),rawBefore),'BRIDGE_REPLAY_BASE','未反映の入力に対応する保存履歴がありません。入力を保持しています');
      if(previous&&normal&&C.equal(cleanRecord(previous.record),rawBefore)){
        const base=cleanRecord(normal.record);insist(base.collab&&C.equal(base,C.upgrade(base)),'BRIDGE_REPLAY_BASE','前回の保存結果の履歴を確認できません');
        const drawing=snapshotDrawings(before,includeRetained).find(d=>d.meta.id===entry.drawingId);drawing.state[entry.bucket]=drawing.state[entry.bucket].map(r=>r.id===entry.record.id?withLocalCache(base,r):r);
        const current=next.get(key);if(current){
          const target=snapshotDrawings(after,includeRetained).find(d=>d.meta.id===current.drawingId),record=copy(current.record);
          if(C.equal(record.collab,entry.record.collab))record.collab=copy(base.collab);
          else {const merged=C.mergeRecords(base,C.upgrade(record));insist(merged.ok,'BRIDGE_REPLAY_BASE',merged.reason||'前回の入力と今回の操作を統合できません');record.collab=copy(merged.record.collab);}
          target.state[current.bucket]=target.state[current.bucket].map(r=>r.id===record.id?record:r);
        }
      }
    }
    return {before,after};
  }
  function canDecompose(plan){
    if(plan.operation==='move')return false;
    const regular=plan.changes.filter(c=>c.drawingId!==M?.namespace),created=regular.filter(c=>!c.before);
    const deleted=regular.filter(c=>c.before&&c.after.collab.deletion.revisions.some(r=>r.deleted&&
      !c.before.collab.deletion.revisions.some(old=>old.id===r.id)));
    if(regular.some(c=>c.after.transferOrigin?.operation==='move'&&
      (!c.before||!C.equal(c.before.transferOrigin,c.after.transferOrigin))))return false;
    if(created.some(c=>deleted.some(d=>d.drawingId!==c.drawingId&&d.after.id===c.after.id)))return false;
    const removed=plan.before.project.drawings.some(d=>!plan.submittedAfter.project.drawings.some(next=>next.id===d.id));
    return plan.operation==='restore'||removed&&created.length===0;
  }
  async function restoreOutsideView(value,change,{scope,operationId,actor,at}){
    // A drawing can be restored before the previous deletion is projected into
    // the UI. Its records then exist only in the replica. An explicit alive (or
    // deleted) revision certifies this whole restore intent inside the same
    // atomic record event; a replay cannot author it again over later peer edits.
    const identity=await digest([scope,operationId||change.eventId,change.drawingId,change.after]),prefix='bridge-restore:'+identity,completed=prefix+':complete';
    if(value?.collab.deletion.revisions.some(r=>r.id===completed))return value;
    let n=0;const options={actor,at,idFactory:()=>prefix+':'+(++n)},restored=value?restoreCandidate(value,change.after,options):change.after;
    return (C.isDeleted(restored)?C.markDeleted:C.restore)(restored,{actor,at,revisionId:completed,expectedToken:C.revisionToken(restored)});
  }
  async function boundedSegments(changes,{scope,operationId,atomic}){
    const metadata=changes.filter(c=>c.drawingId===M?.namespace),removal=c=>c.before&&c.after.collab.deletion.revisions.some(r=>r.deleted&&!c.before.collab.deletion.revisions.some(old=>old.id===r.id));
    const ordered=[...metadata.filter(c=>!removal(c)),...changes.filter(c=>c.drawingId!==M?.namespace),...metadata.filter(removal)];
    const rows=ordered.map(change=>({change,event:D.diffRecord(change.before,change.after,{...change,projectId:scope.projectId,deviceId:scope.deviceId})})).filter(r=>r.event);
    insist(new Set(rows.map(r=>r.event.eventId)).size===rows.length,'BRIDGE_EVENT_ID','編集の識別番号が重複しています');
    const segments=[];
    async function add(part){
      const groupId='bridge-segment:'+await digest([scope.projectId,operationId,part.map(r=>r.event.eventId)]);
      try{D.validateGroup({schema:1,kind:'atomic-group',groupId,projectId:scope.projectId,deviceId:scope.deviceId,events:part.map(r=>r.event)});}
      catch(error){
        if(error.code==='DELTA_GROUP_TOO_LARGE'&&part.length>1){const middle=Math.ceil(part.length/2);await add(part.slice(0,middle));await add(part.slice(middle));return;}
        throw error;
      }
      segments.push({changes:part.map(r=>copy(r.change)),atomicGroup:atomic,groupId});
    }
    for(let start=0;start<rows.length;start+=500)await add(rows.slice(start,start+500));
    return segments;
  }
  function createBridge({replica,scope:inputScope,localProjectId,currentScope}={}){
    const scope=scopeOf(inputScope);
    insist(replica&&typeof replica.snapshotWithStatus==='function'&&typeof replica.changeBatch==='function'&&typeof currentScope==='function'&&valid(localProjectId),
      'BRIDGE_CONFIG','原子的な複数記録の保存方法が必要です');
    const plans=new WeakMap();let closed=false;
    function active(){insist(!closed,'BRIDGE_CLOSED','この編集接続は終了しています');
      insist(sameScope(scope,currentScope()),'BRIDGE_SCOPE','利用者・案件・端末が切り替わっています。入力は元の案件に残してください');}
    async function prepareEdit(options={}){
      active();const requestedGroupId=options.groupId,current=await replica.snapshotWithStatus();active();
      insist(sameScope(current.snapshot?.scope,scope),'BRIDGE_SCOPE','編集先の保存状態が一致しません');
      const sharedMetadata=!!(M&&own(current.snapshot.records,D.keyOf(M.namespace,'project')));
      let normalized;try{normalized=replaySnapshots(options);}catch(error){normalized={before:copy(options.before),after:copy(options.after),error};}
      const plan=prepare({...options,...normalized,sharedMetadata,scope,localProjectId});
      if(normalized.error)plan.issues.push(issue(normalized.error.code||'BRIDGE_REPLAY_BASE',null,null,normalized.error.message));
      // A record untouched by this particular draft still must be present in
      // the authoritative replica, otherwise projecting a successful save
      // could silently drop it from the editor.
      for(const [key,entry] of recordMap(plan.before,options.operation==='restore'))try{
        const base=cleanRecord(entry.record),value=current.snapshot.records[key];
        insist(base.collab&&C.matchesProjection(base,{allowLegacyOrder:true}),'BRIDGE_UNTRACKED_BASE','編集開始時点に履歴へ入っていない記録があります');
        insist(value,'BRIDGE_RECORD_MISSING','編集元の記録が移行先にありません');
        D.diffRecord(base,value,{eventId:'bridge-lineage-check',drawingId:entry.drawingId,projectId:scope.projectId,deviceId:scope.deviceId});
      }catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',entry.drawingId,entry.record.id,error.message));}
      try{await projectReplica({template:plan.before,state:current.snapshot,scope,localProjectId});}
      catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',null,null,error.message));}
      const rebased=[];
      for(const change of plan.changes){
        try{
          const key=D.keyOf(change.drawingId,change.after.id),value=own(current.snapshot.records,key)?current.snapshot.records[key]:null;
          if(!change.before){
            if(options.operation==='restore'){
              const after=await restoreOutsideView(value,change,{scope,operationId:options.operationId,actor:options.actor,at:options.at});
              const restored={...change,before:value?copy(value):null,after:cleanRecord(after)};
              if(D.diffRecord(restored.before,restored.after,{...restored,projectId:scope.projectId,deviceId:scope.deviceId}))rebased.push(restored);
              continue;
            }
            if(!value){rebased.push(change);continue;}
            insist(options.replay,'BRIDGE_RECORD_COLLISION','同じIDの別の記録があります');
            D.diffRecord(change.after,value,{...change,projectId:scope.projectId,deviceId:scope.deviceId});continue;
          }
          insist(value,'BRIDGE_RECORD_MISSING','編集元の記録が移行先にありません');
          // The opened draft can be older than a just-received revision, but its
          // immutable ancestors must already exist in the durable replica.
          D.diffRecord(change.before,value,{...change,projectId:scope.projectId,deviceId:scope.deviceId});
          const merged=C.mergeRecords(value,change.after,{base:change.before});
          insist(merged.ok,'BRIDGE_HISTORY',merged.reason||'編集内容を統合できません');
          const final={...change,before:copy(value),after:cleanRecord(merged.record)};
          if(D.diffRecord(final.before,final.after,{...final,projectId:scope.projectId,deviceId:scope.deviceId}))rebased.push(final);
        }catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',change.drawingId,change.after.id,error.message));}
      }
      if(sharedMetadata)try{
        const metadata=await M.edit({before:options.before,after:options.after,beforeRecords:options.beforeRecords||options.metadataRecords,
          inferProvenance:options.replay===true,currentRecords:current.snapshot.records,operationId:options.operationId||options.groupId||root.crypto.randomUUID(),actor:options.actor,at:options.at,operation:options.operation});
        rebased.push(...metadata.changes);plan.metadataChanges=[];plan.metadataConflicts=metadata.conflicts;
        if(metadata.changes.length&&rebased.length>1)plan.atomicGroupRequired=true;
      }catch(error){plan.issues.push(issue(error.code||'BRIDGE_METADATA',null,null,error.message));}
      plan.changes=rebased;
      if(rebased.length<=500)plan.issues=plan.issues.filter(x=>x.code!=='BRIDGE_BATCH');
      if(plan.atomicGroupRequired&&!plan.issues.some(x=>x.code==='BRIDGE_ATOMIC_GROUP_REQUIRED'))plan.issues.push(issue('BRIDGE_ATOMIC_GROUP_REQUIRED',null,null,'図面設定と記録を一緒に保存する機能を確認できません'));
      const atomic=typeof replica.changeGroup==='function'&&replica.getCapabilities?.().atomicGroups===true;
      if((plan.atomicGroupRequired&&atomic)||canDecompose(plan)){
        try{
          const groupId=requestedGroupId??root.crypto.randomUUID();
          insist(valid(groupId),'BRIDGE_GROUP_ID','一括操作の識別番号を確認できません');
          const events=rebased.map(change=>D.diffRecord(change.before,change.after,{...change,projectId:scope.projectId,deviceId:scope.deviceId})).filter(Boolean);
          let oversized=events.length>500;
          if(events.length&&!oversized)try{D.validateGroup({schema:1,kind:'atomic-group',groupId,projectId:scope.projectId,deviceId:scope.deviceId,events});}
          catch(error){if(error.code==='DELTA_GROUP_TOO_LARGE')oversized=true;else throw error;}
          if(oversized){
            insist(canDecompose(plan),'BRIDGE_BATCH','この移動操作は一括保存の上限を超えています。移動元と移動先を一緒に保持しています');
            insist(!plan.atomicGroupRequired||atomic,'BRIDGE_ATOMIC_GROUP_REQUIRED','図面と記録を一緒に保存する共有先が必要です');
            plan.segments=await boundedSegments(rebased,{scope,operationId:options.operationId||groupId,atomic});
            if(atomic)insist(replica.getCapabilities?.().atomicGroups===true,'BRIDGE_ATOMIC_GROUP_REQUIRED','一括保存の接続確認が変わりました');
            plan.decomposed=true;plan.issues=plan.issues.filter(x=>x.code!=='BRIDGE_BATCH');
          }
          plan.groupId=groupId;if(atomic||!plan.atomicGroupRequired)plan.issues=plan.issues.filter(x=>x.code!=='BRIDGE_ATOMIC_GROUP_REQUIRED');
        }catch(error){plan.issues.push(issue(error.code||'BRIDGE_GROUP_ID',null,null,error.message||'一括操作を確認できません'));}
      }
      plan.ready=plan.issues.length===0&&plan.metadataChanges.length===0;
      const exposed=copy(plan);plans.set(exposed,{plan:copy(plan),snapshotToken:current.snapshotToken,receipt:null,pending:null,nextSegment:0,segmentResults:[]});return exposed;
    }
    async function commit(exposed){
      active();const entry=plans.get(exposed);insist(entry,'BRIDGE_PLAN','この編集接続で作成した計画が必要です');
      if(entry.receipt)return copy(entry.receipt);
      if(entry.pending)return entry.pending;
      insist(entry.plan.ready,'BRIDGE_REVIEW','図面設定または記録の確認が必要です。入力全体を編集計画に保持しています');
      const task=(async()=>{
        let result;
        if(entry.plan.segments){
          while(entry.nextSegment<entry.plan.segments.length){
            const segment=entry.plan.segments[entry.nextSegment],input={changes:copy(segment.changes),expectedSnapshotToken:entry.snapshotToken};
            const committed=segment.atomicGroup?await replica.changeGroup({...input,groupId:segment.groupId}):await replica.changeBatch(input);active();
            entry.snapshotToken=committed.snapshotToken;entry.segmentResults.push(committed);entry.nextSegment++;
          }
          const last=entry.segmentResults[entry.segmentResults.length-1];
          if(last)result={...last,results:entry.segmentResults.flatMap(r=>r.results||[]),segmented:true,segments:entry.plan.segments.length};
        }else if(entry.plan.changes.length){
          const input={changes:copy(entry.plan.changes),expectedSnapshotToken:entry.snapshotToken};
          result=entry.plan.atomicGroupRequired?await replica.changeGroup({...input,groupId:entry.plan.groupId}):await replica.changeBatch(input);active();
        }
        const current=await replica.snapshotWithStatus();active();
        if(!result){
          insist(current.snapshotToken===entry.snapshotToken,'DELTA_STALE','確認後に記録が変更されています。入力内容を保持して再確認してください');
          result={results:[],pending:current.snapshot.outbox.length,blocked:current.snapshot.blockedOutbox?.length||0,unchanged:true};
        }
        const projection=await projectReplica({template:entry.plan.after,state:current.snapshot,scope,localProjectId});
        // Runtime snapshot tokens are identity proofs, not JSON receipt data.
        // Status/asset confirmation must obtain a fresh token from the replica.
        const {snapshotToken,...summary}=result;
        const receipt={saved:true,result:copy(summary),projection,normalizedAfter:copy(entry.plan.after),readyForActivation:false};entry.receipt=copy(receipt);return receipt;
      })();
      entry.pending=task;
      try{return await task;}finally{entry.pending=null;}
    }
    return {prepare:prepareEdit,commit,project:async template=>{active();const current=await replica.snapshotWithStatus();active();return projectReplica({template,state:current.snapshot,scope,localProjectId});},
      close(){closed=true;},getScope:()=>copy(scope)};
  }
  const api={version:1,captureProject,metadataOf,prepare,project,projectReplica,createBridge};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaAppBridge=api;
})(typeof window!=='undefined'?window:globalThis);

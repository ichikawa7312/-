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
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const SCOPE=['ownerId','projectId','deviceId'];
  const VIEW=['currentPage','width','height','pdfPageInfo','labelSize'];
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
    const project=copy(input.project);delete project.updatedAt;
    project.drawings=project.drawings.map(meta=>{const value=copy(meta);
      for(const k of ['updatedAt','shapeCount','photoCount'])delete value[k];return value;});
    const drawings=input.drawings.map(d=>{
      const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;
      for(const k of VIEW)delete state[k];
      return {drawingId:d.meta.id,state};
    }).sort((a,b)=>a.drawingId<b.drawingId?-1:a.drawingId>b.drawingId?1:0);
    return {project,drawings};
  }
  function recordMap(input){
    const result=new Map();
    for(const drawing of input.drawings)for(const bucket of ['shapes','collabDeletedRecords'])for(const record of drawing.state[bucket]||[]){
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
  function candidate(before,after,options){
    const raw=cleanRecord(after),base=before?cleanRecord(before):null;
    if(base){
      insist(base.collab,'BRIDGE_UNMIGRATED','旧形式の記録は移行の確認を先に行ってください');
      insist(C.equal(base,C.upgrade(base)),'BRIDGE_UNTRACKED_BASE','編集開始時点に履歴へ入っていない変更があります');
    }
    let out;
    if(raw.collab&&C.isDeleted(C.upgrade(raw))){
      out=C.upgrade(raw);
      insist(C.equal(raw,out),'BRIDGE_DELETED_DRAFT','削除済みの記録に未反映の入力があります。入力を残して確認が必要です');
    }else out=C.applyLocalEdit(base||(raw.collab?C.upgrade(raw):null),raw,options);
    if(base){
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
  function prepare({scope:inputScope,localProjectId,before:inputBefore,after:inputAfter,operation,actor,at=Date.now(),idFactory=()=>root.crypto.randomUUID()}={}){
    const scope=scopeOf(inputScope),before=copy(snapshot(inputBefore,localProjectId)),after=copy(snapshot(inputAfter,localProjectId));
    insist(object(actor)&&actor.deviceId===scope.deviceId&&typeof actor.deviceName==='string'&&Number.isFinite(at)&&at>=0&&typeof idFactory==='function',
      'BRIDGE_ACTOR','この編集を行った端末を確認できません');
    const old=recordMap(before),next=recordMap(after),changes=[],issues=[],metadataChanges=[];
    if(!OPERATIONS.includes(operation))issues.push(issue('BRIDGE_OPERATION',null,null,'編集操作の種類が必要です。入力全体を保持しています'));
    const created=[...next.entries()].filter(([key])=>!old.has(key));
    const removed=[...old.entries()].filter(([key])=>!next.has(key));
    const deletionIntent=[...next.entries()].some(([key,current])=>{
      const prior=old.get(key);if(!prior)return false;
      if(prior.bucket!=='collabDeletedRecords'&&current.bucket==='collabDeletedRecords')return true;
      const oldRows=prior.record.collab?.deletion?.revisions,newRows=current.record.collab?.deletion?.revisions;
      const previous=new Set((Array.isArray(oldRows)?oldRows:[]).map(r=>r?.id));
      return (Array.isArray(newRows)?newRows:[]).some(r=>r?.deleted===true&&!previous.has(r.id));
    });
    const transferMove=created.some(([,entry])=>{
      if(entry.record.transferOrigin?.operation==='move')return true;
      try{return C.upgrade(entry.record).transferOrigin?.operation==='move';}catch{return false;}
    });
    const relocatedId=created.some(([,entry])=>removed.some(([,prior])=>prior.record.id===entry.record.id&&prior.drawingId!==entry.drawingId));
    // The server currently accepts independent events, not an atomic group.
    // A source tombstone must never be publishable without its destination.
    // Require an explicit operation to catch a partial capture, and reject
    // ambiguous create+delete batches even if a caller mislabeled the action.
    const atomicGroupRequired=operation==='move'||transferMove||relocatedId||
      (created.length>0&&(deletionIntent||removed.length>0));
    if(atomicGroupRequired)issues.push(issue('BRIDGE_ATOMIC_GROUP_REQUIRED',null,null,
      '移動元と移動先を一緒に共有する機能が未接続です。操作全体を保持し、どちらも送信していません'));
    const a=metadataOf(before),b=metadataOf(after);
    if(!C.equal(a.project,b.project))metadataChanges.push({kind:'project',before:copy(a.project),after:copy(b.project)});
    const am=new Map(a.drawings.map(d=>[d.drawingId,d.state])),bm=new Map(b.drawings.map(d=>[d.drawingId,d.state]));
    for(const drawingId of [...new Set([...am.keys(),...bm.keys()])].sort())if(!C.equal(am.get(drawingId),bm.get(drawingId)))
      metadataChanges.push({kind:'drawing',drawingId,before:copy(am.get(drawingId)??null),after:copy(bm.get(drawingId)??null)});
    const retainedAfter=copy(after),retained=recordMap(retainedAfter);
    for(const key of [...new Set([...old.keys(),...next.keys()])].sort()){
      const previous=old.get(key),current=next.get(key),drawingId=(current||previous).drawingId,recordId=(current||previous).record.id;
      if(!current){issues.push(issue('BRIDGE_RECORD_REMOVAL',drawingId,recordId,'削除履歴なしで記録がなくなっています。元の記録を保持しています'));continue;}
      if(previous&&C.equal(cleanRecord(previous.record),cleanRecord(current.record)))continue;
      try{
        const eventId=idFactory();insist(valid(eventId),'BRIDGE_EVENT_ID','編集の識別番号を作成できません');
        const normalized=candidate(previous?.record||null,current.record,{actor,at,idFactory});
        const base=previous?cleanRecord(C.upgrade(cleanRecord(previous.record))):null;
        const event=D.diffRecord(base,normalized,{eventId,projectId:scope.projectId,deviceId:scope.deviceId,drawingId});
        if(!event)continue;
        changes.push({drawingId,before:base,after:normalized,eventId});
        const d=retainedAfter.drawings.find(d=>d.meta.id===drawingId),r=retained.get(key);
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
    ordered.push(...Object.keys(state.records).filter(key=>!old.has(key)).sort());
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
      drawing.meta.shapeCount=drawing.state.shapes.length;
      drawing.meta.photoCount=drawing.state.shapes.reduce((n,r)=>n+(r.photos||[]).length,0);
    }
    template.project.drawings=template.project.drawings.map(meta=>copy(drawings.get(meta.id).meta));
    delete template.rawEntries;
    template.source='delta-replica-projection';template.readyForActivation=false;
    return template;
  }
  function createBridge({replica,scope:inputScope,localProjectId,currentScope}={}){
    const scope=scopeOf(inputScope);
    insist(replica&&typeof replica.snapshotWithStatus==='function'&&typeof replica.changeBatch==='function'&&typeof currentScope==='function'&&valid(localProjectId),
      'BRIDGE_CONFIG','原子的な複数記録の保存方法が必要です');
    const plans=new WeakMap();let closed=false;
    function active(){insist(!closed,'BRIDGE_CLOSED','この編集接続は終了しています');
      insist(sameScope(scope,currentScope()),'BRIDGE_SCOPE','利用者・案件・端末が切り替わっています。入力は元の案件に残してください');}
    async function prepareEdit(options={}){
      active();const plan=prepare({...options,scope,localProjectId});
      const current=await replica.snapshotWithStatus();active();
      insist(sameScope(current.snapshot?.scope,scope),'BRIDGE_SCOPE','編集先の保存状態が一致しません');
      // A record untouched by this particular draft still must be present in
      // the authoritative replica, otherwise projecting a successful save
      // could silently drop it from the editor.
      for(const [key,entry] of recordMap(plan.before))try{
        const base=cleanRecord(entry.record),value=current.snapshot.records[key];
        insist(base.collab&&C.equal(base,C.upgrade(base)),'BRIDGE_UNTRACKED_BASE','編集開始時点に履歴へ入っていない記録があります');
        insist(value,'BRIDGE_RECORD_MISSING','編集元の記録が移行先にありません');
        D.diffRecord(base,value,{eventId:'bridge-lineage-check',drawingId:entry.drawingId,projectId:scope.projectId,deviceId:scope.deviceId});
      }catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',entry.drawingId,entry.record.id,error.message));}
      try{project({template:plan.after,state:current.snapshot,scope,localProjectId});}
      catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',null,null,error.message));}
      const rebased=[];
      for(const change of plan.changes){
        try{
          const key=D.keyOf(change.drawingId,change.after.id),value=own(current.snapshot.records,key)?current.snapshot.records[key]:null;
          if(!change.before){insist(!value,'BRIDGE_RECORD_COLLISION','同じIDの別の記録があります');rebased.push(change);continue;}
          insist(value,'BRIDGE_RECORD_MISSING','編集元の記録が移行先にありません');
          // The opened draft can be older than a just-received revision, but its
          // immutable ancestors must already exist in the durable replica.
          D.diffRecord(change.before,value,{...change,projectId:scope.projectId,deviceId:scope.deviceId});
          const merged=C.mergeRecords(value,change.after,{base:change.before});
          insist(merged.ok,'BRIDGE_HISTORY',merged.reason||'編集内容を統合できません');
          const final={...change,before:copy(value),after:cleanRecord(merged.record)};
          D.diffRecord(final.before,final.after,{...final,projectId:scope.projectId,deviceId:scope.deviceId});rebased.push(final);
        }catch(error){plan.issues.push(issue(error.code||'BRIDGE_RECORD',change.drawingId,change.after.id,error.message));}
      }
      plan.changes=rebased;plan.ready=plan.issues.length===0&&plan.metadataChanges.length===0;
      const exposed=copy(plan);plans.set(exposed,{plan:copy(plan),snapshotToken:current.snapshotToken,receipt:null,pending:null});return exposed;
    }
    async function commit(exposed){
      active();const entry=plans.get(exposed);insist(entry,'BRIDGE_PLAN','この編集接続で作成した計画が必要です');
      if(entry.receipt)return copy(entry.receipt);
      if(entry.pending)return entry.pending;
      insist(entry.plan.ready,'BRIDGE_REVIEW','図面設定または記録の確認が必要です。入力全体を編集計画に保持しています');
      const task=(async()=>{
        let result;
        if(entry.plan.changes.length){result=await replica.changeBatch({changes:copy(entry.plan.changes),expectedSnapshotToken:entry.snapshotToken});active();}
        const current=await replica.snapshotWithStatus();active();
        if(!result){
          insist(current.snapshotToken===entry.snapshotToken,'DELTA_STALE','確認後に記録が変更されています。入力内容を保持して再確認してください');
          result={results:[],pending:current.snapshot.outbox.length,blocked:current.snapshot.blockedOutbox?.length||0,unchanged:true};
        }
        const projection=project({template:entry.plan.after,state:current.snapshot,scope,localProjectId});
        // Runtime snapshot tokens are identity proofs, not JSON receipt data.
        // Status/asset confirmation must obtain a fresh token from the replica.
        const {snapshotToken,...summary}=result;
        const receipt={saved:true,result:copy(summary),projection,readyForActivation:false};entry.receipt=copy(receipt);return receipt;
      })();
      entry.pending=task;
      try{return await task;}finally{entry.pending=null;}
    }
    return {prepare:prepareEdit,commit,project:async template=>{active();const current=await replica.snapshotWithStatus();active();return project({template,state:current.snapshot,scope,localProjectId});},
      close(){closed=true;},getScope:()=>copy(scope)};
  }
  const api={version:1,captureProject,metadataOf,prepare,project,createBridge};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaAppBridge=api;
})(typeof window!=='undefined'?window:globalThis);

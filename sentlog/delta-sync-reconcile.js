/* Verified baseline -> protected local changes. This module performs no I/O
 * other than the supplied read-only page callbacks and no store writes.
 * A plan never authorizes a cloud cutover or proves photo delivery.
 */
(function(root){
  'use strict';
  const C=root.SentlogRecordCollaboration || (typeof module==='object'&&module.exports?require('./record-collaboration.js'):null);
  const D=root.SentlogDeltaSyncCore || (typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
  if(!C||!D)throw Error('差分同期の照合機能を読み込めません');
  const SCOPE=['ownerId','projectId','deviceId'],GROUPS=['comments','fields','photos'];
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const HASH_FORMAT='postgres-jsonb-text-sha256-v1',PLAN_FORMAT='sentlog-delta-reconcile-plan-v1';
  const VIEW_KEYS=['currentPage','width','height','pdfPageInfo','nextGlobalNo','typeCounters','labelSize'];
  const META_LOCAL=['updatedAt','shapeCount','photoCount'];
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
  const valid=v=>typeof v==='string'&&v.length>0&&v.length<=512;
  const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
  const clone=v=>root.structuredClone(v);
  const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});
  const omit=(v,keys)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!keys.includes(k)));
  const pick=(v,keys)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>keys.includes(k)));
  const sameScope=(a,b)=>object(a)&&object(b)&&SCOPE.every(k=>a[k]===b[k]);
  function problem(code,message){return Object.assign(Error(message),{code});}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  function scopeOf(scope){insist(object(scope)&&SCOPE.every(k=>valid(scope[k])),'RECONCILE_SCOPE','照合する利用者・案件・端末が不正です');return Object.fromEntries(SCOPE.map(k=>[k,scope[k]]));}
  function guard(scope,currentScope,signal){
    insist(!signal?.aborted,'RECONCILE_ABORTED','初期データの照合を中止しました');
    if(currentScope)insist(sameScope(scope,currentScope()),'RECONCILE_SCOPE','照合中に利用者・案件・端末が変わりました');
  }
  function jsonValue(value,seen=new Set(),depth=0){
    insist(depth<=64,'RECONCILE_JSON','照合する情報の階層が深すぎます');
    if(value===null||typeof value==='boolean')return;
    if(typeof value==='number'){insist(Number.isFinite(value),'RECONCILE_JSON','照合する数値が不正です');return;}
    if(typeof value==='string'){
      // PostgreSQL jsonb cannot store NUL or unpaired UTF-16 surrogates.
      for(let i=0;i<value.length;i++){
        const n=value.charCodeAt(i);insist(n!==0,'RECONCILE_JSON','保存できない制御文字が含まれています');
        if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);insist(next>=0xdc00&&next<=0xdfff,'RECONCILE_JSON','文字の符号化が不正です');}
        else insist(n<0xdc00||n>0xdfff,'RECONCILE_JSON','文字の符号化が不正です');
      }
      return;
    }
    insist(object(value)||Array.isArray(value),'RECONCILE_JSON','照合する情報はJSONである必要があります');
    insist(!seen.has(value)&&(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value))),
      'RECONCILE_JSON','照合する情報の形式が不正です');
    seen.add(value);
    for(const [key,child]of Object.entries(value)){jsonValue(key,seen,depth+1);jsonValue(child,seen,depth+1);}
    if(Array.isArray(value))for(let i=0;i<value.length;i++)insist(own(value,i),'RECONCILE_JSON','一覧に欠けた項目があります');
    seen.delete(value);
  }
  function parse(text,label){
    insist(typeof text==='string','RECONCILE_JSON',label+'の正確なJSONがありません');
    let value;try{value=JSON.parse(text);}catch{throw problem('RECONCILE_JSON',label+'のJSONが不正です');}
    jsonValue(value);return value;
  }
  async function hash(text){
    insist(root.crypto?.subtle?.digest,'RECONCILE_HASH_UNAVAILABLE','内容の照合機能を利用できません');
    return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  // Plan diagnostics retain even malformed local values. They must not acquire
  // the lossy undefined/-0/NaN conversion of a normal JSON serialization.
  function lossless(value,seen=new Set()){
    if(value===undefined)return ['undefined'];
    if(value===null)return ['null'];
    if(typeof value==='number')return ['number',Object.is(value,-0)?'-0':Number.isFinite(value)?value:String(value)];
    if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
    insist(typeof value==='object'&&!seen.has(value),'RECONCILE_PLAN','照合結果の形式が不正です');seen.add(value);
    const out=Array.isArray(value)?['array',Array.from({length:value.length},(_,i)=>own(value,i)?lossless(value[i],seen):['hole'])]:
      ['object',Object.keys(value).sort().map(k=>[k,lossless(value[k],seen)])];seen.delete(value);return out;
  }
  const exactEqual=(a,b)=>JSON.stringify(lossless(a))===JSON.stringify(lossless(b));
  function receipt(value,scope){
    jsonValue(value);
    insist(object(value)&&value.schema===1&&valid(value.baselineId)&&value.ownerId===scope.ownerId&&value.projectId===scope.projectId&&
      valid(value.clientProjectId)&&Array.isArray(value.drawingIds)&&value.drawingIds.every(valid)&&new Set(value.drawingIds).size===value.drawingIds.length&&
      integer(value.snapshotRevision,1)&&value.cursor===0&&integer(value.recordCount)&&value.importedCount===value.recordCount&&
      integer(value.metadataCount,1)&&value.metadataCount===value.drawingIds.length+1&&
      digest(value.snapshotSha256)&&digest(value.manifestSha256)&&digest(value.metadataManifestSha256)&&value.hashFormat===HASH_FORMAT&&
      ['verified','active'].includes(value.state)&&typeof value.deltaEnabled==='boolean'&&value.deltaEnabled===(value.state==='active')&&
      value.deviceMigrationVerified===false&&value.assetDeliveryVerified===false,
      'RECONCILE_BASELINE_RECEIPT','初期基準の利用者・案件・版・確認状態が一致しません');
    return value;
  }
  function graph(record){
    insist(record?.collab?.version===1,'RECONCILE_LEGACY_RECORD','共同編集の履歴がない記録は、元の内容を残して確認が必要です');
    const normalized=C.upgrade(record),ids=new Set();
    for(const g of GROUPS)for(const entry of Object.values(normalized.collab[g]))for(const revision of entry.revisions)ids.add(revision.id);
    for(const r of normalized.collab.deletion.revisions)ids.add(r.id);
    for(const r of normalized.collab.deletion.revisions)insist(r.observed.every(id=>ids.has(id)),
      'RECONCILE_UNKNOWN_OBSERVED','削除が参照する変更履歴を確認できません');
    return normalized;
  }
  async function verifyRows(rows,r,metadata,check){
    const count=metadata?r.metadataCount:r.recordCount,seen=new Set(),manifest=[];
    insist(Array.isArray(rows)&&rows.length===count,'RECONCILE_BASELINE_COUNT','初期基準の取得件数が一致しません');
    for(let i=0;i<rows.length;i++){
      check();const row=rows[i];
      insist(object(row)&&row.ordinal===i+1&&digest(row.sha256)&&typeof row.manifestEntryJson==='string',
        'RECONCILE_BASELINE_ORDINAL','初期基準の取得順序が不正です');
      const text=metadata?row.metadataJson:row.recordJson;
      insist(typeof text==='string'&&await hash(text)===row.sha256,'RECONCILE_BASELINE_HASH','初期基準の内容が照合情報と一致しません');check();
      const value=parse(text,metadata?'図面情報':'記録'),entry=parse(row.manifestEntryJson,'照合一覧');
      if(metadata){
        insist(['header','drawing'].includes(row.kind)&&valid(row.key),'RECONCILE_BASELINE_METADATA','図面情報の識別情報が不正です');
        const expected={ordinal:row.ordinal,kind:row.kind,key:row.key,sha256:row.sha256};
        insist(C.equal(entry,expected)&&Object.keys(entry).length===4,'RECONCILE_BASELINE_MANIFEST','図面情報の照合一覧が一致しません');
        insist(i===0?row.kind==='header'&&row.key==='project':row.kind==='drawing'&&r.drawingIds.includes(row.key)&&!seen.has(row.key),
          'RECONCILE_BASELINE_METADATA','図面情報の順序または対象が一致しません');
        if(i>0)seen.add(row.key);
        insist(object(value),'RECONCILE_BASELINE_METADATA','図面情報の形式が不正です');
        if(i===0){
          insist(!own(value,'drawings')&&value.project?.id===r.clientProjectId&&Array.isArray(value.project.drawings)&&
            C.equal(value.project.drawings.map(d=>d?.id),r.drawingIds),'RECONCILE_BASELINE_METADATA','案件と図面情報が一致しません');
        }else insist(value.meta?.id===row.key&&object(value.state)&&!own(value.state,'shapes')&&!own(value.state,'collabDeletedRecords'),
          'RECONCILE_BASELINE_METADATA','図面情報に記録本体が混在しています');
        if(own(row,'value'))insist(exactEqual(row.value,value),'RECONCILE_BASELINE_MUTATED','取得した図面情報が変更されています');
        row.value=value;
      }else{
        insist(valid(row.drawingId)&&r.drawingIds.includes(row.drawingId)&&valid(row.recordId)&&value?.id===row.recordId,
          'RECONCILE_BASELINE_RECORD','初期基準の記録識別情報が一致しません');
        const key=D.keyOf(row.drawingId,row.recordId);insist(!seen.has(key),'RECONCILE_BASELINE_DUPLICATE','初期基準の記録が重複しています');seen.add(key);
        const expected={ordinal:row.ordinal,drawingId:row.drawingId,recordId:row.recordId,sha256:row.sha256};
        insist(C.equal(entry,expected)&&Object.keys(entry).length===4,'RECONCILE_BASELINE_MANIFEST','記録の照合一覧が一致しません');
        D.validateEvent({schema:1,eventId:'baseline:'+r.baselineId+':'+row.ordinal,projectId:r.projectId,deviceId:'baseline-reader',
          drawingId:row.drawingId,recordId:row.recordId,kind:'create',record:value});graph(value);
        if(own(row,'record'))insist(exactEqual(row.record,value),'RECONCILE_BASELINE_MUTATED','取得した記録が変更されています');
        row.record=value;
      }
      manifest.push(row.manifestEntryJson);
    }
    insist(await hash('['+manifest.join(', ')+']')===(metadata?r.metadataManifestSha256:r.manifestSha256),
      'RECONCILE_BASELINE_MANIFEST','初期基準の一覧全体を照合できません');check();
  }
  async function verifyBaseline(input,{scope:inputScope,currentScope,signal}={}){
    const scope=scopeOf(inputScope),copy=clone(input),check=()=>guard(scope,currentScope,signal);check();
    insist(copy?.version===1&&copy.kind==='sentlog-delta-baseline','RECONCILE_BASELINE','初期基準の形式が不正です');
    const r=receipt(copy.receipt,scope);
    await verifyRows(copy.records,r,false,check);await verifyRows(copy.metadata,r,true,check);
    copy.verified=true;return copy;
  }
  async function readBaseline({receipt:initialReceipt,readPage,readMetadataPage,scope:inputScope,currentScope,signal,pageLimit=100,maxRecords=20000,maxBytes=64*1024*1024}={}){
    const scope=scopeOf(inputScope),r=receipt(clone(initialReceipt),scope),check=()=>guard(scope,currentScope,signal);
    insist(typeof readPage==='function'&&typeof readMetadataPage==='function'&&integer(pageLimit,1)&&pageLimit<=100&&integer(maxRecords)&&integer(maxBytes,1),
      'RECONCILE_CONFIG','初期基準の取得方法または上限が不正です');check();
    insist(r.recordCount<=maxRecords&&r.metadataCount<=maxRecords+1,'RECONCILE_BASELINE_LIMIT','初期基準がこの端末の一度の照合上限を超えています');
    let used=0;
    async function pages(callback,field,count){
      const rows=[];let after=0;
      do{
        check();const page=clone(await callback(after,pageLimit));check();receipt(page?.receipt,scope);
        insist(exactEqual(page.receipt,r),'RECONCILE_BASELINE_CHANGED','初期基準が取得中に変わりました');
        insist(Array.isArray(page[field])&&page[field].length<=pageLimit&&integer(page.nextOrdinal)&&
          page.nextOrdinal===after+page[field].length&&page.nextOrdinal<=count&&page.hasMore===(page.nextOrdinal<count)&&
          (page[field].length>0||after===count),'RECONCILE_BASELINE_PAGE','初期基準のページが欠落または重複しています');
        for(const row of page[field]){
          insist(object(row)&&row.ordinal===rows.length+1,'RECONCILE_BASELINE_ORDINAL','初期基準の取得順序が不正です');
          const raw=field==='records'?row.recordJson:row.metadataJson;
          insist(typeof raw==='string'&&typeof row.manifestEntryJson==='string','RECONCILE_BASELINE_PAGE','初期基準の内容がありません');
          used+=new TextEncoder().encode(raw).byteLength+new TextEncoder().encode(row.manifestEntryJson).byteLength;
          insist(used<=maxBytes,'RECONCILE_BASELINE_LIMIT','初期基準がこの端末の一度の照合容量を超えています');rows.push(row);
        }
        after=page.nextOrdinal;
      }while(after<count);
      return rows;
    }
    const records=await pages(readPage,'records',r.recordCount),metadata=await pages(readMetadataPage,'metadata',r.metadataCount);
    return verifyBaseline({version:1,kind:'sentlog-delta-baseline',receipt:r,records,metadata},{scope,currentScope,signal});
  }
  function stripCaches(record){
    const out=clone(record);if(Array.isArray(out.photos))for(const p of out.photos)if(object(p)){delete p.localBlob;delete p.data;}
    return out;
  }
  function normalizedRecord(record){
    const raw=stripCaches(record);jsonValue(raw);const normalized=graph(raw);
    // The collaboration merger intentionally rebuilds these containers. A
    // future/unknown property must be reviewed rather than disappear there.
    const allowed=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));
    insist(allowed(raw.collab,['version','comments','fields','photos','deletion','projection'])&&
      (!own(raw.collab,'projection')||object(raw.collab.projection)&&allowed(raw.collab.projection,['memo']))&&
      GROUPS.every(g=>Object.values(raw.collab[g]).every(entry=>allowed(entry,g==='comments'?['order','revisions']:['revisions'])))&&
      allowed(raw.collab.deletion,['revisions']),
      'RECONCILE_UNKNOWN_HISTORY_METADATA','未対応の共同編集情報を、元の内容のまま確認待ちに残しました');
    const projected=omit(normalized,['collab']),source=omit(raw,['collab']);
    if(!own(source,'memo'))source.memo='';if(!own(source,'photos'))source.photos=[];
    insist(C.equal(source,projected),'RECONCILE_UNRECORDED_EDIT','履歴にまだ反映されていない入力を、元の内容のまま確認待ちに残しました');
    return normalized;
  }
  // jsonb emits a space after separators and expands exponent notation. Count
  // its serialized size before queueing, not only the shorter JS JSON form.
  function pgNumber(value){
    const s=JSON.stringify(value);if(!/[eE]/.test(s))return s;
    const [,sign,whole,fraction='',power]=s.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/),digits=whole+fraction,at=whole.length+Number(power);
    return sign+(at<=0?'0.'+'0'.repeat(-at)+digits:at>=digits.length?digits+'0'.repeat(at-digits.length):digits.slice(0,at)+'.'+digits.slice(at));
  }
  function pgText(value){
    if(typeof value==='number')return pgNumber(value);
    if(Array.isArray(value))return '['+value.map(pgText).join(', ')+']';
    if(object(value))return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+pgText(v)).join(', ')+'}';
    return JSON.stringify(value);
  }
  function publicProject(value){return {...omit(value,['updatedAt','drawings']),drawings:(value.drawings||[]).map(m=>omit(m,META_LOCAL))};}
  function publicDrawing(value){return {...value,meta:omit(value.meta,META_LOCAL),state:omit(value.state,VIEW_KEYS)};}
  function review(list,code,message,details={},blocking=true){list.push({code,message,blocking,...clone(details)});}
  function extractLocal(snapshot,reviews){
    const raw=new Map();
    for(const entry of snapshot.rawEntries){
      insist(object(entry)&&valid(entry.key)&&!raw.has(entry.key),'RECONCILE_SOURCE_FORMAT','旧保存のキーが不正または重複しています');raw.set(entry.key,entry.value);
    }
    function read(key,label){try{return parse(raw.get(key),label);}catch(error){review(reviews,error.code,error.message,{sourceKey:key,rawValue:raw.get(key)});return null;}}
    const workspace=read(WS,'案件一覧'),matches=Array.isArray(workspace?.projects)?workspace.projects.filter(p=>p?.id===snapshot.projectId):[];
    if(matches.length!==1||!Array.isArray(matches[0]?.drawings)){
      review(reviews,'RECONCILE_SOURCE_PROJECT','旧保存から対象案件を一意に読み取れません',{sourceKey:WS});return {project:null,drawings:[],records:new Map(),localView:{}};
    }
    const project=matches[0],drawings=[],records=new Map(),seen=new Set(),localView={project:pick(project,['updatedAt']),drawings:{}};
    for(const meta of project.drawings){
      if(!object(meta)||!valid(meta.id)||seen.has(meta.id)){review(reviews,'RECONCILE_SOURCE_DRAWING','旧保存の図面IDが不正または重複しています',{localMeta:meta});continue;}
      seen.add(meta.id);const state=read(DRAW+meta.id,'図面 '+meta.id);
      if(!object(state)||!Array.isArray(state.shapes)||own(state,'collabDeletedRecords')&&!Array.isArray(state.collabDeletedRecords)){
        review(reviews,'RECONCILE_SOURCE_DRAWING','旧保存の図面記録を読み取れません',{drawingId:meta.id,localMeta:meta,localState:state});continue;
      }
      drawings.push({meta:clone(meta),state:omit(state,['shapes','collabDeletedRecords'])});
      put(localView.drawings,meta.id,{meta:pick(meta,META_LOCAL),state:pick(state,VIEW_KEYS)});
      for(const bucket of ['shapes','collabDeletedRecords'])for(const record of state[bucket]||[]){
        if(!object(record)||!valid(record.id)){review(reviews,'RECONCILE_SOURCE_RECORD','旧保存の記録IDを確認できません',{drawingId:meta.id,bucket,localRecord:record});continue;}
        const key=D.keyOf(meta.id,record.id),group=records.get(key)||[];group.push({drawingId:meta.id,recordId:record.id,bucket,record:clone(record)});records.set(key,group);
      }
    }
    for(const [key,value]of raw)if(key.startsWith(DRAW)&&!seen.has(key.slice(DRAW.length)))
      review(reviews,'RECONCILE_SOURCE_ORPHAN','案件一覧にない図面の保存内容を確認待ちに残しました',{sourceKey:key,rawValue:value});
    return {project,drawings,records,localView};
  }
  async function plan({scope:inputScope,baseline:inputBaseline,localSnapshot:inputSnapshot,currentScope,signal,groupTransport}={}){
    const scope=scopeOf(inputScope),snapshot=clone(inputSnapshot),baselineInput=clone(inputBaseline),check=()=>guard(scope,currentScope,signal);check();
    insist(snapshot?.version===1&&snapshot.kind==='sentlog-legacy-source'&&valid(snapshot.projectId)&&digest(snapshot.fingerprint)&&
      Array.isArray(snapshot.rawEntries)&&Array.isArray(snapshot.issues),'RECONCILE_SOURCE_FORMAT','保護した旧保存の控えが不正です');
    const baseline=await verifyBaseline(baselineInput,{scope,currentScope,signal}),r=baseline.receipt;
    insist(snapshot.projectId===r.clientProjectId,'RECONCILE_SCOPE','端末とサーバーの案件対応が一致しません');check();
    const reviews=[];
    for(const issue of snapshot.issues)review(reviews,issue.code||'RECONCILE_SOURCE_REVIEW',issue.message||'旧保存に確認待ちの内容があります',{sourceIssue:issue},issue.blocking!==false);
    if(snapshot.readyForStaging!==true&&!reviews.some(x=>x.blocking))review(reviews,'RECONCILE_SOURCE_UNVERIFIED','旧保存の控えを照合できていません');
    const local=extractLocal(snapshot,reviews),header=baseline.metadata[0].value,serverDrawings=baseline.metadata.slice(1).map(x=>x.value);
    const localByDrawing=new Map(local.drawings.map(d=>[d.meta.id,d])),headerByDrawing=new Map(header.project.drawings.map(d=>[d.id,d]));
    if(!local.project||!C.equal(publicProject(local.project),publicProject(header.project)))
      review(reviews,'RECONCILE_PROJECT_METADATA','案件名・図面一覧などの変更を確認待ちに残しました',{serverProject:header.project,localProject:local.project});
    if(Object.keys(header).some(k=>k!=='project'))review(reviews,'RECONCILE_HEADER_METADATA','未対応の案件情報を確認待ちに残しました',{serverHeader:header});
    if(!C.equal(serverDrawings.map(d=>d.meta.id),r.drawingIds))review(reviews,'RECONCILE_BASELINE_DRAWING_METADATA',
      'サーバーの案件一覧と図面本体で並び順が異なります',{drawingIds:r.drawingIds,serverDrawingIds:serverDrawings.map(d=>d.meta.id)});
    for(const drawing of serverDrawings){
      if(!C.equal(omit(headerByDrawing.get(drawing.meta.id),META_LOCAL),omit(drawing.meta,META_LOCAL)))review(reviews,'RECONCILE_BASELINE_DRAWING_METADATA',
        'サーバーの案件一覧と図面本体で設定が異なります',{drawingId:drawing.meta.id,serverProjectMeta:headerByDrawing.get(drawing.meta.id),serverDrawingMeta:drawing.meta});
      const other=localByDrawing.get(drawing.meta.id);
      if(!other||!C.equal(publicDrawing(other),publicDrawing(drawing)))review(reviews,'RECONCILE_DRAWING_METADATA',
        '図面・用紙・縮尺・回転などの変更を確認待ちに残しました',{drawingId:drawing.meta.id,serverDrawing:drawing,localDrawing:other||null});
    }
    const allowed=new Set(r.drawingIds),state={version:2,scope:clone(scope),cursor:0,records:{},outbox:[],blockedOutbox:[]},server=new Map();
    for(const row of baseline.records){
      const key=D.keyOf(row.drawingId,row.recordId);server.set(key,row);put(state.records,key,clone(row.record));
      try{put(state.records,key,normalizedRecord(row.record));}
      catch(error){review(reviews,error.code||'RECONCILE_BASELINE_RECORD',error.message,{drawingId:row.drawingId,recordId:row.recordId,serverRecord:row.record});}
    }
    for(const [key,group]of [...local.records].sort(([a],[b])=>a<b?-1:a>b?1:0)){
      check();const first=group[0],old=server.get(key),details={drawingId:first.drawingId,recordId:first.recordId,
        serverRecord:old?.record||null,localRecords:group.map(x=>({bucket:x.bucket,record:x.record}))};
      if(group.length!==1){review(reviews,'RECONCILE_DUPLICATE_RECORD','同じ記録IDの複数の保存内容を確認待ちに残しました',details);continue;}
      if(!allowed.has(first.drawingId)){review(reviews,'RECONCILE_DRAWING_NOT_IN_BASELINE','サーバーの初期基準にない図面の記録を保護しています',details);continue;}
      try{
        const candidate=normalizedRecord(first.record),view=C.view(candidate);
        insist((first.bucket==='collabDeletedRecords')===view.deleted,'RECONCILE_DELETION_STATE','記録の削除状態と保存先が一致しません');
        let merged=candidate;
        if(old){
          const serverRecord=normalizedRecord(old.record),joined=C.mergeRecords(serverRecord,candidate);
          insist(joined.ok,joined.code||'RECONCILE_HISTORY_COLLISION',joined.reason||'記録の変更履歴が一致しません');merged=joined.record;
        }
        graph(merged);
        const placeholder=D.diffRecord(old?.record||null,merged,{eventId:'migration:'+'0'.repeat(64),projectId:scope.projectId,drawingId:first.drawingId,deviceId:scope.deviceId});
        let event=null;
        if(placeholder){
          const material=omit(placeholder,['eventId']);event={...placeholder,eventId:'migration:'+await hash(JSON.stringify(C.canonical([scope.ownerId,material])))};check();
          D.validateEvent(event);insist(new TextEncoder().encode(pgText(event)).byteLength<=256*1024,'RECONCILE_EVENT_TOO_LARGE','この記録の変更履歴は一度の送信上限を超えています');
          const replayed=D.combine(old?.record||null,event);
          insist(C.equal(replayed,merged),'RECONCILE_REPLAY_MISMATCH','送信差分から元の記録を再現できません');
        }
        put(state.records,key,merged);if(event)state.outbox.push(event);
        const conflicts=C.view(merged).conflicts;
        if(conflicts.length)review(reviews,'RECONCILE_CONCURRENT_EDITS','同時の変更候補を両方保持しました',{drawingId:first.drawingId,recordId:first.recordId,conflicts},false);
      }catch(error){review(reviews,error.code||'RECONCILE_RECORD',error.message||'記録の照合を完了できません',details);}
    }
    // A legacy move must retain its source tombstone and destination in one
    // durable unit. Only an authenticated, capability-checked transport may
    // turn those pending events into a sendable atomic group.
    const created=state.outbox.filter(e=>e.kind==='create');
    const deletionIntent=state.outbox.filter(e=>e.kind==='patch'&&e.patch.deletion.some(r=>r.deleted===true));
    const moveMarkers=state.outbox.filter(e=>e.kind==='create'?e.record.transferOrigin?.operation==='move':
      e.patch.fields.transferOrigin?.revisions.some(r=>r.value?.operation==='move'));
    const relocated=created.filter(e=>baseline.records.some(row=>row.recordId===e.recordId&&row.drawingId!==e.drawingId&&
      !local.records.has(D.keyOf(row.drawingId,row.recordId))));
    if(moveMarkers.length||relocated.length||created.length&&deletionIntent.length){
      const identity=e=>({eventId:e.eventId,drawingId:e.drawingId,recordId:e.recordId});
      // A group is an atomic transport boundary, not proof that both halves
      // were captured. A destination-only legacy draft still needs its source
      // tombstone (or an already-deleted baseline source) before installation.
      for(const event of moveMarkers){
        const origins=event.kind==='create'?[event.record.transferOrigin]:
          event.patch.fields.transferOrigin.revisions.filter(r=>r.value?.operation==='move').map(r=>r.value);
        for(const origin of origins){
          const key=valid(origin?.drawingId)&&valid(origin?.recordId)?D.keyOf(origin.drawingId,origin.recordId):null;
          const source=key&&state.records[key],view=source&&C.view(source);
          if(!source||(!view.deleted&&!view.pendingDelete))review(reviews,'RECONCILE_MOVE_INCOMPLETE',
            '移動先に対応する移動元の削除履歴を確認できません。入力全体を保持しています',
            {destination:identity(event),origin:clone(origin),source:source||null});
        }
      }
      if(relocated.length)review(reviews,'RECONCILE_MOVE_INCOMPLETE','移動元の記録が控えからなくなっています。削除履歴を確認するまで引き継ぎを確定しません',
        {relocatedRecords:relocated.map(identity)});
      let enabled=false;try{enabled=typeof groupTransport?.pushGroup==='function'&&groupTransport.getCapabilities?.().atomicGroups===true;}catch{}
      if(enabled){
        try{
          const groupId='migration-group:'+await hash(JSON.stringify(C.canonical([scope,state.outbox])));check();
          insist(groupTransport.getCapabilities?.().atomicGroups===true,'RECONCILE_ATOMIC_GROUP_REQUIRED','一括同期の接続確認が変わりました');
          const group=D.validateGroup({schema:1,kind:'atomic-group',groupId,projectId:scope.projectId,deviceId:scope.deviceId,events:state.outbox});
          state.outbox=[group];
        }catch(error){review(reviews,error.code||'RECONCILE_ATOMIC_GROUP_REQUIRED',error.message||'一括操作の内容を保持して確認を待っています');}
      }else review(reviews,'RECONCILE_ATOMIC_GROUP_REQUIRED','移動元と移動先を一緒に共有する機能が未接続です。変更全体を保持し、引き継ぎを確定していません',
        {pendingCreates:created.map(identity),pendingDeletions:deletionIntent.map(identity),moveMarkers:moveMarkers.map(identity),relocatedRecords:relocated.map(identity)});
    }
    const result={version:1,kind:'sentlog-delta-reconciliation',hashFormat:PLAN_FORMAT,scope:clone(scope),baselineReceipt:clone(r),
      sourceFingerprint:snapshot.fingerprint,localProjectId:snapshot.projectId,state,reviewItems:reviews,
      metadata:{header:clone(header),drawings:clone(serverDrawings),localView:local.localView},
      preservedLocal:{rawEntries:clone(snapshot.rawEntries),source:clone(snapshot.source),originals:clone(snapshot.originals||[]),
        captureIntentRaw:snapshot.captureIntentRaw??null,files:(snapshot.files||[]).map(({blob,...info})=>clone(info)),manifest:clone(snapshot.manifest||[])},
      summary:{baselineRecords:r.recordCount,localRecords:[...local.records.values()].reduce((n,g)=>n+g.length,0),
        records:Object.keys(state.records).length,pending:state.outbox.length,pendingEvents:state.outbox.reduce((n,e)=>n+D.eventsOf(e).length,0),
        blocking:reviews.filter(x=>x.blocking).length,conflicts:reviews.filter(x=>!x.blocking&&x.code==='RECONCILE_CONCURRENT_EDITS').length},
      readyForInstall:!reviews.some(x=>x.blocking),readyForActivation:false,readyForCloudSync:false};
    jsonValue(result.metadata);result.planSha256=await hash(JSON.stringify(lossless(result)));check();return result;
  }
  async function verifyPlan(input,{scope:inputScope,currentScope,signal}={}){
    const scope=scopeOf(inputScope),value=clone(input),check=()=>guard(scope,currentScope,signal);check();
    insist(value?.version===1&&value.kind==='sentlog-delta-reconciliation'&&value.hashFormat===PLAN_FORMAT&&sameScope(value.scope,scope)&&
      value.state?.version===2&&sameScope(value.state.scope,scope)&&value.state.cursor===0&&object(value.state.records)&&Array.isArray(value.state.outbox)&&
      Array.isArray(value.state.blockedOutbox)&&value.state.blockedOutbox.length===0&&Array.isArray(value.reviewItems)&&
      value.readyForInstall===!value.reviewItems.some(x=>x.blocking)&&value.readyForActivation===false&&value.readyForCloudSync===false&&
      digest(value.sourceFingerprint)&&digest(value.planSha256),'RECONCILE_PLAN','照合結果の形式または対象が一致しません');
    receipt(value.baselineReceipt,scope);insist(value.localProjectId===value.baselineReceipt.clientProjectId,'RECONCILE_SCOPE','照合した案件の対応が一致しません');
    jsonValue(value.metadata);
    const expected=value.planSha256;delete value.planSha256;
    insist(await hash(JSON.stringify(lossless(value)))===expected,'RECONCILE_PLAN_CHANGED','照合後の保存予定が変更されています');check();
    D.validateState(value.state,scope,true);
    for(const [key,record]of Object.entries(value.state.records)){
      let parts;try{parts=JSON.parse(key);}catch{}
      insist(Array.isArray(parts)&&parts.length===2&&parts.every(valid)&&key===D.keyOf(...parts)&&record.id===parts[1],
        'RECONCILE_PLAN','保存予定の記録IDが一致しません');graph(record);
    }
    return true;
  }
  const api={version:1,readBaseline,verifyBaseline,plan,verifyPlan};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaReconcile=api;
})(typeof window!=='undefined'?window:globalThis);

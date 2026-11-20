/* Shared project/drawing settings, represented by ordinary immutable records.
 * Object properties are independent registers; arrays remain atomic values.
 * This module neither enables a project nor writes a legacy UI database.
 */
(function(root){
  'use strict';
  const C=root.SentlogRecordCollaboration||(typeof module==='object'&&module.exports?require('./record-collaboration.js'):null);
  const D=root.SentlogDeltaSyncCore||(typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
  const NS='@sentlog:metadata:v1',ENVELOPE='deltaMetadata',VERSION=1;
  const VIEW=['currentPage','width','height','pdfPageInfo','labelSize','nextGlobalNo','typeCounters'];
  const PROJECT_OMIT=['id','drawings','updatedAt','collaborationVersion',ENVELOPE];
  const META_OMIT=['id','updatedAt','shapeCount','photoCount'];
  const STATE_OMIT=['shapes','collabDeletedRecords',...VIEW];
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const copy=x=>x===undefined?undefined:root.structuredClone(x);
  const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,writable:true,enumerable:true,configurable:true});
  const cmp=C.compareIds||((a,b)=>a<b?-1:a>b?1:0);
  const pathKey=path=>path.map(part=>new TextEncoder().encode(part).length+':'+part).join('');
  const keyOf=(id)=>D.keyOf(NS,id);
  const absent=path=>({path:copy(path),type:'absent',observed:[]});
  const OMIT=Symbol('absent');
  function problem(code,message){return Object.assign(Error(message),{code});}
  function assert(ok,code,message){if(!ok)throw problem(code,message);}
  function validId(x){return typeof x==='string'&&x.length>0&&x.length<=512;}
  async function hash(text){return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  const fieldKey=async path=>'m:'+await hash(pathKey(path));
  const drawingRecordId=async drawingId=>'drawing:'+await hash(drawingId);
  const stableId=async(kind,parts)=>'metadata:'+kind+':'+await hash(pathKey(parts));
  function json(value,depth=0){
    assert(depth<=48,'METADATA_DEPTH','設定の階層が深すぎます');
    if(value===null||typeof value==='boolean')return;
    if(typeof value==='string'){
      assert(!value.includes('\u0000')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),'METADATA_JSON','設定の文字を保存できません');return;
    }
    if(typeof value==='number'){assert(Number.isFinite(value),'METADATA_JSON','設定の数値が不正です');return;}
    assert(Array.isArray(value)||object(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'METADATA_JSON','設定にはJSONの値が必要です');
    for(const [key,child]of Object.entries(value)){json(key,depth+1);json(child,depth+1);}
  }
  function clean(value,excluded){const out=copy(value||{});for(const key of excluded)delete out[key];return out;}
  function normalize(input){
    assert(object(input)&&object(input.project)&&validId(input.project.id)&&Array.isArray(input.project.drawings)&&Array.isArray(input.drawings),'METADATA_SOURCE','案件と図面の設定を確認できません');
    assert(!own(input,'localProjectId')||input.localProjectId===input.project.id,'METADATA_IDENTITY','設定の案件が一致しません');
    const ids=new Set();for(const meta of input.project.drawings){assert(object(meta)&&validId(meta.id)&&meta.id!==NS&&!ids.has(meta.id),'METADATA_IDENTITY','図面の識別情報が重複しています');ids.add(meta.id);}
    const seen=new Set();for(const drawing of input.drawings){assert(object(drawing)&&ids.has(drawing.meta?.id)&&!seen.has(drawing.meta.id)&&C.equal(drawing.meta,input.project.drawings.find(d=>d.id===drawing.meta.id))&&object(drawing.state),'METADATA_SOURCE','図面一覧と設定が一致しません');seen.add(drawing.meta.id);}
    assert(seen.size===ids.size,'METADATA_SOURCE','図面の設定が不足しています');
    if(own(input.project,ENVELOPE))validateEnvelope(input.project[ENVELOPE]);
    return input;
  }
  function validateEnvelope(value){
    assert(object(value)&&value.version===VERSION&&value.namespace===NS&&object(value.records)&&Array.isArray(value.retainedDrawings),'METADATA_ENVELOPE','保持した設定履歴の形式を確認できません');
    const ids=new Set();for(const drawing of value.retainedDrawings){assert(object(drawing)&&validId(drawing.meta?.id)&&object(drawing.state)&&!ids.has(drawing.meta.id),'METADATA_ENVELOPE','保持した図面の識別情報が不正です');ids.add(drawing.meta.id);}
    return value;
  }
  function shared(input){normalize(input);return {project:clean(input.project,PROJECT_OMIT),drawings:input.project.drawings.map((meta,index)=>{
    const drawing=input.drawings.find(d=>d.meta.id===meta.id);return {drawingId:meta.id,meta:clean(meta,META_OMIT),state:clean(drawing.state,STATE_OMIT),order:index};
  })};}
  function flatten(value,path,out=new Map()){
    json(value);out.set(pathKey(path),{path:copy(path),type:object(value)?'object':'value',...(!object(value)?{value:copy(value)}:{})});
    if(object(value))for(const key of Object.keys(value).sort(cmp))flatten(value[key],[...path,key],out);
    return out;
  }
  function documentNodes(kind,value){
    const out=new Map();if(kind==='project')flatten(value.project,['project'],out);
    else {flatten(value.meta,['meta'],out);flatten(value.state,['state'],out);flatten(value.order,['order'],out);}return out;
  }
  async function documentSpecs(input){const value=shared(input),localProjectId=input.project.id,out=new Map();
    out.set('project',{id:'project',identity:{version:VERSION,kind:'project',localProjectId},nodes:documentNodes('project',value)});
    for(const drawing of value.drawings){const id=await drawingRecordId(drawing.drawingId);out.set(id,{id,identity:{version:VERSION,kind:'drawing',localProjectId,drawingId:drawing.drawingId},nodes:documentNodes('drawing',drawing)});}return out;
  }
  function heads(entry){const parents=new Set(entry.revisions.flatMap(r=>r.parents));return entry.revisions.filter(r=>!parents.has(r.id)).sort((a,b)=>cmp(a.id,b.id));}
  function ancestors(entry,id){const byId=new Map(entry.revisions.map(r=>[r.id,r])),out=new Set(),todo=[id];while(todo.length){const next=todo.pop();if(out.has(next))continue;out.add(next);const row=byId.get(next);assert(row,'METADATA_HISTORY','設定の変更元が不足しています');todo.push(...row.parents);}return out;}
  function maximal(entry,rows){return rows.filter(row=>!rows.some(other=>row.id!==other.id&&ancestors(entry,other.id).has(row.id))).sort((a,b)=>cmp(a.id,b.id));}
  function semantic(node){if(!node||node.type==='absent')return {type:'absent'};return node.type==='object'?{type:'object'}:{type:'value',value:node.value};}
  function descendant(path,parent){return path.length>parent.length&&parent.every((part,i)=>path[i]===part);}
  async function seedDocument(spec){
    const fields={},actor={deviceId:null,deviceName:'不明'};
    const values=new Map([['geometry',{}],['metaIdentity',spec.identity]]);
    for(const node of spec.nodes.values())values.set(await fieldKey(node.path),node);
    for(const [key,value]of values)put(fields,key,{revisions:[{id:await stableId('seed',[spec.id,key]),parents:[],value:copy(value),actor:copy(actor),at:0}]});
    return C.upgrade({id:spec.id,collab:{version:1,fields,comments:{},photos:{},deletion:{revisions:[{id:await stableId('seed',[spec.id,'@alive']),parents:[],deleted:false,observed:[],actor:copy(actor),at:0}]},projection:{memo:''}}});
  }
  async function validateDocument(record){
    assert(object(record)&&record.collab,'METADATA_RECORD','設定の変更履歴がありません');const value=C.upgrade(record),v=C.view(value),identity=value.metaIdentity;
    assert(object(identity)&&identity.version===VERSION&&['project','drawing'].includes(identity.kind)&&validId(identity.localProjectId),'METADATA_IDENTITY','設定の所有元が不正です');
    const expected=identity.kind==='project'?'project':await drawingRecordId(identity.drawingId);
    assert(validId(identity.drawingId)||identity.kind==='project','METADATA_IDENTITY','図面の識別情報が不正です');
    assert(value.id===expected&&Object.keys(value.collab.comments).length===0&&Object.keys(value.collab.photos).length===0,'METADATA_IDENTITY','設定用の記録が別の用途と重複しています');
    assert(value.collab.fields.metaIdentity.revisions.every(r=>!r.unset&&C.equal(r.value,identity))&&value.collab.fields.geometry?.revisions.every(r=>!r.unset&&C.equal(r.value,{})),'METADATA_IDENTITY','設定の所有元が書き換えられています');
    const nodes=new Map(),allRevisionIds=new Set(Object.values(value.collab.fields).flatMap(e=>e.revisions.map(r=>r.id)));
    for(const [key,entry]of Object.entries(value.collab.fields)){
      if(['geometry','metaIdentity'].includes(key))continue;
      assert(/^m:[a-f0-9]{64}$/.test(key),'METADATA_FIELD','設定の項目名が不正です');let path;
      for(const revision of entry.revisions){
        assert(revision.unset!==true&&object(revision.value),'METADATA_NODE','設定の値が不正です');const node=revision.value;
        assert(Array.isArray(node.path)&&node.path.length>0&&node.path.length<=48&&node.path.every(p=>typeof p==='string')&&['object','value','absent'].includes(node.type),'METADATA_NODE','設定のパスが不正です');
        json(node.path);assert(await fieldKey(node.path)===key&&(!path||C.equal(path,node.path)),'METADATA_PATH_COLLISION','設定のパスと識別情報が一致しません');path=node.path;
        assert((identity.kind==='project'?['project']:['meta','state','order']).includes(path[0]),'METADATA_NODE','設定の保存先が不正です');
        assert(path.length!==1||node.type==='object'||path[0]==='order','METADATA_NODE','設定のルートが不正です');
        if(path.length>1)assert(!(path[0]==='project'?PROJECT_OMIT:path[0]==='meta'?META_OMIT:path[0]==='state'?STATE_OMIT:[]).includes(path[1])&&path[0]!=='order','METADATA_RESERVED','表示・識別用の項目を共有設定として変更することはできません');
        if(node.type==='value'){assert(own(node,'value')&&!object(node.value),'METADATA_NODE','オブジェクトの設定は項目ごとの履歴が必要です');json(node.value);}
        if(own(node,'observed'))assert(Array.isArray(node.observed)&&node.observed.every(id=>typeof id==='string'&&allRevisionIds.has(id))&&new Set(node.observed).size===node.observed.length,'METADATA_OBSERVED','設定を削除した際の確認履歴が不正です');
      }
      const field=v.fields[key];nodes.set(pathKey(path),{key,path:copy(path),entry,field,node:field.unset?null:copy(field.value)});
    }
    for(const item of nodes.values())for(const revision of item.entry.revisions)for(const observed of revision.value.observed||[]){
      assert([...nodes.values()].some(other=>descendant(other.path,item.path)&&other.entry.revisions.some(r=>r.id===observed)),'METADATA_OBSERVED','設定の削除確認が別の項目を参照しています');
    }
    for(const name of identity.kind==='project'?['project']:['meta','state','order'])assert(nodes.has(pathKey([name])),'METADATA_ROOT','設定のルートがありません');
    return {record:value,identity:copy(identity),view:v,nodes};
  }
  async function materializeDocument(record){
    const doc=await validateDocument(record),conflicts=[];
    for(const item of doc.nodes.values())if(item.field.conflict)conflicts.push({kind:'metadata-field',recordId:record.id,drawingId:doc.identity.drawingId||null,path:copy(item.path),key:item.key,headIds:copy(item.field.headIds),candidates:copy(item.field.heads),commonHeadIds:copy(item.field.commonHeadIds)});
    function build(path){
      const item=doc.nodes.get(pathKey(path)),node=item?.node;
      const children=[...new Set([...doc.nodes.values()].filter(child=>descendant(child.path,path)).map(child=>child.path[path.length]))].sort(cmp);
      if(node&&node.type!=='object'){
        const observed=new Set(node.observed||[]),unseen=[...doc.nodes.values()].filter(child=>descendant(child.path,path)).flatMap(child=>heads(child.entry)).filter(r=>!observed.has(r.id)).map(r=>r.id).sort(cmp);
        if(!unseen.length)return node.type==='absent'?OMIT:copy(node.value);
        conflicts.push({kind:'metadata-structure',recordId:record.id,drawingId:doc.identity.drawingId||null,path:copy(path),key:item.key,headIds:copy(item.field.headIds),unseenHeadIds:unseen,candidates:copy(item.field.heads)});
      }
      if(!node&&!children.length)return OMIT;
      const value={};for(const child of children){const result=build([...path,child]);if(result!==OMIT)put(value,child,result);}return value;
    }
    const out={identity:doc.identity,kind:doc.identity.kind,deleted:doc.view.deleted,pendingDelete:doc.view.pendingDelete,conflicts};
    if(out.kind==='project'){const value=build(['project']);out.project=value===OMIT?{}:value;}
    else {for(const key of ['meta','state','order']){const value=build([key]);if(value!==OMIT)out[key]=value;}
      out.meta=out.meta||{};out.state=out.state||{};
      if(out.order===undefined&&doc.nodes.get(pathKey(['order'])).field.conflict)out.order=0;
      assert(typeof out.order==='number'&&Number.isFinite(out.order),'METADATA_ORDER','図面の順序を確認できません');}
    return out;
  }
  function metadataRecords(records){
    const out={};for(const [key,record]of Object.entries(records||{})){
      let pair;try{pair=JSON.parse(key);}catch{}
      if(Array.isArray(pair)&&pair[0]===NS){assert(pair.length===2&&key===keyOf(record?.id)&&pair[1]===record.id,'METADATA_IDENTITY','設定履歴の識別情報が一致しません');put(out,record.id,copy(record));}
    }return out;
  }
  function expandRecords(records){const out={};for(const [id,record]of Object.entries(records||{})){assert(id===record?.id,'METADATA_IDENTITY','設定履歴の識別情報が一致しません');put(out,keyOf(id),copy(record));}return out;}
  async function seed(input){
    normalize(input);const envelope=input.project[ENVELOPE],specs=await documentSpecs(input),out={};
    if(envelope){
      for(const [id,record]of Object.entries(envelope.records)){const doc=await validateDocument(record);assert(id===record.id&&doc.identity.localProjectId===input.project.id,'METADATA_IDENTITY','別案件の設定履歴があります');put(out,keyOf(id),doc.record);}
      for(const spec of specs.values())assert(out[keyOf(spec.id)],'METADATA_ENVELOPE','表示中の図面に設定履歴がありません');
      const full=copy(out);for(const drawing of [...input.drawings,...envelope.retainedDrawings])for(const bucket of ['shapes','collabDeletedRecords'])for(const record of drawing.state[bucket]||[])put(full,D.keyOf(drawing.meta.id,record.id),C.upgrade(record));
      const projected=await project({records:full,template:input});
      assert(C.equal(shared(input),shared(projected)),'METADATA_UNTRACKED','設定の表示に履歴へ入っていない変更があります');
      return out;
    }
    for(const spec of specs.values())put(out,keyOf(spec.id),await seedDocument(spec));return out;
  }
  function regularByDrawing(records,template){
    const out=new Map(),prior=new Map();for(const drawing of [...(template?.drawings||[]),...(template?.project?.[ENVELOPE]?.retainedDrawings||[])]){
      for(const bucket of ['shapes','collabDeletedRecords'])for(const record of drawing.state?.[bucket]||[])prior.set(D.keyOf(drawing.meta.id,record.id),record);
    }
    const ordered=[...prior.keys()].filter(key=>own(records,key));ordered.push(...Object.keys(records).filter(key=>!prior.has(key)).sort((a,b)=>{
      const x=JSON.parse(a),y=JSON.parse(b);return cmp(x[0],y[0])||cmp(x[1],y[1]);
    }));
    for(const key of ordered){let pair;try{pair=JSON.parse(key);}catch{}
      assert(Array.isArray(pair)&&pair.length===2&&pair.every(validId)&&D.keyOf(...pair)===key&&records[key]?.id===pair[1],'METADATA_RECORD','記録の識別情報が不正です');if(pair[0]===NS)continue;
      const record=C.upgrade(records[key]),old=prior.get(key);for(const photo of record.photos||[]){const cache=old?.photos?.find(p=>p.id===photo.id);if(cache){const metadata=clean(cache,['data','localBlob']);if(C.equal(metadata,photo))for(const k of ['data','localBlob'])if(own(cache,k))photo[k]=copy(cache[k]);}}
      if(!out.has(pair[0]))out.set(pair[0],[]);out.get(pair[0]).push(record);
    }return out;
  }
  async function project({records,template,localProjectId}={}){
    assert(object(records),'METADATA_RECORD','設定の保存内容がありません');const metadata=metadataRecords(records),docs=new Map(),conflicts=[];
    for(const [id,record]of Object.entries(metadata)){const doc=await materializeDocument(record);docs.set(id,doc);conflicts.push(...doc.conflicts);}
    const header=docs.get('project');assert(header&&header.kind==='project'&&!header.deleted&&!header.pendingDelete,'METADATA_PROJECT','案件の設定を確認できません');
    localProjectId=localProjectId||template?.project?.id||header.identity.localProjectId;
    assert([...docs.values()].every(doc=>doc.identity.localProjectId===localProjectId),'METADATA_IDENTITY','別案件の設定が混在しています');
    const prior=new Map([...(template?.drawings||[]),...(template?.project?.[ENVELOPE]?.retainedDrawings||[])].map(d=>[d.meta.id,d]));
    const rows=regularByDrawing(records,template),drawings=[],retainedDrawings=[];
    const order=[...docs.values()].filter(doc=>doc.kind==='drawing').sort((a,b)=>(a.order-b.order)||cmp(a.identity.drawingId,b.identity.drawingId));
    const ids=new Set(order.map(doc=>doc.identity.drawingId));assert([...rows.keys()].every(id=>ids.has(id)),'METADATA_DRAWING_MISSING','記録に対応する図面の設定がありません');
    for(const doc of order){
      const id=doc.identity.drawingId,old=prior.get(id),meta={id,...copy(doc.meta)},state={};
      for(const k of META_OMIT)if(k!=='id'&&own(old?.meta||{},k))put(meta,k,copy(old.meta[k]));
      for(const k of VIEW)if(own(old?.state||{},k))put(state,k,copy(old.state[k]));for(const [k,value]of Object.entries(doc.state))put(state,k,copy(value));
      state.shapes=[];state.collabDeletedRecords=[];for(const record of rows.get(id)||[])state[C.isDeleted(record)?'collabDeletedRecords':'shapes'].push(record);
      const concurrentRecords=state.shapes.map(r=>r.id),pending=doc.pendingDelete||doc.deleted&&concurrentRecords.length>0;
      if(pending)conflicts.push({kind:'metadata-membership',recordId:await drawingRecordId(id),drawingId:id,path:[],headIds:heads(metadata[await drawingRecordId(id)].collab.deletion).map(r=>r.id),recordIds:concurrentRecords,
        expectedToken:C.revisionToken(metadata[await drawingRecordId(id)]),recordTokens:Object.fromEntries(state.shapes.map(r=>[r.id,C.revisionToken(r)]))});
      const drawing={meta,state};if(doc.deleted&&!pending)retainedDrawings.push(drawing);else drawings.push(drawing);
    }
    const project={id:localProjectId,...copy(header.project),collaborationVersion:1,drawings:drawings.map(d=>copy(d.meta))};
    if(own(template?.project||{},'updatedAt'))project.updatedAt=copy(template.project.updatedAt);
    project[ENVELOPE]={version:VERSION,namespace:NS,records:copy(metadata),retainedDrawings:copy(retainedDrawings)};
    return {version:1,kind:'sentlog-app-project',localProjectId,project,drawings,metadataRecords:copy(metadata),metadataConflicts:conflicts,source:'delta-replica-projection',readyForActivation:false};
  }
  function lineage(before,current){const merged=C.mergeRecords(before,current);assert(merged.ok&&C.equal(merged.record.collab,current.collab),'METADATA_HISTORY','編集開始時点の設定履歴が保存先にありません');}
  async function appendNode(record,key,node,parents,options){
    const out=copy(record),id=await stableId('edit',[options.operationId,record.id,key]),entry=out.collab.fields[key];
    const revision={id,parents:[...new Set(parents)].sort(cmp),value:copy(node),actor:copy(options.actor),at:options.at};
    const existing=entry.revisions.find(r=>r.id===id);if(existing){assert(C.equal(existing,revision),'METADATA_OPERATION_COLLISION','同じ設定操作に異なる内容があります');return C.upgrade(out);}
    entry.revisions.push(revision);return C.upgrade(out);
  }
  async function ensureNode(record,path){const key=await fieldKey(path);if(own(record.collab.fields,key))return record;
    const out=copy(record);put(out.collab.fields,key,{revisions:[{id:await stableId('absent',[record.id,key]),parents:[],value:absent(path),actor:{deviceId:null,deviceName:'不明'},at:0}]});return C.upgrade(out);
  }
  function matchingParents(entry,node){const rows=entry.revisions.filter(r=>C.equal(semantic(r.value),semantic(node)));return maximal(entry,rows).map(r=>r.id);}
  async function missingParents(record,path,oldNodes){
    const key=await fieldKey(path),entry=record.collab.fields[key];
    for(let length=path.length-1;length>0;length--){
      const parent=path.slice(0,length),prior=oldNodes.get(pathKey(parent));if(prior?.type==='object')continue;
      const parentEntry=record.collab.fields[await fieldKey(parent)];if(!parentEntry)continue;
      const matching=matchingParents(parentEntry,prior),observed=new Set(parentEntry.revisions.filter(r=>matching.includes(r.id)).flatMap(r=>r.value.observed||[]));
      const known=maximal(entry,entry.revisions.filter(r=>observed.has(r.id))).map(r=>r.id);if(known.length)return known;
    }return [];
  }
  async function edit({before,after,beforeRecords,inferProvenance=false,legacyMerge=false,currentRecords,operationId,actor,at=Date.now(),operation='edit'}={}){
    normalize(before);normalize(after);assert(before.project.id===after.project.id&&validId(operationId)&&object(actor)&&validId(actor.deviceId)&&typeof actor.deviceName==='string'&&Number.isFinite(at)&&at>=0,'METADATA_EDIT','設定操作の識別情報が不正です');
    const oldSpecs=await documentSpecs(before),nextSpecs=await documentSpecs(after),current=metadataRecords(currentRecords),changes=[],conflicts=[];
    const provenance=inferProvenance?null:beforeRecords?metadataRecords(Object.keys(beforeRecords).some(k=>k.startsWith('['))?beforeRecords:expandRecords(beforeRecords)):before.project[ENVELOPE]?.records;
    for(const id of [...new Set([...oldSpecs.keys(),...nextSpecs.keys()])].sort(cmp)){
      const old=oldSpecs.get(id),next=nextSpecs.get(id),base=current[id]||null;let value=base?copy(base):null;
      if(!old&&!next)continue;
      const creationId=!old&&next?await stableId('edit',[operationId,id,'@create']):null;
      const repeatedCreation=creationId&&base?.collab.deletion.revisions.some(r=>r.id===creationId);
      if(!base){assert(!old,'METADATA_BASE_MISSING','編集前の図面設定が保存先にありません');value=await seedDocument(next);value=C.restore(value,{expectedToken:C.revisionToken(value),actor,at,revisionId:creationId});}
      else {const doc=await validateDocument(base);assert(doc.identity.localProjectId===before.project.id&&C.equal(doc.identity,(next||old).identity),'METADATA_IDENTITY','編集する設定の所有元が一致しません');}
      const observed=provenance?.[id];if(observed)lineage(await validateDocument(observed).then(x=>x.record),base);
      if(repeatedCreation){
        // The first create event carries its complete deterministic seed plus
        // this operation's alive revision. Replaying it must not author a new
        // edit over peer changes received after that creation.
        lineage(await seedDocument(next),base);
      }else if(!next){
        if(operation==='restore')continue;
        assert(id!=='project','METADATA_PROJECT','案件そのものの削除は設定編集で実行できません');
        const deletionId=await stableId('edit',[operationId,id,'@deletion']);
        const existing=value.collab.deletion.revisions.find(r=>r.id===deletionId);
        let parents,seen=[];
        if(existing){parents=existing.parents;seen=existing.observed;}
        else if(observed){parents=heads(observed.collab.deletion).map(r=>r.id);seen=Object.values(observed.collab.fields).flatMap(e=>e.revisions.map(r=>r.id));}
        else {
          parents=maximal(value.collab.deletion,value.collab.deletion.revisions.filter(r=>r.deleted===false)).map(r=>r.id);
          for(const node of old.nodes.values()){const key=await fieldKey(node.path),entry=value.collab.fields[key],matched=entry&&matchingParents(entry,node);assert(matched?.length,'METADATA_BASE_MISSING','削除前の図面設定が保存先にありません');for(const id of matched)seen.push(...ancestors(entry,id));}
          for(const key of ['geometry','metaIdentity'])seen.push(...value.collab.fields[key].revisions.map(r=>r.id));
        }
        assert(parents.length,'METADATA_BASE_MISSING','削除前の図面の所属状態がありません');
        const revision={id:deletionId,parents:[...parents].sort(cmp),deleted:true,observed:[...new Set(seen)].sort(cmp),actor:copy(actor),at};
        if(existing)assert(C.equal(existing,revision),'METADATA_OPERATION_COLLISION','同じ図面の削除操作に異なる内容があります');else value.collab.deletion.revisions.push(revision);
        value=C.upgrade(value);
      }else if(base){
        if(C.isDeleted(value)&&!old){value=C.restore(value,{expectedToken:C.revisionToken(value),actor,at,revisionId:await stableId('edit',[operationId,id,'@restore'])});}
        const oldNodes=old?.nodes||new Map(),nextNodes=next.nodes;
        const changed=[...new Set([...oldNodes.keys(),...nextNodes.keys()])].filter(key=>!C.equal(semantic(oldNodes.get(key)),semantic(nextNodes.get(key))));
        for(const pathId of changed){
          const a=oldNodes.get(pathId),b=nextNodes.get(pathId),path=(b||a).path;
          // A removed/replaced object retains its descendants in history. One
          // parent revision records exactly which descendant heads were seen.
          if(!b&&changed.some(other=>other!==pathId&&descendant(path,(oldNodes.get(other)||nextNodes.get(other)).path)&&nextNodes.get(other)?.type!=='object'))continue;
          if(operation==='restore'&&!b)continue;
          value=await ensureNode(value,path);const key=await fieldKey(path),entry=value.collab.fields[key],known=observed?.collab.fields[key];
          const exact=known?C.view(observed).fields[key]:null;
          const hidden=!a?await missingParents(value,path,oldNodes):[];
          if(exact?.conflict&&!hidden.length)throw problem('METADATA_RESOLUTION_REQUIRED','この設定には複数の候補があります。採用する内容を選んでください');
          if(exact&&!hidden.length)assert(C.equal(semantic(exact.unset?null:exact.value),semantic(a)),'METADATA_UNTRACKED','編集開始時点の設定表示と履歴が一致しません');
          const revisionId=await stableId('edit',[operationId,id,key]);
          const priorRevision=entry.revisions.find(r=>r.id===revisionId);
          let parents=priorRevision?priorRevision.parents:legacyMerge&&a?[]:operation==='restore'?heads(entry).map(r=>r.id):hidden.length?hidden:known?heads(known).map(r=>r.id):matchingParents(entry,a);
          assert(parents.length>0||legacyMerge&&a,'METADATA_BASE_MISSING','編集開始時点の設定を履歴から確認できません');
          const node=copy(b||absent(path));
          if(node.type!=='object'){
            const descendantIds=[];
            for(const [childKey,childEntry]of Object.entries(value.collab.fields)){
              const childPath=childEntry.revisions[0]?.value?.path;if(!childPath||!descendant(childPath,path))continue;
              const childKnown=observed?.collab.fields[childKey],oldChild=oldNodes.get(pathKey(childPath));
              const matched=legacyMerge?[]:operation==='restore'?heads(childEntry).map(r=>r.id):childKnown?heads(childKnown).map(r=>r.id):matchingParents(childEntry,oldChild);
              descendantIds.push(...matched);
            }
            if(descendantIds.length||node.type==='absent')node.observed=[...new Set(descendantIds)].sort(cmp);
          }
          // The persisted revision is the source of truth on WAL replay. Its
          // observation proof must not expand to include subsequently received edits.
          if(priorRevision)node.observed=copy(priorRevision.value.observed);
          if(node.observed===undefined)delete node.observed;
          value=await appendNode(value,key,node,parents,{operationId,actor,at});
        }
      }
      await validateDocument(value);
      if(!base||!C.equal(base.collab,value.collab))changes.push({drawingId:NS,before:base?copy(base):null,after:value,eventId:await stableId('event',[operationId,id])});
      current[id]=value;conflicts.push(...(await materializeDocument(value)).conflicts);
    }
    return {changes,records:expandRecords(current),metadataRecords:current,conflicts};
  }
  async function resolve({records,recordId,path,expectedHeads,value,absent:remove=false,actor,at=Date.now(),operationId}={}){
    assert(validId(operationId)&&object(actor)&&validId(actor.deviceId)&&Array.isArray(path)&&path.length>0,'METADATA_RESOLUTION','設定の確認操作が不正です');
    const base=records[keyOf(recordId)]||records[recordId];assert(base,'METADATA_RECORD','設定の履歴が見つかりません');const doc=await validateDocument(base),key=await fieldKey(path),entry=base.collab.fields[key];
    assert(entry&&Array.isArray(expectedHeads)&&C.equal([...expectedHeads].sort(cmp),heads(entry).map(r=>r.id)),'METADATA_STALE','確認中に設定が更新されました。最新の候補を確認してください');
    let after=copy(base);const nodes=remove?new Map([[pathKey(path),absent(path)]]):flatten(value,path);
    if(!remove&&object(value))for(const child of [...doc.nodes.values()].sort((a,b)=>a.path.length-b.path.length))if(descendant(child.path,path)&&!nodes.has(pathKey(child.path))&&
      ![...nodes.values()].some(parent=>parent.type!=='object'&&descendant(child.path,parent.path)))nodes.set(pathKey(child.path),absent(child.path));
    for(const node of nodes.values()){
      after=await ensureNode(after,node.path);const field=await fieldKey(node.path),current=after.collab.fields[field];
      if(node.type!=='object')node.observed=[...doc.nodes.values()].filter(child=>descendant(child.path,node.path)).flatMap(child=>heads(child.entry).map(r=>r.id)).sort(cmp);
      after=await appendNode(after,field,node,heads(current).map(r=>r.id),{operationId,actor,at});
    }
    await validateDocument(after);return {changes:C.equal(base.collab,after.collab)?[]:[{drawingId:NS,before:copy(base),after,eventId:await stableId('event',[operationId,recordId])}],record:after,conflicts:(await materializeDocument(after)).conflicts};
  }
  async function resolveMembership({records,recordId,keep,expectedToken,expectedRecordTokens={},actor,at=Date.now(),operationId}={}){
    assert(validId(operationId)&&typeof keep==='boolean'&&object(actor)&&validId(actor.deviceId),'METADATA_RESOLUTION','図面の確認操作が不正です');
    const base=records[keyOf(recordId)];assert(base,'METADATA_RECORD','図面の履歴がありません');const doc=await validateDocument(base);
    assert(doc.identity.kind==='drawing'&&C.revisionToken(base)===expectedToken,'METADATA_STALE','確認中に図面設定が更新されました');
    const live=Object.entries(records).filter(([key,r])=>{const parts=JSON.parse(key);return parts[0]===doc.identity.drawingId&&!C.isDeleted(r);});
    if(!keep)assert(C.equal(Object.fromEntries(live.map(([,r])=>[r.id,C.revisionToken(r)])),expectedRecordTokens),'METADATA_STALE','確認中に図面の記録が更新されました');
    const revisionId=await stableId('edit',[operationId,recordId,'@membership']),after=(keep?C.restore:C.markDeleted)(base,{expectedToken,actor,at,revisionId});
    const changes=[{drawingId:NS,before:copy(base),after,eventId:await stableId('event',[operationId,recordId])}];
    if(!keep)for(const [,record]of live){const revisionId=await stableId('edit',[operationId,doc.identity.drawingId,record.id,'@deletion']);changes.push({drawingId:doc.identity.drawingId,before:copy(record),after:C.markDeleted(record,{expectedToken:C.revisionToken(record),actor,at,revisionId}),eventId:await stableId('event',[operationId,doc.identity.drawingId,record.id])});}
    return {changes,record:after,conflicts:(await materializeDocument(after)).conflicts};
  }
  const api={version:VERSION,namespace:NS,envelopeKey:ENVELOPE,viewFields:[...VIEW],pathKey,fieldKey,drawingRecordId,seed,seedDocument,documentSpecs,shared,validateEnvelope,validateDocument,materializeDocument,metadataRecords,expandRecords,project,edit,resolve,resolveMembership};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaMetadata=api;
})(typeof window!=='undefined'?window:globalThis);

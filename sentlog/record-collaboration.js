/* Immutable record revisions. Logical order arranges comments; clocks never choose a write. */
(function(root){
  'use strict';
  const VERSION=1;
  const GEOMETRY_KEYS=['kind','recordKind','recordType','memoType','page','point','points','x','y','w','h','width','height','angle','rotation','radius','rx','ry','unit'];
  const DERIVED=['globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'];
  const OMIT=new Set(['id','memo','photos','collab',...DERIVED,...GEOMETRY_KEYS]);
  const UNKNOWN={deviceId:null,deviceName:'不明'};
  const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,writable:true,enumerable:true,configurable:true});
  // Locale-independent ordering shared with PostgreSQL UTF-8 COLLATE "C".
  // Walk code points so supplementary characters also compare identically.
  function compareIds(a,b){
    let i=0,j=0;
    while(i<a.length&&j<b.length){const x=a.codePointAt(i),y=b.codePointAt(j);if(x!==y)return x-y;i+=x>0xffff?2:1;j+=y>0xffff?2:1;}
    return i<a.length?1:j<b.length?-1:0;
  }
  function canonical(v){
    if(Array.isArray(v))return v.map(canonical);
    return object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  }
  const stable=v=>JSON.stringify(canonical(v));
  const equal=(a,b)=>stable(a)===stable(b);
  function error(code,message){const e=Error(message);e.code=code;return e;}
  function fail(message){throw error('COLLAB_INVALID',message);}
  function validId(id){return typeof id==='string'&&id.length>0&&id.length<=512;}
  // Deterministic legacy identities are not authorization tokens. An identity
  // collision is still detected by immutable-payload comparison before merge.
  function digest(value){
    const input=stable(value);let a=2166136261,b=2246822519,c=3266489917,d=668265263;
    for(let i=0;i<input.length;i++){const n=input.charCodeAt(i);a=Math.imul(a^n,16777619);b=Math.imul(b^n,3266489917);c=Math.imul(c^n,668265263);d=Math.imul(d^n,374761393);}
    return [a,b,c,d].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
  }
  const legacyId=(recordId,kind,key,value)=>'legacy:'+kind+':'+digest([recordId,key,value]);
  function actor(value){return {deviceId:typeof value?.deviceId==='string'&&value.deviceId?value.deviceId:null,deviceName:String(value?.deviceName||'不明')};}
  function time(value){return Number.isFinite(value)&&value>=0?value:0;}
  function context(options={}){
    return {actor:actor(options.actor),at:options.at===undefined?Date.now():time(options.at),
      id(kind,key,value){
        const id=options.deterministic?legacyId(options.recordId,kind,key,value):
          (options.idFactory?options.idFactory():root.crypto?.randomUUID?.());
        if(!validId(id))throw error('COLLAB_ID_REQUIRED','変更を識別するIDを作成できません');return id;
      }};
  }
  function cleanPhoto(photo){
    if(!object(photo)||!validId(photo.id))fail('写真IDを確認できません');
    const value=clone(photo);delete value.localBlob;delete value.data;return value;
  }
  function rawFields(record){
    const out={geometry:Object.fromEntries(GEOMETRY_KEYS.filter(k=>own(record,k)).map(k=>[k,clone(record[k])]))};
    for(const key of Object.keys(record))if(!OMIT.has(key))put(out,key,clone(record[key]));
    return out;
  }
  function empty(){return {version:VERSION,comments:{},fields:{},photos:{},deletion:{revisions:[]},projection:{memo:''}};}
  function rootRevision(recordId,kind,key,payload){return {id:legacyId(recordId,kind,key,payload),parents:[],...clone(payload),actor:clone(UNKNOWN),at:0};}
  function seed(record){
    const c=empty();
    for(const [key,value] of Object.entries(rawFields(record)))put(c.fields,key,{revisions:[rootRevision(record.id,'field',key,{value})]});
    const memo=String(record.memo??'');
    if(memo){const id=legacyId(record.id,'comment',memo,memo);put(c.comments,id,{order:0,revisions:[rootRevision(record.id,'comment',id,{text:memo,deleted:false})]});}
    for(const photo of record.photos||[]){const value=cleanPhoto(photo);if(own(c.photos,value.id))fail('写真IDが重複しています');put(c.photos,value.id,{revisions:[rootRevision(record.id,'photo',value.id,{value,deleted:false})]});}
    c.deletion.revisions=[rootRevision(record.id,'deletion','record',{deleted:false,observed:[]})];
    return c;
  }
  function entries(c){
    const out=[];
    for(const [kind,map] of [['comment',c.comments],['field',c.fields],['photo',c.photos]])
      for(const [key,entry] of Object.entries(map))out.push({kind,key,entry});
    out.push({kind:'deletion',key:'record',entry:c.deletion});return out;
  }
  function validate(c){
    if(!object(c)||c.version!==VERSION)throw error('COLLAB_VERSION','共同編集データの版を確認してください');
    for(const key of ['comments','fields','photos'])if(!object(c[key]))fail('共同編集の一覧が不正です');
    const globalIds=new Set();
    for(const {kind,key,entry} of entries(c)){
      if(!validId(key)||!object(entry)||!Array.isArray(entry.revisions)||!entry.revisions.length)fail('変更履歴を確認できません');
      if(kind==='comment'&&(!Number.isSafeInteger(entry.order)||entry.order<0))fail('コメントの順序を確認できません');
      if(kind==='field'&&OMIT.has(key))fail('項目名が共同編集の管理情報と重なっています');
      const map=new Map();
      for(const r of entry.revisions){
        if(!object(r)||!validId(r.id)||globalIds.has(r.id)||!Array.isArray(r.parents)||new Set(r.parents).size!==r.parents.length||r.parents.some(p=>!validId(p)))fail('変更IDが不正または重複しています');
        if(!object(r.actor)||!(r.actor.deviceId===null||typeof r.actor.deviceId==='string')||typeof r.actor.deviceName!=='string'||!Number.isFinite(r.at)||r.at<0)fail('変更元を確認できません');
        if(kind==='comment'&&(typeof r.text!=='string'||typeof r.deleted!=='boolean'))fail('コメント履歴が不正です');
        if(kind==='field'&&!(r.unset===true||own(r,'value')))fail('項目の値がありません');
        if(kind==='field'&&key==='geometry'&&!r.unset&&(!object(r.value)||Object.keys(r.value).some(k=>!GEOMETRY_KEYS.includes(k))))fail('記録の位置・形状を確認できません');
        if(kind==='photo'&&(!object(r.value)||r.value.id!==key||typeof r.deleted!=='boolean'))fail('写真履歴が不正です');
        if(kind==='deletion'&&(typeof r.deleted!=='boolean'||!Array.isArray(r.observed)||r.observed.some(id=>!validId(id))))fail('削除確認の履歴が不正です');
        globalIds.add(r.id);map.set(r.id,r);
      }
      const visiting=new Set(),done=new Set();
      function visit(id){if(done.has(id))return;if(visiting.has(id))fail('変更履歴が循環しています');const r=map.get(id);if(!r)fail('変更前の履歴が不足しています');visiting.add(id);for(const p of r.parents)visit(p);visiting.delete(id);done.add(id);}
      for(const id of map.keys())visit(id);
    }
    return c;
  }
  function normalize(c){
    const out=clone(c);validate(out);
    // Revision payloads are immutable, including their existing parent and
    // observed-array order. Reordering those arrays would invalidate retries
    // captured by older collaboration/1 clients with UTF-16 canonical ordering.
    for(const {entry} of entries(out))entry.revisions.sort((a,b)=>compareIds(a.id,b.id));
    return canonical(out);
  }
  function heads(entry){
    const parents=new Set(entry.revisions.flatMap(r=>r.parents));return entry.revisions.filter(r=>!parents.has(r.id)).sort((a,b)=>compareIds(a.id,b.id));
  }
  function common(entry,leaves){
    const map=new Map(entry.revisions.map(r=>[r.id,r]));
    function ancestors(id){const seen=new Set(),todo=[id];while(todo.length){const next=todo.pop();if(seen.has(next))continue;seen.add(next);todo.push(...map.get(next).parents);}return seen;}
    const sets=leaves.map(r=>ancestors(r.id));let shared=[...sets[0]].filter(id=>sets.every(s=>s.has(id)));
    shared=shared.filter(id=>!shared.some(other=>id!==other&&ancestors(other).has(id)));
    return shared.map(id=>map.get(id)).sort((a,b)=>compareIds(a.id,b.id));
  }
  const fieldValue=r=>r?.unset?{unset:true}:{value:r?.value};
  const commentValue=r=>({text:r.text,deleted:r.deleted});
  const photoValue=r=>({value:r.value,deleted:r.deleted});
  function register(entry,valueOf){
    const leaves=heads(entry),conflict=leaves.some(r=>!equal(valueOf(r),valueOf(leaves[0]))),agreed=conflict?common(entry,leaves):leaves;
    const selected=agreed.length&&agreed.every(r=>equal(valueOf(r),valueOf(agreed[0])))?agreed[0]:null;
    return {heads:clone(leaves),headIds:leaves.map(r=>r.id),conflict,commonHeadIds:agreed.map(r=>r.id),selected};
  }
  function token(c){return digest(entries(c).map(({kind,key,entry})=>[kind,key,entry.revisions]).sort((a,b)=>compareIds(stable(a),stable(b))));}
  function summarize(c){
    const comments=[],fields={},photos=[],conflicts=[];
    for(const [id,entry] of Object.entries(c.comments)){
      const r=register(entry,commentValue),deleted=r.heads.every(h=>h.deleted),visible=r.heads.filter(h=>!h.deleted);
      const row={id,text:[...new Set(visible.map(h=>h.text))].join('\n\n'),order:entry.order,headIds:r.headIds,heads:r.heads,deleted,conflict:r.conflict,createdAt:Math.min(...entry.revisions.map(h=>h.at))};
      comments.push(row);if(r.conflict)conflicts.push({kind:'comment',id,headIds:r.headIds,candidates:r.heads});
    }
    comments.sort((a,b)=>a.order-b.order||compareIds(a.id,b.id));
    for(const [key,entry] of Object.entries(c.fields)){
      const r=register(entry,fieldValue),unset=!r.selected||r.selected.unset===true;
      put(fields,key,{key,value:unset?undefined:clone(r.selected.value),unset,headIds:r.headIds,heads:r.heads,conflict:r.conflict,commonHeadIds:r.commonHeadIds});
      if(r.conflict)conflicts.push({kind:'field',key,headIds:r.headIds,candidates:r.heads});
    }
    for(const [id,entry] of Object.entries(c.photos)){
      const r=register(entry,photoValue),deleted=r.heads.every(h=>h.deleted);
      let metadata=r.selected&&!r.selected.deleted?clone(r.selected.value):null;
      if(!deleted&&!metadata){const visible=r.heads.filter(h=>!h.deleted);if(visible.length&&visible.every(h=>equal(h.value,visible[0].value)))metadata=clone(visible[0].value);}
      photos.push({id,metadata,headIds:r.headIds,heads:r.heads,deleted,conflict:r.conflict});
      if(r.conflict)conflicts.push({kind:'photo',id,headIds:r.headIds,candidates:r.heads});
    }
    photos.sort((a,b)=>compareIds(a.id,b.id));
    const decisions=heads(c.deletion),liveHeads=entries(c).filter(x=>x.kind!=='deletion').flatMap(x=>heads(x.entry).map(r=>r.id));
    const hasDelete=decisions.some(r=>r.deleted),deleted=hasDelete&&decisions.every(r=>r.deleted&&liveHeads.every(id=>r.observed.includes(id)));
    const pendingDelete=hasDelete&&!deleted;
    if(pendingDelete)conflicts.push({kind:'deletion',id:'record',headIds:decisions.map(r=>r.id),candidates:clone(decisions)});
    return {comments,fields,photos,conflicts,deleted,pendingDelete,token:token(c)};
  }
  function materialize(template,collab){
    const c=normalize(collab),v=summarize(c),out={id:template.id};
    for(const k of DERIVED)if(own(template,k))put(out,k,clone(template[k]));
    for(const [key,field] of Object.entries(v.fields))if(!field.unset){
      if(key==='geometry'){for(const [k,value] of Object.entries(field.value||{}))put(out,k,clone(value));}
      else put(out,key,clone(field.value));
    }
    out.memo=v.comments.filter(x=>!x.deleted).map(x=>x.text).join('\n\n');
    out.photos=v.photos.filter(x=>!x.deleted).map(x=>x.metadata||{id:x.id,name:'写真（確認が必要）',collabConflict:true});
    c.projection={memo:out.memo};out.collab=c;return out;
  }
  function upgrade(record,options={}){
    if(!object(record)||!validId(record.id))fail('記録IDを確認できません');
    if(record.collab)return materialize(record,record.collab);
    if(options.base){
      if(options.base.id!==record.id)fail('変更前の記録IDが異なります');
      return applyLocalEdit(upgrade(options.base),record,{actor:UNKNOWN,at:0,deterministic:true,recordId:record.id});
    }
    return materialize(record,seed(record));
  }
  function view(record){return summarize(upgrade(record).collab);}
  // Old collaboration/1 clients sorted display lists with localeCompare.
  // This compatibility check accepts only that recomputable presentation;
  // an unrecorded field edit or arbitrary memo/cache still fails.
  function matchesProjection(record,{allowLegacyOrder=false}={}){
    if(!record?.collab)return false;
    try{
      const source=clone(record),expected=upgrade(record);delete source.collab;delete expected.collab;
      if(!own(source,'memo'))source.memo='';if(!own(source,'photos'))source.photos=[];
      if(equal(source,expected))return true;if(!allowLegacyOrder)return false;
      const sourceMemo=source.memo,sourcePhotos=source.photos,expectedMemo=expected.memo,expectedPhotos=expected.photos;
      delete source.memo;delete source.photos;delete expected.memo;delete expected.photos;
      if(!equal(source,expected))return false;
      const legacyPhotos=clone(expectedPhotos).sort((a,b)=>a.id.localeCompare(b.id));
      if(!equal(sourcePhotos,expectedPhotos)&&!equal(sourcePhotos,legacyPhotos))return false;
      if(sourceMemo===expectedMemo)return true;
      if(sourceMemo!==record.collab.projection?.memo)return false;
      const legacyMemo=view(record).comments.filter(row=>!row.deleted).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).map(row=>
        [...new Set(row.heads.filter(h=>!h.deleted).sort((a,b)=>a.id.localeCompare(b.id)).map(h=>h.text))].join('\n\n')).join('\n\n');
      return sourceMemo===legacyMemo;
    }catch{return false;}
  }
  function revisionToken(record){return view(record).token;}
  function isDeleted(record){return view(record).deleted;}
  function editable(record){const out=upgrade(record);if(summarize(out.collab).deleted)throw error('COLLAB_RECORD_DELETED','削除済みの記録です。変更内容は送信せず保持してください');return out;}
  function fieldEntry(c,key,recordId){
    if(!validId(key)||OMIT.has(key)||key==='memo'||key==='photos'||key==='collab')fail('共同編集する項目を確認できません');
    if(!own(c.fields,key))put(c.fields,key,{revisions:[rootRevision(recordId,'field',key,{unset:true})]});
    return c.fields[key];
  }
  function appendRevision(entry,payload,parents,options,ctx,kind,key){
    const id=options.revisionId||ctx.id(kind,key,[parents,payload]);if(!validId(id))fail('変更IDが不正です');
    const old=entry.revisions.find(r=>r.id===id);
    const r={id,parents:[...new Set(parents)].sort(),...clone(payload),actor:clone(ctx.actor),at:old&&options.at===undefined?old.at:ctx.at};
    if(old){if(!equal(old,r))throw error('COLLAB_REVISION_COLLISION','同じ変更IDに異なる内容があります。上書きを停止しました');return false;}
    entry.revisions.push(r);return true;
  }
  function checkHeads(entry,expected,allowConflict,valueOf){
    if(!Array.isArray(expected)||!equal([...new Set(expected)].sort(compareIds),heads(entry).map(r=>r.id)))throw error('COLLAB_STALE','確認中に別の変更が届きました。新しい内容を確認してください');
    if(!allowConflict&&register(entry,valueOf).conflict)throw error('COLLAB_CONFLICT','複数の変更候補があります。採用する内容を確認してください');
  }
  function appendComment(record,text,options={}){
    const out=editable(record),ctx=context({...options,recordId:record.id}),value=String(text??'');
    const id=options.commentId||ctx.id('comment',value,value);if(!validId(id))fail('コメントIDが不正です');
    if(!own(out.collab.comments,id))put(out.collab.comments,id,{order:Math.max(0,...Object.values(out.collab.comments).map(e=>e.order))+1,revisions:[]});
    const entry=out.collab.comments[id];
    if(entry.revisions.length&&!options.revisionId)throw error('COLLAB_COMMENT_EXISTS','既存コメントは編集操作で変更してください');
    appendRevision(entry,{text:value,deleted:false},[],options,ctx,'comment',id);return materialize(out,out.collab);
  }
  function changeComment(record,id,text,options={},resolve=false){
    const out=editable(record),entry=out.collab.comments[id];if(!entry)throw error('COLLAB_COMMENT_MISSING','コメントが見つかりません');
    const ctx=context(options),payload={text:String(text??''),deleted:options.deleted===true};
    const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
    if(!existing)checkHeads(entry,options.expectedHeads,resolve,commentValue);
    appendRevision(entry,payload,options.expectedHeads||[],options,ctx,'comment',id);return materialize(out,out.collab);
  }
  const editComment=(r,id,t,o)=>changeComment(r,id,t,o,false);
  const resolveComment=(r,id,t,o)=>changeComment(r,id,t,o,true);
  function removeComment(record,id,options={}){
    const row=view(record).comments.find(c=>c.id===id);if(!row)throw error('COLLAB_COMMENT_MISSING','コメントが見つかりません');
    const existing=options.revisionId&&record.collab?.comments[id]?.revisions.find(r=>r.id===options.revisionId);
    return changeComment(record,id,existing?existing.text:row.text,{...options,deleted:true},false);
  }
  function changeField(record,key,value,options={},resolve=false){
    const out=editable(record),entry=fieldEntry(out.collab,key,out.id),payload=options.unset?{unset:true}:{value:clone(value)};
    const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
    if(!existing)checkHeads(entry,options.expectedHeads,resolve,fieldValue);
    appendRevision(entry,payload,options.expectedHeads||[],options,context(options),'field',key);return materialize(out,out.collab);
  }
  const setField=(r,k,v,o)=>changeField(r,k,v,o,false);
  const resolveField=(r,k,v,o)=>changeField(r,k,v,o,true);
  function addPhoto(record,photo,options={}){
    const out=editable(record),value=cleanPhoto(photo);let entry=out.collab.photos[value.id];
    if(entry){
      const current=register(entry,photoValue);
      if(current.heads.every(r=>r.deleted))throw error('COLLAB_PHOTO_DELETED','削除済みの写真です。再追加は確認が必要です');
      const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
      if(!existing&&current.heads.every(r=>!r.deleted&&equal(r.value,value)))return out;
    }else{entry={revisions:[]};put(out.collab.photos,value.id,entry);}
    appendRevision(entry,{value,deleted:false},[],options,context(options),'photo',value.id);return materialize(out,out.collab);
  }
  function removePhoto(record,id,options={}){
    const out=editable(record),entry=out.collab.photos[id];if(!entry)throw error('COLLAB_PHOTO_MISSING','写真が見つかりません');
    const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
    if(!existing)checkHeads(entry,options.expectedHeads,false,photoValue);
    appendRevision(entry,{value:clone(existing?existing.value:heads(entry)[0].value),deleted:true},options.expectedHeads||[],options,context(options),'photo',id);return materialize(out,out.collab);
  }
  function restorePhoto(record,id,options={}){
    const out=editable(record),entry=out.collab.photos[id];if(!entry)throw error('COLLAB_PHOTO_MISSING','写真が見つかりません');
    const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
    if(!existing)checkHeads(entry,options.expectedHeads,false,photoValue);
    const value=cleanPhoto(options.metadata||existing?.value||heads(entry)[0].value);if(value.id!==id)fail('復元する写真のIDが異なります');
    appendRevision(entry,{value,deleted:false},options.expectedHeads||[],options,context(options),'photo',id);return materialize(out,out.collab);
  }
  function changeDeletion(record,deleted,options={}){
    const out=upgrade(record),c=out.collab,entry=c.deletion;
    const existing=options.revisionId&&entry.revisions.find(r=>r.id===options.revisionId);
    if(existing){if(existing.deleted!==deleted)throw error('COLLAB_REVISION_COLLISION','削除操作のIDが一致しません');return out;}
    if(options.expectedToken!==token(c))throw error('COLLAB_STALE','確認後に記録が更新されました。最新の内容で確認してください');
    const observed=entries(c).flatMap(x=>x.entry.revisions.map(r=>r.id)).sort();
    appendRevision(entry,{deleted,observed},heads(entry).map(r=>r.id),options,context(options),'deletion','record');return materialize(out,c);
  }
  const markDeleted=(r,o)=>changeDeletion(r,true,o);
  const restore=(r,o)=>changeDeletion(r,false,o);
  function union(collaborations){
    const out=empty();
    for(const c of collaborations){validate(c);for(const {kind,key,entry} of entries(c)){
      const map=kind==='comment'?out.comments:kind==='field'?out.fields:kind==='photo'?out.photos:null;
      const target=map?(own(map,key)?map[key]:put(map,key,{...(kind==='comment'?{order:entry.order}:{}),revisions:[]})[key]):out.deletion;
      if(kind==='comment'&&target.order!==entry.order)throw error('COLLAB_REVISION_COLLISION','コメントの作成順序が書き換えられています');
      const revisions=new Map(target.revisions.map(r=>[r.id,r]));
      for(const r of entry.revisions){if(revisions.has(r.id)&&!equal(revisions.get(r.id),r))throw error('COLLAB_REVISION_COLLISION','保存済みの変更履歴が書き換えられています');revisions.set(r.id,clone(r));}
      target.revisions=[...revisions.values()];
    }}
    return normalize(out);
  }
  function applyLocalEdit(before,after,options={}){
    if(!object(after)||!validId(after.id)||before&&before.id!==after.id)fail('編集中の記録IDが一致しません');
    if(!before){
      const plain={...clone(after),memo:'',photos:[]};delete plain.collab;let out=upgrade(plain);
      if(String(after.memo??''))out=appendComment(out,after.memo,options);
      for(const p of after.photos||[])out=addPhoto(out,p,options);
      return out;
    }
    const previous=upgrade(before),observed=after.collab?upgrade(after):previous;
    const c=union([previous.collab,observed.collab]),ctx=context({...options,recordId:after.id});
    if(summarize(c).deleted)throw error('COLLAB_RECORD_DELETED','削除済みの記録への変更は確認が必要です');
    const fields=rawFields(after),projected=rawFields(observed);
    for(const key of new Set([...Object.keys(fields),...Object.keys(projected)])){
      if(equal(fields[key],projected[key])&&own(fields,key)===own(projected,key))continue;
      const entry=fieldEntry(c,key,after.id),known=fieldEntry(observed.collab,key,after.id),payload=own(fields,key)?{value:fields[key]}:{unset:true};
      // A generic editor may finish after a remote update. Its observed parents
      // preserve that intent as an alternative rather than adopting unseen heads.
      appendRevision(entry,payload,heads(known).map(r=>r.id),{},ctx,'field',key);
    }
    let out=materialize(after,c);
    const memo=String(after.memo??'');
    // Normalizing an old client's raw textarea may finish while a live geometry
    // preview still carries the old projection. Do not import that same legacy
    // operation again when the preview subsequently persists. Explicit append
    // operations always keep their own comment IDs, even for identical text.
    const importedId=legacyId(after.id,'comment',memo,memo),imported=out.collab.comments[importedId];
    const alreadyImported=!own(observed.collab.comments,importedId)&&imported?.revisions.some(r=>!r.parents.length&&r.text===memo&&!r.deleted&&r.at===0&&r.actor.deviceId===null);
    if(memo!==observed.memo&&memo&&!alreadyImported)out=appendComment(out,memo,{...options,recordId:after.id});
    for(const raw of after.photos||[]){
      const value=cleanPhoto(raw),known=observed.collab.photos[value.id];
      if(!known){out=addPhoto(out,value,options);continue;}
      const r=register(known,photoValue);if(r.heads.some(h=>!h.deleted&&equal(h.value,value)))continue;
      const entry=out.collab.photos[value.id];
      appendRevision(entry,{value,deleted:false},r.headIds,{},ctx,'photo',value.id);out=materialize(out,out.collab);
    }
    return out;
  }
  function mergeRecords(local,remote,options={}){
    try{
      const base=options.base&&upgrade(options.base),records=[local,remote].filter(Boolean);
      const id=records[0]?.id||base?.id;if(!id||records.some(r=>r.id!==id)||base&&base.id!==id)fail('異なる記録を統合できません');
      const upgraded=records.map(r=>upgrade(r,{base}));if(base)upgraded.push(base);
      const collab=union(upgraded.map(r=>r.collab)),template=base||upgraded[0],record=materialize(template,collab);
      return {ok:true,record,conflicts:summarize(collab).conflicts};
    }catch(e){return {ok:false,reason:e.message,code:e.code||'COLLAB_INVALID',conflicts:[]};}
  }
  const api={VERSION,GEOMETRY_KEYS,compareIds,upgrade,view,matchesProjection,revisionToken,isDeleted,appendComment,editComment,resolveComment,removeComment,
    setField,resolveField,addPhoto,removePhoto,restorePhoto,markDeleted,restore,applyLocalEdit,mergeRecords,canonical,equal};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SentlogRecordCollaboration=api;
})(typeof window==='object'?window:globalThis);

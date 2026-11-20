/* Sentlog delta sync v1, experimental and NOT loaded by the production app.
 * Durable outbox + commit-ordered event replay. No file bytes or silent
 * latest-timestamp conflict resolution. Wire only after backend/RLS migration,
 * legacy-client guard, and end-to-end device tests are complete.
 */
(function(root){
  'use strict';
  const C=root.SentlogRecordCollaboration ||
    (typeof module==='object'&&module.exports?require('./record-collaboration.js'):null);
  if(!C)throw Error('共同編集モデルが見つかりません');
  const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,writable:true,enumerable:true,configurable:true});
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function assert(condition,code,message){if(!condition)throw problem(code,message);}
  const groups=['comments','fields','photos'];
  const keyOf=(drawingId,recordId)=>JSON.stringify([drawingId,recordId]);
  const scopeKeys=['ownerId','projectId','deviceId'];
  const identityKeys=['projectId','eventId','deviceId','drawingId','recordId'];
  const isGroup=entry=>entry?.kind==='atomic-group';
  const eventsOf=entry=>isGroup(entry)?entry.events:[entry];
  const emptyState=scope=>({version:2,scope:clone(scope),cursor:0,records:{},outbox:[]});
  function sameScope(a,b){return object(a)&&scopeKeys.every(k=>a[k]===b[k]);}
  function validateState(state,scope,deep=false){
    assert(state&&state.version===2&&sameScope(state.scope,scope),
      'DELTA_SCOPE','保存データの利用者・案件・端末が一致しません。元のデータを保持しました');
    assert(Number.isSafeInteger(state.cursor)&&state.cursor>=0,
      'DELTA_LOCAL_STATE','端末の同期位置を確認できません');
    assert(object(state.records)&&Array.isArray(state.outbox),
      'DELTA_LOCAL_STATE','端末の記録を確認できません');
    const ids=new Set(),groupIds=new Set();
    function checkEntry(entry){
      validateOutboxEntry(entry);
      assert(entry.projectId===scope.projectId&&entry.deviceId===scope.deviceId,
        'DELTA_SCOPE','別の案件・端末の未送信データは送信できません');
      if(isGroup(entry)){
        assert(!groupIds.has(entry.groupId),'DELTA_LOCAL_STATE','未送信の一括操作IDが重複しています');groupIds.add(entry.groupId);
      }
      for(const event of eventsOf(entry)){
        assert(!ids.has(event.eventId),'DELTA_LOCAL_STATE','未送信の変更IDが重複しています');ids.add(event.eventId);
      }
    }
    for(const e of state.outbox){
      checkEntry(e);
    }
    // Rejected changes stay durable but are not endlessly retransmitted.
    // Backward compatible with states saved before this optional array existed.
    if(own(state,'blockedOutbox')){
      assert(Array.isArray(state.blockedOutbox),'DELTA_LOCAL_STATE','確認待ちの履歴が不正です');
      for(const block of state.blockedOutbox){
        assert(object(block)&&object(block.reason)&&typeof block.reason.message==='string',
          'DELTA_LOCAL_STATE','確認待ちの理由が不正です');
        checkEntry(block.event);
      }
    }
    if(deep)for(const [key,record]of Object.entries(state.records)){
      let parts;try{parts=JSON.parse(key);}catch{}
      assert(Array.isArray(parts)&&parts.length===2&&parts.every(valid)&&record?.id===parts[1]&&
        keyOf(...parts)===key,'DELTA_LOCAL_STATE','保存された記録の識別情報が一致しません');
      C.upgrade(record);
    }
    return state;
  }
  function jsonValue(value,active=new Set(),depth=0){
    assert(depth<=64,'DELTA_EVENT','変更データの階層が深すぎます');
    if(value===null||typeof value==='boolean'||typeof value==='string')return;
    if(typeof value==='number'){assert(Number.isFinite(value),'DELTA_EVENT','数値が不正です');return;}
    assert(typeof value==='object'&&!active.has(value),'DELTA_EVENT','変更データは循環しないJSONである必要があります');
    assert(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,
      'DELTA_EVENT','ファイルや実行可能なオブジェクトを変更履歴には保存できません');
    active.add(value);for(const child of Object.values(value))jsonValue(child,active,depth+1);active.delete(value);
  }
  function photoMetadata(value,id){
    assert(object(value)&&valid(id)&&value.id===id,'DELTA_EVENT','写真の識別情報が一致しません');
    if(own(value,'sha256'))assert(typeof value.sha256==='string'&&/^[a-f0-9]{64}$/i.test(value.sha256),
      'DELTA_EVENT','写真の照合情報が不正です');
    if(own(value,'size'))assert(Number.isSafeInteger(value.size)&&value.size>=0,'DELTA_EVENT','写真サイズが不正です');
    function noBytes(v){
      if(typeof v==='string')assert(!/^data:/i.test(v),'DELTA_FILE_BYTES','写真本体は専用の転送経路で保存してください');
      if(v&&typeof v==='object')for(const [k,child]of Object.entries(v)){
        assert(!['data','localBlob','blob','bytes'].includes(k),'DELTA_FILE_BYTES','写真本体を変更履歴に含めることはできません');noBytes(child);
      }
    }
    noBytes(value);
  }
  function revisions(rows,kind,key,seen){
    assert(Array.isArray(rows),'DELTA_EVENT','変更履歴の形式が不正です');
    for(const r of rows){
      assert(object(r)&&valid(r.id)&&!seen.has(r.id)&&Array.isArray(r.parents)&&
        r.parents.every(valid)&&new Set(r.parents).size===r.parents.length,
        'DELTA_EVENT','変更IDまたは変更前の識別情報が不正です');
      seen.add(r.id);
      assert(object(r.actor)&&(r.actor.deviceId===null||typeof r.actor.deviceId==='string')&&
        typeof r.actor.deviceName==='string'&&Number.isFinite(r.at)&&r.at>=0,
        'DELTA_EVENT','変更元の情報が不正です');
      if(kind==='comments')assert(typeof r.text==='string'&&typeof r.deleted==='boolean','DELTA_EVENT','コメントの形式が不正です');
      if(kind==='fields'){
        if(own(r,'unset'))assert(typeof r.unset==='boolean','DELTA_EVENT','項目の削除状態が不正です');
        assert(r.unset===true||own(r,'value'),'DELTA_EVENT','変更する値がありません');
        if(key==='geometry'&&!r.unset)assert(object(r.value)&&Object.keys(r.value).every(k=>C.GEOMETRY_KEYS.includes(k)),
          'DELTA_EVENT','記録の位置・形状が不正です');
      }
      if(kind==='photos'){assert(typeof r.deleted==='boolean','DELTA_EVENT','写真の削除状態が不正です');photoMetadata(r.value,key);}
      if(kind==='deletion')assert(typeof r.deleted==='boolean'&&Array.isArray(r.observed)&&r.observed.every(valid),
        'DELTA_EVENT','削除の確認履歴が不正です');
    }
  }
  function validateEvent(e){
    jsonValue(e);
    assert(object(e)&&e.schema===1&&identityKeys.every(k=>valid(e[k])),
      'DELTA_EVENT','変更の識別情報が不正です');
    assert(['create','patch'].includes(e.kind),'DELTA_EVENT','変更の種類が不正です');
    // The same byte limit is enforced on UTF-8 JSON by the server. Its jsonb
    // representation can be a little larger; server rejection still keeps outbox.
    assert(new TextEncoder().encode(JSON.stringify(e)).byteLength<=256*1024,
      'DELTA_TOO_LARGE','変更が大きすぎます');
    const content=e.kind==='create'?e.record?.collab:e.patch;
    assert(object(content)&&groups.every(g=>object(content[g])),'DELTA_EVENT','差分の形式が不正です');
    const seen=new Set();
    for(const g of groups)for(const [id,entry]of Object.entries(content[g])){
      assert(valid(id)&&object(entry)&&Array.isArray(entry.revisions)&&entry.revisions.length,
        'DELTA_EVENT','変更履歴が不足しています');
      if(g==='comments')assert(Number.isSafeInteger(entry.order)&&entry.order>=0,'DELTA_EVENT','コメント順序が不正です');
      revisions(entry.revisions,g,id,seen);
    }
    const deletion=e.kind==='create'?content.deletion?.revisions:content.deletion;
    revisions(deletion,'deletion','record',seen);
    if(e.kind==='create'){
      assert(e.record&&e.record.id===e.recordId&&content.version===1&&deletion.length,
        'DELTA_EVENT','新規記録の共同編集履歴がありません');
      if(own(e.record,'photos'))assert(Array.isArray(e.record.photos),'DELTA_EVENT','写真の一覧が不正です');
      for(const p of e.record.photos||[])photoMetadata(p,p?.id);
      C.upgrade(e.record);
    }else assert(seen.size>0,'DELTA_EVENT','変更内容が空です');
    return e;
  }
  // PostgreSQL jsonb adds separator spaces and expands exponential numbers.
  // Bound groups using that wire representation, not shorter JS JSON alone.
  function pgNumber(value){
    const text=JSON.stringify(value);if(!/[eE]/.test(text))return text;
    const [,sign,whole,fraction='',power]=text.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    const digits=whole+fraction,at=whole.length+Number(power);
    return sign+(at<=0?'0.'+'0'.repeat(-at)+digits:at>=digits.length?digits+'0'.repeat(at-digits.length):digits.slice(0,at)+'.'+digits.slice(at));
  }
  function pgText(value){
    if(typeof value==='number')return pgNumber(value);
    if(Array.isArray(value))return '['+value.map(pgText).join(', ')+']';
    if(object(value))return '{'+Object.entries(value).map(([key,child])=>JSON.stringify(key)+': '+pgText(child)).join(', ')+'}';
    return JSON.stringify(value);
  }
  function validateGroup(group){
    jsonValue(group);
    assert(object(group)&&group.schema===1&&group.kind==='atomic-group'&&
      ['groupId','projectId','deviceId'].every(k=>valid(group[k]))&&Array.isArray(group.events)&&group.events.length>=1&&group.events.length<=500,
      'DELTA_GROUP','一括操作の識別情報または件数が不正です');
    assert(Object.keys(group).length===6&&Object.keys(group).every(k=>['schema','kind','groupId','projectId','deviceId','events'].includes(k)),
      'DELTA_GROUP','一括操作に未対応の情報があります');
    const ids=new Set();
    for(const event of group.events){
      validateEvent(event);
      assert(event.projectId===group.projectId&&event.deviceId===group.deviceId&&!ids.has(event.eventId),
        'DELTA_GROUP','一括操作に別案件・別端末または重複した変更があります');ids.add(event.eventId);
      assert(new TextEncoder().encode(pgText(event)).byteLength<=256*1024,'DELTA_TOO_LARGE','一括操作内の変更が大きすぎます');
    }
    assert(new TextEncoder().encode(pgText(group)).byteLength<=4*1024*1024,'DELTA_GROUP_TOO_LARGE','一括操作が一度に保存できる容量を超えています');
    return group;
  }
  function validateOutboxEntry(entry){return isGroup(entry)?validateGroup(entry):validateEvent(entry);}
  function removedOrChanged(before,after){
    const b=new Map((before||[]).map(r=>[r.id,r]));
    const now=new Map((after||[]).map(r=>[r.id,r]));
    for(const [id,revision] of b){
      assert(now.has(id)&&C.equal(now.get(id),revision),'DELTA_HISTORY_LOSS',
        '保存済みの変更履歴が書き換えられています');
    }
    return (after||[]).filter(r=>!b.has(r.id)).map(clone);
  }
  function diffRecord(before,after,context){
    if(before!==null&&before!==undefined)jsonValue(before);jsonValue(after);
    const {eventId,projectId,drawingId,deviceId}=context||{};
    const previous=before?C.upgrade(before):null;
    const next=C.upgrade(after);
    assert(!previous||previous.id===next.id,'DELTA_RECORD','別の記録を変更できません');
    const envelope={schema:1,eventId,projectId,drawingId,recordId:next.id,deviceId};
    if(!previous){
      const record=clone(next);
      // Incompatible older drafts can include raw cached bytes: strip them in
      // the canonical record via the immutable collaboration model first.
      return validateEvent({...envelope,kind:'create',record});
    }
    const changes={comments:{},fields:{},photos:{},deletion:[]};
    for(const g of groups){
      const old=previous.collab[g],now=next.collab[g];
      for(const [id,entry] of Object.entries(old)){
        assert(own(now,id),'DELTA_HISTORY_LOSS','既存の記録項目を削除できません');
        if(g==='comments')assert(now[id].order===entry.order,'DELTA_HISTORY_LOSS','コメント順序が変更されています');
      }
      for(const [id,entry] of Object.entries(now)){
        const added=removedOrChanged(own(old,id)?old[id].revisions:[],entry.revisions);
        if(added.length)put(changes[g],id,{...(g==='comments'?{order:entry.order}:{}),revisions:added});
      }
    }
    changes.deletion=removedOrChanged(previous.collab.deletion.revisions,next.collab.deletion.revisions);
    if(!changes.deletion.length&&groups.every(g=>!Object.keys(changes[g]).length))return null;
    return validateEvent({...envelope,kind:'patch',patch:changes});
  }
  function combine(current,event){
    validateEvent(event);
    if(event.kind==='create'){
      const candidate=C.upgrade(event.record);
      if(!current)return candidate;
      const joined=C.mergeRecords(current,candidate);
      assert(joined.ok,'DELTA_CONFLICT',joined.reason||'新規記録の照合に失敗しました');
      return joined.record;
    }
    assert(current,'DELTA_MISSING_BASE','元の記録を受信する必要があります');
    assert(current.id===event.recordId,'DELTA_RECORD','別の記録の変更を適用できません');
    const initial=C.upgrade(current),collab=clone(initial.collab);
    for(const g of groups){
      for(const [id,entry] of Object.entries(event.patch[g])){
        assert(entry&&Array.isArray(entry.revisions)&&entry.revisions.length>0,
          'DELTA_EVENT','変更履歴が不足しています');
        if(!own(collab[g],id))put(collab[g],id,{...(g==='comments'?{order:entry.order}:{}),revisions:[]});
        if(g==='comments')assert(collab[g][id].order===entry.order,
          'DELTA_CONFLICT','コメントの登録順序が一致しません');
        const existing=new Map(collab[g][id].revisions.map(rev=>[rev.id,rev]));
        for(const rev of entry.revisions){
          if(existing.has(rev.id))
            assert(C.equal(existing.get(rev.id),rev),'DELTA_COLLISION','同じ変更IDに異なる内容があります');
          else{collab[g][id].revisions.push(clone(rev));existing.set(rev.id,rev);}
        }
      }
    }
    const deleted=new Map(collab.deletion.revisions.map(r=>[r.id,r]));
    for(const revision of event.patch.deletion){
      if(deleted.has(revision.id))
        assert(C.equal(deleted.get(revision.id),revision),'DELTA_COLLISION','削除履歴が一致しません');
      else{collab.deletion.revisions.push(clone(revision));deleted.set(revision.id,revision);}
    }
    return C.upgrade({...initial,collab});
  }
  function createReplica({ownerId,projectId,deviceId,store,transport,onStatus=()=>{},onConflict=()=>{},
    pageLimit=100,reconcileIntervalMs=60000,requestTimeoutMs=15000,retryBaseMs=1000,retryMaxMs=30000,
    visible=()=>true,timers={setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)}}){
    const scope={ownerId,projectId,deviceId};
    assert(scopeKeys.every(k=>valid(scope[k]))&&store&&transport,'DELTA_CONFIG','接続設定が不正です');
    assert(typeof store.read==='function'&&typeof store.write==='function'&&
      typeof transport.push==='function'&&typeof transport.list==='function'&&
      typeof transport.online==='function','DELTA_CONFIG','保存・通信方法が不正です');
    if(typeof store.getScope==='function')assert(sameScope(store.getScope(),scope),'DELTA_SCOPE','端末保存先が別の利用者・案件です');
    assert(Number.isSafeInteger(pageLimit)&&pageLimit>=1&&pageLimit<=500&&
      Number.isSafeInteger(reconcileIntervalMs)&&reconcileIntervalMs>=0&&
      Number.isSafeInteger(requestTimeoutMs)&&requestTimeoutMs>0&&
      Number.isSafeInteger(retryBaseMs)&&retryBaseMs>0&&Number.isSafeInteger(retryMaxMs)&&retryMaxMs>=retryBaseMs,
      'DELTA_CONFIG','同期の取得件数・待機時間が不正です');
    let localChain=Promise.resolve(),state=null,started=false,closed=false,live=null,pump=null,requested=false;
    // Runtime-only identity for this exact durable snapshot. A stale UI status
    // must not certify a later edit or a different replica as fully synced.
    let snapshotToken=Object.freeze({});
    let wakeTimer=null,reconcileTimer=null,retryTimer=null,retries=0;
    const inflight=new Set();
    function active(){assert(!closed,'DELTA_CLOSED','この同期処理は終了しています');}
    function schedule(fn,ms){const timer=timers.setTimeout(fn,ms);timer?.unref?.();return timer;}
    function clear(name){if(name!==null)timers.clearTimeout(name);}
    function local(fn){
      const task=localChain.then(async()=>{active();await load();active();return fn();});
      localChain=task.catch(()=>{});return task;
    }
    async function load(){
      if(state)return;
      const recovered=await store.read();active();
      state=validateState(recovered===null||recovered===undefined?emptyState(scope):clone(recovered),scope,true);
    }
    async function persist(next){
      active();validateState(next,scope);
      // Adapter transaction must commit record + cursor + outbox atomically.
      // Network waits never own the local queue. CAS rejection is propagated;
      // stale whole-state writes must not be retried as an overwrite.
      await store.write(clone(next));active();state=next;snapshotToken=Object.freeze({});
    }
    function emit(fn,value){if(closed)return;try{fn(value);}catch{/* UI observers cannot undo a committed save. */}}
    function conflictCount(){return state?Object.values(state.records).reduce((n,r)=>n+C.view(r).conflicts.length,0):0;}
    function blockedCount(){return state?.blockedOutbox?.length||0;}
    function status(level,description){emit(onStatus,{scope:clone(scope),snapshotToken,level,message:description,pending:state?.outbox?.length||0,
      pendingEvents:state?.outbox?.reduce((n,e)=>n+eventsOf(e).length,0)||0,
      blocked:blockedCount(),cursor:state?.cursor||0,conflicts:conflictCount()});}
    function capabilities(){
      let confirmed=false;try{confirmed=transport.getCapabilities?.().atomicGroups===true;}catch{}
      return {atomicGroups:confirmed&&typeof transport.pushGroup==='function'};
    }
    function visibleConflicts(record){const conflicts=C.view(record).conflicts;
      if(conflicts.length)emit(onConflict,{projectId,recordId:record.id,conflicts:clone(conflicts)});
    }
    function connected(){return !closed&&transport.online();}
    function retryable(error){
      const code=Number(error?.status||error?.statusCode);
      if([400,401,403,404,409,422].includes(code)||['UPGRADE_REQUIRED','DELTA_UPGRADE_REQUIRED','DELTA_SCOPE','DELTA_STORE_STALE'].includes(error?.code))return false;
      if(error?.retryable===true)return true;
      return [408,425,429].includes(code)||(code>=500&&code<=599)||error?.code==='DELTA_TIMEOUT';
    }
    function permanentRecordReject(error){
      if([401,403].includes(Number(error?.status||error?.statusCode)))return false;
      const code=String(error?.code||''),message=String(error?.message||'');
      // Only explicit application-level record/revision validation errors may
      // be isolated. Network, auth, deployment and ambiguous errors stay queued.
      const semantic=/\bDELTA_(?:MISSING_BASE|UNKNOWN_PARENT|UNKNOWN_OBSERVED|HISTORY_CYCLE|REVISION_REWRITE|DELETION_REWRITE|RECORD_ALREADY_EXISTS|RECORD_GRAPH_INVALID|RECORD_HISTORY_MISSING|COMMENT_ORDER_CHANGED|DUPLICATE_REVISION_ID|REVISION_COLLISION_OR_INVALID|PARENTS_INVALID|PAYLOAD_INVALID|GROUP_INVALID|GROUP_COLLISION|GROUP_REWRITE|GROUP_TOO_LARGE|GROUP_SCOPE|GROUP_EVENT_DUPLICATE|GROUP_ID_COLLISION|GROUP_EVENT_ALREADY_ACCEPTED)\b/;
      return semantic.test(code)||((['22023','23505','54000'].includes(code)||Number(error?.status)===400)&&semantic.test(message));
    }
    const sameRecord=(a,b)=>a.drawingId===b.drawingId&&a.recordId===b.recordId;
    function retry(error){
      if(!started||closed||!retryable(error)||!connected()||!visible()||retryTimer!==null)return;
      const wait=Math.min(retryMaxMs,retryBaseMs*2**Math.min(retries++,20));
      retryTimer=schedule(()=>{retryTimer=null;wake();},wait);
    }
    function reconcile(){
      if(closed||!started||!reconcileIntervalMs||reconcileTimer!==null)return;
      reconcileTimer=schedule(()=>{reconcileTimer=null;if(connected()&&visible())wake();reconcile();},reconcileIntervalMs);
    }
    function request(fn){
      active();const controller=new AbortController();let rejectClose;
      const cancelled=new Promise((resolve,reject)=>{rejectClose=reject;});
      const ticket={cancel(){controller.abort();rejectClose(problem('DELTA_CLOSED','同期処理を終了しました'));}};
      inflight.add(ticket);let timeout;
      const deadline=new Promise((resolve,reject)=>{timeout=schedule(()=>{controller.abort();
        reject(problem('DELTA_TIMEOUT','通信が時間内に完了しませんでした。変更内容は保持しています'));},requestTimeoutMs);});
      return Promise.race([Promise.resolve().then(()=>{active();return fn(controller.signal);}),deadline,cancelled])
        .then(value=>{active();return value;}).finally(()=>{clear(timeout);inflight.delete(ticket);});
    }
    async function catchUp(){
      let applied=0;
      for(let page=0;page<10000;page++){
        if(!connected())return {offline:true,applied};
        const cursor=await local(()=>state.cursor);
        const rows=await request(signal=>transport.list(projectId,cursor,pageLimit,{signal}));
        assert(Array.isArray(rows)&&rows.length<=pageLimit,'DELTA_SERVER','変更一覧が不正です');
        assert((rows.hasMore===undefined||typeof rows.hasMore==='boolean')&&(rows.length>0||rows.hasMore!==true),
          'DELTA_SERVER','変更一覧の続きまたは終端を確認できません');
        if(!rows.length)return {applied,cursor};
        for(const row of rows)await local(async()=>{
          assert(row&&Number.isSafeInteger(row.seq)&&row.seq===state.cursor+1,
            'DELTA_SEQUENCE_GAP','未受信の変更があります。同期位置は進めません');
          const grouped=own(row,'group');let events,end;
          if(grouped){
            assert(!own(row,'event'),'DELTA_SERVER','一括操作と単独変更が混在しています');validateGroup(row.group);
            assert(row.group.projectId===projectId,'DELTA_FOREIGN','別案件の一括操作を受信しました');
            events=row.group.events;end=row.endSeq;
            assert(Number.isSafeInteger(end)&&end===row.seq+events.length-1,'DELTA_SEQUENCE_GAP','一括操作の連続した範囲を確認できません');
          }else{
            assert(!own(row,'endSeq')&&!own(row,'groupId'),'DELTA_SERVER','一括操作の一部だけを受信しました');
            assert(row.event?.projectId===projectId,'DELTA_FOREIGN','別案件の変更を受信しました');events=[row.event];end=row.seq;
          }
          const next=clone(state),changed=new Set();
          for(const event of events){const key=keyOf(event.drawingId,event.recordId);
            put(next.records,key,combine(own(next.records,key)?next.records[key]:null,event));changed.add(key);}
          // Validate the whole group before this single durable cursor/state
          // commit. No intermediate tombstone or destination reaches observers.
          next.cursor=end;await persist(next);for(const key of changed)visibleConflicts(next.records[key]);applied+=events.length;
        });
        if(rows.hasMore===false||(rows.length<pageLimit&&rows.hasMore!==true))return {applied,cursor:await local(()=>state.cursor)};
      }
      throw problem('DELTA_PAGE_LIMIT','変更履歴の件数が多いため、次回の同期に分割します');
    }
    async function flush(){
      let pushed=0;
      for(;;){
        if(!connected())return {offline:true,pushed};
        const event=await local(()=>clone(state.outbox[0]));if(!event)return {pushed};
        let ack;
        try{
          if(isGroup(event)){
            assert(capabilities().atomicGroups,'DELTA_UPGRADE_REQUIRED','一括同期の接続を再確認してください。操作全体を端末に保持しています');
            ack=await request(signal=>transport.pushGroup(clone(event),{signal}));
          }else ack=await request(signal=>transport.push(clone(event),{signal}));
        }
        catch(error){
          if(!permanentRecordReject(error))throw error;
          // A rejected create/update cannot be sent again as a later same-
          // record patch. Quarantine its entire dependency chain atomically;
          // unrelated records keep their normal durable FIFO send queue.
          await local(async()=>{
            const next=clone(state);
            assert(C.equal(next.outbox[0],event),'DELTA_LOCAL_STATE','送信待ちの記録が変更されています');
            const remaining=[],blockedRecords=new Set(eventsOf(event).map(e=>keyOf(e.drawingId,e.recordId)));
            next.blockedOutbox=next.blockedOutbox||[];
            for(const [index,queued]of next.outbox.entries()){
              const members=eventsOf(queued);
              if(members.some(e=>blockedRecords.has(keyOf(e.drawingId,e.recordId)))){
                for(const e of members)blockedRecords.add(keyOf(e.drawingId,e.recordId));
                const root=index===0;
                next.blockedOutbox.push({event:queued,reason:{
                  code:root?String(error.code||'DELTA_REJECTED'):'DELTA_DEPENDENT_BLOCKED',
                  message:root?'この記録の変更内容をサーバーが受け付けませんでした': '前の変更を確認するまで送信できません'
                }});
              }else remaining.push(queued);
            }
            next.outbox=remaining;
            await persist(next);
          });
          status('review','受け付けられない記録を確認待ちに保護し、ほかの記録の同期を続けます');
          continue;
        }
        if(isGroup(event)){
          assert(ack&&ack.schema===1&&['groupId','projectId','deviceId'].every(k=>ack[k]===event[k])&&typeof ack.duplicate==='boolean'&&
            Number.isSafeInteger(ack.startSeq)&&ack.startSeq>=1&&Number.isSafeInteger(ack.endSeq)&&ack.endSeq===ack.startSeq+event.events.length-1&&
            Array.isArray(ack.events)&&ack.events.length===event.events.length&&ack.events.every((entry,index)=>
              entry?.seq===ack.startSeq+index&&identityKeys.every(k=>entry[k]===event.events[index][k])),
            'DELTA_NOT_DURABLE','一括操作全体のサーバー保存を確認できません');
        }else assert(ack&&Number.isSafeInteger(ack.seq)&&ack.seq>=1&&identityKeys.every(k=>ack[k]===event[k]),
          'DELTA_NOT_DURABLE','この変更のサーバー保存を確認できません');
        await local(async()=>{
          const next=clone(state);
          assert(C.equal(next.outbox[0],event),'DELTA_LOCAL_STATE','未送信の記録が変更されました');
          next.outbox.shift();await persist(next);pushed+=eventsOf(event).length;
        });
      }
    }
    async function work(){
      await local(()=>{});
      if(!connected()){status('offline','圏外中の変更は端末に保管しています');return {offline:true,pending:state.outbox.length};}
      try{
        const sent=await flush(),received=await catchUp();
        retries=0;clear(retryTimer);retryTimer=null;
        if(sent.offline||received.offline||!connected()){
          status('offline','通信の復旧後に変更点の同期を再開します');return {offline:true,pending:state.outbox.length};
        }
        const conflicts=conflictCount(),blocked=blockedCount();
        status(blocked||conflicts?'review':state.outbox.length?'queued':'ok',
          blocked?'一部の記録は確認待ちです。ほかの記録は同期しました':
          conflicts?'変更点を受信しました。競合した内容の確認が必要です':
          state.outbox.length?'端末の変更を送信待ちです':'記録の変更点を同期しました（写真本体は別途確認）');
        return {pushed:sent.pushed,received:received.applied,pending:state.outbox.length,
          blocked,cursor:state.cursor,conflicts};
      }catch(error){if(!closed){status('warning','変更内容を保持しました：'+error.message);retry(error);}throw error;}
    }
    function sync(){
      if(closed)return Promise.reject(problem('DELTA_CLOSED','この同期処理は終了しています'));
      clear(wakeTimer);wakeTimer=null;requested=true;
      if(pump)return pump;
      const run=async()=>{let result;while(requested){requested=false;result=await work();}return result;};
      pump=run().finally(()=>{pump=null;if(requested&&!closed)wake();});return pump;
    }
    function wake(){
      if(closed||!started||wakeTimer!==null)return;
      if(pump){requested=true;return;}
      // A task boundary coalesces rapid input and keeps local-save acknowledgement
      // independent of network callbacks and remote notifications.
      wakeTimer=schedule(()=>{wakeTimer=null;void sync().catch(()=>{});},0);
    }
    function captureChange({drawingId,before,after,eventId}){
      if(before!==null&&before!==undefined)jsonValue(before);jsonValue(after);
      return {drawingId,eventId,before:before?clone(before):null,after:clone(after)};
    }
    function stageChange(next,{drawingId,before,after,eventId}){
      assert(valid(drawingId)&&valid(after?.id)&&valid(eventId),'DELTA_RECORD','図面・記録・変更IDを確認できません');
      const pending=[...next.outbox,...(next.blockedOutbox||[]).map(b=>b.event)].find(entry=>eventsOf(entry).some(e=>e.eventId===eventId));
      if(pending){
        assert(!isGroup(pending),'DELTA_GROUP_MEMBER','一括操作の一部だけを個別に保存できません');
        const repeated=diffRecord(before,after,{eventId,projectId,drawingId,deviceId});
        assert(C.equal(repeated,pending),'DELTA_COLLISION','同じ変更IDに異なる内容があります');
        return {eventId,duplicate:true};
      }
      const key=keyOf(drawingId,after.id),current=own(next.records,key)?next.records[key]:null;
      assert((!before&&!current)||(before&&current&&C.equal(C.upgrade(before),C.upgrade(current))),
        'DELTA_STALE','記録がほかの操作で更新されました。入力内容を保持して再確認してください');
      const event=diffRecord(current,after,{eventId,projectId,drawingId,deviceId});
      if(!event)return {unchanged:true};
      put(next.records,key,C.upgrade(after));
      const blocked=(next.blockedOutbox||[]).some(b=>eventsOf(b.event).some(e=>sameRecord(e,event)));
      if(blocked)next.blockedOutbox.push({event,reason:{code:'DELTA_DEPENDENT_BLOCKED',
        message:'同じ記録の前の変更を確認するまで送信できません'}});
      else next.outbox.push(event);
      return {eventId,changed:true,blocked};
    }
    async function commitChanges(changes,expectedSnapshotToken){
      return local(async()=>{
        if(expectedSnapshotToken!==undefined)assert(expectedSnapshotToken===snapshotToken,
          'DELTA_STALE','確認後に記録が変更されています。入力内容を保持して再確認してください');
        const next=clone(state),results=changes.map(change=>stageChange(next,change));
        // Every change is validated against this candidate before one durable
        // write. A stale later item cannot commit an earlier part of a move.
        if(results.some(result=>result.changed)){
          await persist(next);
          const blocked=results.some(result=>result.blocked);
          status(blocked?'review':'queued',blocked?
            '確認待ちの記録に追記しました。内容は端末に保護しています':'端末に変更を保存しました');
        }
        if(results.some(result=>result.duplicate||(result.changed&&!result.blocked)))wake();
        return {results:results.map(({changed,blocked,...result})=>result),
          pending:state.outbox.length,blocked:blockedCount(),snapshotToken};
      });
    }
    function capturedChanges(changes){
      assert(Array.isArray(changes)&&changes.length>0&&changes.length<=500,'DELTA_BATCH','まとめて保存する記録の件数が不正です');
      for(const change of changes)assert(object(change),'DELTA_BATCH','まとめて保存する記録の形式が不正です');
      return changes.map(captureChange);
    }
    function commitGroup(changes,groupId,expectedSnapshotToken){
      assert(valid(groupId),'DELTA_GROUP','一括操作の識別情報が必要です');
      return local(async()=>{
        assert(capabilities().atomicGroups,'DELTA_UPGRADE_REQUIRED','一括同期の接続を確認してから保存してください。入力は保持しています');
        if(expectedSnapshotToken!==undefined)assert(expectedSnapshotToken===snapshotToken,'DELTA_STALE','確認後に記録が変更されています。入力を保持して再確認してください');
        const prior=[...state.outbox,...(state.blockedOutbox||[]).map(b=>b.event)].find(e=>isGroup(e)&&e.groupId===groupId);
        if(prior){
          const events=changes.map(({drawingId,before,after,eventId})=>diffRecord(before,after,{drawingId,eventId,projectId,deviceId})).filter(Boolean);
          const repeated=validateGroup({schema:1,kind:'atomic-group',groupId,projectId,deviceId,events});
          assert(C.equal(repeated,prior),'DELTA_GROUP_COLLISION','同じ一括操作IDに異なる内容があります');wake();
          return {groupId,grouped:true,duplicate:true,results:events.map(e=>({eventId:e.eventId,duplicate:true})),
            pending:state.outbox.length,blocked:blockedCount(),snapshotToken};
        }
        const next=clone(state),queued=next.outbox.length,blockedBefore=next.blockedOutbox?.length||0;
        const results=changes.map(change=>stageChange(next,change));
        assert(!results.some(r=>r.duplicate),'DELTA_GROUP_COLLISION','既に別の操作に属する変更を一括操作へ移すことはできません');
        const added=[...next.outbox.slice(queued),...(next.blockedOutbox||[]).slice(blockedBefore).map(b=>b.event)];
        const events=results.filter(r=>r.changed).map(r=>added.find(e=>e.eventId===r.eventId));
        if(!events.length)return {groupId,grouped:true,unchanged:true,results:results.map(()=>({unchanged:true})),
          pending:state.outbox.length,blocked:blockedCount(),snapshotToken};
        const group=validateGroup({schema:1,kind:'atomic-group',groupId,projectId,deviceId,events}),blocked=results.some(r=>r.blocked);
        next.outbox=next.outbox.slice(0,queued);
        if(next.blockedOutbox)next.blockedOutbox=next.blockedOutbox.slice(0,blockedBefore);
        if(blocked){next.blockedOutbox=next.blockedOutbox||[];next.blockedOutbox.push({event:group,reason:{code:'DELTA_DEPENDENT_BLOCKED',
          message:'一括操作に含まれる前の変更を確認するまで、操作全体を送信できません'}});}
        else next.outbox.push(group);
        await persist(next);status(blocked?'review':'queued',blocked?'一括操作全体を端末に保護しました':'一括操作全体を端末に保存しました');if(!blocked)wake();
        return {groupId,grouped:true,results:results.map(({changed,blocked,...result})=>result),pending:state.outbox.length,blocked:blockedCount(),snapshotToken};
      });
    }
    return {
      async start(){
        await local(()=>{
          if(!started){started=true;
            try{live=typeof transport.subscribe==='function'?transport.subscribe(projectId,notice=>{
              if(notice?.projectId===projectId)wake();}):null;}
            catch(error){status('warning','変更通知へ接続できません。差分の定期確認を続けます');}
            reconcile();
          }
        });
        return sync();
      },
      async change({drawingId,before,after,eventId}){
        const result=await commitChanges([captureChange({drawingId,before,after,eventId})]);
        return {...result.results[0],pending:result.pending,...(result.results[0].unchanged?{}:{blocked:result.blocked})};
      },
      async changeBatch({changes,expectedSnapshotToken}={}){
        return commitChanges(capturedChanges(changes),expectedSnapshotToken);
      },
      async changeGroup({changes,groupId,expectedSnapshotToken}={}){return commitGroup(capturedChanges(changes),groupId,expectedSnapshotToken);},
      getCapabilities:capabilities,
      sync,
      onOnline(){clear(retryTimer);retryTimer=null;wake();},
      onVisible(){if(visible())wake();},
      snapshot(){return local(()=>clone(state));},
      snapshotWithStatus(){return local(()=>({snapshot:clone(state),snapshotToken}));},
      isSnapshotCurrent(token){return !closed&&state!==null&&token===snapshotToken;},
      close(){if(closed)return;closed=true;started=false;requested=false;
        clear(wakeTimer);clear(reconcileTimer);clear(retryTimer);wakeTimer=reconcileTimer=retryTimer=null;
        for(const ticket of inflight)ticket.cancel();
        if(typeof live==='function')try{live();}catch{}live=null;
      }
    };
  }
  const api={version:2,diffRecord,combine,createReplica,keyOf,validateEvent,validateGroup,validateOutboxEntry,eventsOf,validateState};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaSyncCore=api;
})(typeof window!=='undefined'?window:globalThis);

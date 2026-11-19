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
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function assert(condition,code,message){if(!condition)throw problem(code,message);}
  const groups=['comments','fields','photos'];
  const keyOf=(drawingId,recordId)=>JSON.stringify([drawingId,recordId]);
  const emptyState=()=>({version:1,cursor:0,records:{},outbox:[]});
  function validateState(state){
    assert(state&&state.version===1&&Number.isSafeInteger(state.cursor)&&state.cursor>=0,
      'DELTA_LOCAL_STATE','端末の同期位置を確認できません');
    assert(state.records&&typeof state.records==='object'&&!Array.isArray(state.records)&&
      Array.isArray(state.outbox),'DELTA_LOCAL_STATE','端末の記録を確認できません');
    for(const e of state.outbox)validateEvent(e);
    return state;
  }
  function validateEvent(e){
    assert(e&&e.schema===1&&valid(e.eventId)&&valid(e.projectId)&&
      valid(e.drawingId)&&valid(e.recordId)&&valid(e.deviceId),
      'DELTA_EVENT','変更の識別情報が不正です');
    assert(['create','patch'].includes(e.kind),'DELTA_EVENT','変更の種類が不正です');
    if(e.kind==='create'){
      assert(e.record&&e.record.id===e.recordId&&e.record.collab,
        'DELTA_EVENT','新規記録の共同編集履歴がありません');
      C.upgrade(e.record);
    }else{
      assert(e.patch&&typeof e.patch==='object'&&!Array.isArray(e.patch)&&
        groups.every(g=>e.patch[g]&&typeof e.patch[g]==='object'&&!Array.isArray(e.patch[g]))&&
        Array.isArray(e.patch.deletion),'DELTA_EVENT','差分の形式が不正です');
    }
    // No photo blob/data URL may be carried by the record event. The file sync
    // verifies the original SHA-256/size through a separate durable path.
    assert(JSON.stringify(e).length<=256*1024,'DELTA_TOO_LARGE','変更が大きすぎます');
    return e;
  }
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
        const added=removedOrChanged(old[id]?.revisions,entry.revisions);
        if(added.length)changes[g][id]={...(g==='comments'?{order:entry.order}:{}),revisions:added};
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
    const initial=C.upgrade(current),collab=clone(initial.collab);
    for(const g of groups){
      for(const [id,entry] of Object.entries(event.patch[g])){
        assert(entry&&Array.isArray(entry.revisions)&&entry.revisions.length>0,
          'DELTA_EVENT','変更履歴が不足しています');
        if(!own(collab[g],id))collab[g][id]={...(g==='comments'?{order:entry.order}:{}),revisions:[]};
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
  function createReplica({projectId,deviceId,store,transport,onStatus=()=>{},onConflict=()=>{},pageLimit=100}){
    assert(valid(projectId)&&valid(deviceId)&&store&&transport,'DELTA_CONFIG','接続設定が不正です');
    assert(typeof store.read==='function'&&typeof store.write==='function'&&
      typeof transport.push==='function'&&typeof transport.list==='function'&&
      typeof transport.online==='function','DELTA_CONFIG','保存・通信方法が不正です');
    assert(Number.isSafeInteger(pageLimit)&&pageLimit>=1&&pageLimit<=500,
      'DELTA_CONFIG','取得件数が不正です');
    let chain=Promise.resolve(),live=null,state=null,started=false,pendingWake=false;
    function serialized(fn){
      const work=chain.then(fn);
      chain=work.catch(()=>{});
      return work;
    }
    async function load(){
      if(state)return;
      const recovered=await store.read();
      state=validateState(recovered?clone(recovered):emptyState());
    }
    async function persist(next){
      validateState(next);
      // The store must atomically replace the record state + cursor + outbox.
      // Never advertise delivery or remove an outbox item before this resolves.
      await store.write(clone(next));
      state=next;
    }
    function status(level,description){onStatus({level,message:description,pending:state?.outbox?.length||0,cursor:state?.cursor||0});}
    function visibleConflicts(record){
      const view=C.view(record);
      if(view.conflicts.length)onConflict({projectId,recordId:record.id,conflicts:clone(view.conflicts)});
    }
    function connected(){return transport.online();}
    async function catchUp(){
      if(!connected())return {offline:true};
      let applied=0;
      for(let page=0;page<10000;page++){
        const rows=await transport.list(projectId,state.cursor,pageLimit);
        assert(Array.isArray(rows)&&rows.length<=pageLimit,'DELTA_SERVER','変更一覧が不正です');
        if(!rows.length)return {applied,cursor:state.cursor};
        for(const row of rows){
          assert(row&&Number.isSafeInteger(row.seq)&&row.seq===state.cursor+1,
            'DELTA_SEQUENCE_GAP','未受信の変更があります。同期位置は進めません');
          assert(row.event?.projectId===projectId,'DELTA_FOREIGN','別案件の変更を受信しました');
          const key=keyOf(row.event.drawingId,row.event.recordId);
          const next=clone(state);
          next.records[key]=combine(next.records[key]||null,row.event);
          next.cursor=row.seq;
          await persist(next);
          visibleConflicts(next.records[key]);
          applied++;
        }
        if(rows.length<pageLimit)return {applied,cursor:state.cursor};
      }
      throw problem('DELTA_PAGE_LIMIT','変更履歴の件数が多いため、次回の同期に分割します');
    }
    async function flush(){
      if(!connected())return {offline:true};
      let pushed=0;
      while(state.outbox.length){
        const event=state.outbox[0];
        // A duplicate request after a lost response returns the same seq;
        // the server must reject a reused ID with changed content.
        const ack=await transport.push(clone(event));
        assert(ack&&Number.isSafeInteger(ack.seq)&&ack.seq>=1,
          'DELTA_NOT_DURABLE','サーバー保存を確認できません');
        const next=clone(state);
        assert(next.outbox[0]?.eventId===event.eventId,
          'DELTA_LOCAL_STATE','未送信の記録が変更されました');
        next.outbox.shift();
        await persist(next);
        pushed++;
      }
      return {pushed};
    }
    async function work(){
      await load();
      if(!connected()){status('offline','圏外中の変更は端末に保管しています');return {offline:true,pending:state.outbox.length};}
      try{
        const {pushed=0}=await flush(),received=await catchUp();
        status('ok','変更点を同期しました');
        return {pushed,received:received.applied,pending:state.outbox.length,cursor:state.cursor};
      }catch(error){
        status('warning','変更内容を保持しました：'+error.message);
        throw error;
      }
    }
    function wake(){
      if(pendingWake)return;
      pendingWake=true;
      Promise.resolve().then(()=>{
        pendingWake=false;
        void serialized(work).catch(()=>{}); // Report via onStatus.
      });
    }
    return {
      async start(){
        return serialized(async()=>{
          await load();
          if(!started){
            started=true;
            live=typeof transport.subscribe==='function'?transport.subscribe(projectId,notice=>{
              if(notice?.projectId===projectId)wake();
            }):null;
          }
          return work();
        });
      },
      async change({drawingId,before,after,eventId}){
        return serialized(async()=>{
          await load();
          assert(valid(drawingId),'DELTA_RECORD','図面が見つかりません');
          const key=keyOf(drawingId,after?.id);
          const local=state.records[key]||null;
          assert((!before&&!local)||(before&&local&&C.equal(C.upgrade(before),C.upgrade(local))),
            'DELTA_STALE','記録がほかの操作で更新されました');
          const event=diffRecord(local,after,{eventId,projectId,drawingId,deviceId});
          if(!event)return {unchanged:true,pending:state.outbox.length};
          const next=clone(state);
          next.records[key]=C.upgrade(after);
          next.outbox.push(event);
          await persist(next);
          status('queued','端末に変更を保存しました');
          return {eventId,pending:state.outbox.length};
        });
      },
      sync(){return serialized(work);},
      onOnline(){wake();},
      onVisible(){wake();},
      async snapshot(){return serialized(async()=>{await load();return clone(state);});},
      close(){if(typeof live==='function')live();live=null;started=false;}
    };
  }
  const api={version:1,diffRecord,combine,createReplica,keyOf,validateEvent};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaSyncCore=api;
})(typeof window!=='undefined'?window:globalThis);

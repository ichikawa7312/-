/* Atomic group scenarios shared by Node and disposable browser fixtures. */
(function(root){
  'use strict';
  async function run({C=root.SentlogRecordCollaboration,D=root.SentlogDeltaSyncCore,S=root.SentlogDeltaIndexedDB,onPass=()=>{},engine='node'}={}){
    const copy=x=>structuredClone(x),results=[],projectId='group-project',ownerId='group-owner';let serial=0;
    const assert=(ok,message='assertion failed')=>{if(!ok)throw Error(message);};
    const equal=(a,b,message)=>assert(C.equal(a,b),message||JSON.stringify(a)+' != '+JSON.stringify(b));
    const scope=deviceId=>({ownerId,projectId,deviceId}),key=(id,d='d1')=>D.keyOf(d,id);
    const record=(id='source')=>C.upgrade({id,kind:'point',recordKind:'field-record',page:1,x:1,y:2,memo:'元の所見 '+id,photos:[]});
    const options=(id,deviceId='A')=>{let n=0;return {actor:{deviceId,deviceName:deviceId},at:10,idFactory:()=>id+':'+(++n)};};
    const edit=(before,text,id,device='A')=>C.appendComment(before,text,options(id,device));
    const state=(device='A',records={[key('source')]:record()})=>({version:2,scope:scope(device),cursor:0,records:copy(records),outbox:[]});
    const change=(before,after,eventId,drawingId='d1')=>({drawingId,before,after,eventId});
    function move(before=record(),id='move',device='A',targetDrawing='d2'){
      const removed=C.markDeleted(before,{...options(id+':delete',device),expectedToken:C.revisionToken(before)});
      const target=C.upgrade({id:'target:'+id,kind:'point',recordKind:'field-record',page:1,x:5,y:6,memo:before.memo,photos:[],
        transferOrigin:{operation:'move',drawingId:'d1',recordId:before.id}});
      return {groupId:id,changes:[change(before,removed,id+':source'),change(null,target,id+':target',targetDrawing)],removed,target};
    }
    function memory(initial){
      let value=copy(initial),writes=0,attempts=0,failAt=0,hook=null;const snapshots=[];
      return {read:async()=>copy(value),async write(next){attempts++;if(hook)await hook(next);if(attempts===failAt)throw Error('disk full');
        value=copy(next);writes++;snapshots.push(copy(next));},current:()=>copy(value),get writes(){return writes;},get attempts(){return attempts;},snapshots,
        failNext(){failAt=attempts+1;},onWrite(fn){hook=fn;}};
    }
    const ids=['projectId','eventId','deviceId','drawingId','recordId'];
    const identity=(event,seq)=>({seq,...Object.fromEntries(ids.map(k=>[k,event[k]]))});
    function server(records={[key('source')]:record()}){
      let saved=copy(records),head=0;const units=[],accepted=new Map(),groups=new Map(),calls={solo:0,group:0,lists:[]};
      const flags={rejectEvent:null,loseReply:false,ack:null,beforePush:null,beforeList:null,page:null};
      const failure=(code,status=400)=>Object.assign(Error(code),{code,status});
      function apply(events){const next=copy(saved);
        for(const event of events){if(event.eventId===flags.rejectEvent)throw failure('DELTA_UNKNOWN_PARENT');
          if(accepted.has(event.eventId))throw failure('DELTA_GROUP_EVENT_ALREADY_ACCEPTED');
          const id=key(event.recordId,event.drawingId);next[id]=D.combine(next[id]||null,event);}
        return next;
      }
      function transport(device){
        const flag={online:true,capable:true};
        return {flag,online:()=>flag.online,getCapabilities:()=>({atomicGroups:flag.capable}),
          async push(event){calls.solo++;D.validateEvent(event);assert(event.deviceId===device&&event.projectId===projectId);
            if(flags.beforePush)await flags.beforePush(event);
            if(accepted.has(event.eventId)){const old=accepted.get(event.eventId);assert(C.equal(old.event,event));return identity(event,old.seq);}
            const next=apply([event]),seq=head+1;saved=next;head=seq;units.push({seq,event:copy(event)});accepted.set(event.eventId,{seq,event:copy(event)});
            return identity(event,seq);
          },
          async pushGroup(group){calls.group++;D.validateGroup(group);assert(group.deviceId===device&&group.projectId===projectId);
            if(flags.beforePush)await flags.beforePush(group);
            let ack;
            if(groups.has(group.groupId)){
              const old=groups.get(group.groupId);if(!C.equal(old.group,group))throw failure('DELTA_GROUP_ID_COLLISION',409);
              ack={...copy(old.ack),duplicate:true};
            }else{
              const next=apply(group.events),startSeq=head+1,endSeq=head+group.events.length;
              ack={schema:1,groupId:group.groupId,projectId,deviceId:device,startSeq,endSeq,duplicate:false,
                events:group.events.map((event,i)=>identity(event,startSeq+i))};
              saved=next;head=endSeq;units.push({seq:startSeq,endSeq,group:copy(group)});groups.set(group.groupId,{group:copy(group),ack:copy(ack)});
              group.events.forEach((event,i)=>accepted.set(event.eventId,{seq:startSeq+i,event:copy(event)}));
            }
            if(flags.loseReply){flags.loseReply=false;throw failure('response lost',503);}return flags.ack?flags.ack(copy(ack)):ack;
          },
          async list(pid,cursor,limit){assert(pid===projectId);calls.lists.push({device,cursor,limit});if(flags.beforeList)await flags.beforeList(cursor);
            assert(!units.some(u=>u.group&&cursor>=u.seq&&cursor<u.endSeq),'cursor inside group');
            let page=copy(units.filter(u=>u.seq>cursor).slice(0,limit));if(flags.page)page=flags.page(page,cursor,limit);
            const last=page.length?(page.at(-1).endSeq||page.at(-1).seq):cursor;
            Object.defineProperties(page,{hasMore:{value:last<head},headSeq:{value:head}});return page;
          }};
      }
      return {transport,flags,calls,units,current:()=>copy(saved),get head(){return head;}};
    }
    function client(device,remote,store=memory(state(device)),extra={}){
      const transport=remote.transport(device),statuses=[],conflicts=[],replica=D.createReplica({...scope(device),store,transport,
        pageLimit:1,reconcileIntervalMs:0,onStatus:s=>statuses.push(s),onConflict:c=>conflicts.push(c),...extra});
      return {replica,store,transport,statuses,conflicts,close:()=>replica.close()};
    }
    async function rejects(fn,codes){let error;try{await fn();}catch(e){error=e;}assert(error,'expected rejection');
      if(codes)assert((Array.isArray(codes)?codes:[codes]).includes(error.code),'expected '+codes+', got '+error.code+': '+error.message);return error;}
    async function within(promise){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('test timed out')),3000);})]);}finally{clearTimeout(timer);}}
    async function test(name,fn){try{await fn();results.push(name);onPass(name);}catch(cause){throw new Error(name+': '+cause.message,{cause});}}
    function whole(snapshot,target){return C.isDeleted(snapshot.records[key('source')])===!!snapshot.records[key(target.id,'d2')];}

    await test('one durable group sends and receives a move with one cursor jump and no intermediate projection',async()=>{
      const remote=server(),a=client('A',remote),b=client('B',remote),operation=move();
      const saved=await a.replica.changeGroup(operation);equal(saved.pending,1);equal(a.store.writes,1);
      equal(a.store.current().outbox[0].events.length,2);assert(whole(a.store.current(),operation.target));
      await a.replica.sync();equal(remote.calls.group,1);equal(remote.calls.solo,0);equal(remote.units.length,1);equal(remote.head,2);
      const received=await b.replica.sync();equal(received.received,2);equal(b.store.writes,1);equal(b.store.current().cursor,2);
      assert(b.store.snapshots.every(s=>whole(s,operation.target)));equal(a.store.current().records,b.store.current().records);a.close();b.close();
    });
    await test('a later invalid local member and quota failure cannot save half a group',async()=>{
      const remote=server(),a=client('A',remote),operation=move(),before=a.store.current();
      const broken=copy(operation);broken.changes[1].before=record('target:move');
      await rejects(()=>a.replica.changeGroup(broken),'DELTA_STALE');equal(a.store.current(),before);equal(a.store.writes,0);
      a.store.failNext();await rejects(()=>a.replica.changeGroup(operation));equal(a.store.current(),before);
      await a.replica.changeGroup(operation);equal(a.store.writes,1);a.close();
    });
    await test('retrying an entire group is idempotent and a member cannot escape through the solo API',async()=>{
      const remote=server(),a=client('A',remote),operation=move();await a.replica.changeGroup(operation);
      assert((await a.replica.changeGroup(operation)).duplicate);equal(a.store.writes,1);
      await rejects(()=>a.replica.change(operation.changes[0]),'DELTA_GROUP_MEMBER');
      const changed=copy(operation);changed.changes[1].after=record('other-target');
      await rejects(()=>a.replica.changeGroup(changed),'DELTA_GROUP_COLLISION');equal(a.store.writes,1);a.close();
    });
    await test('legacy solo entries and groups preserve FIFO while receiver commits only whole group boundaries',async()=>{
      const remote=server(),a=client('A',remote),before=record(),amended=edit(before,'先に追記','first');
      await a.replica.change(change(before,amended,'solo-first'));const operation=move(amended,'after-solo');await a.replica.changeGroup(operation);
      equal(a.store.current().outbox.map(e=>e.kind),['patch','atomic-group']);await a.replica.sync();equal(remote.head,3);
      const b=client('B',remote);await b.replica.sync();equal(b.store.snapshots.map(s=>s.cursor),[1,3]);assert(whole(b.store.current(),operation.target));a.close();b.close();
    });
    await test('lost group ACK and failed ACK persistence retry the same committed group exactly once',async()=>{
      for(const mode of ['network','disk']){
        const remote=server(),a=client('A',remote),operation=move();await a.replica.changeGroup(operation);
        if(mode==='network')remote.flags.loseReply=true;else a.store.failNext();
        await rejects(()=>a.replica.sync());equal(remote.units.length,1);equal(a.store.current().outbox.length,1);equal(a.store.current().cursor,0);
        await a.replica.sync();equal(remote.units.length,1);equal(remote.head,2);equal(a.store.current().outbox.length,0);equal(a.store.current().cursor,2);a.close();
      }
    });
    await test('every group ACK identity and sequence range is required before clearing the durable operation',async()=>{
      const corrupt=[a=>a.groupId='other',a=>a.projectId='other',a=>a.deviceId='other',a=>a.startSeq++,a=>a.endSeq--,
        a=>a.events.pop(),a=>a.events.reverse(),a=>a.events[0].eventId='other',a=>a.events[1].drawingId='other',a=>a.events[1].recordId='other'];
      for(const mutate of corrupt){const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());remote.flags.ack=ack=>{mutate(ack);return ack;};
        await rejects(()=>a.replica.sync(),'DELTA_NOT_DURABLE');equal(a.store.current().outbox.length,1);equal(a.store.current().cursor,0);
        remote.flags.ack=null;await a.replica.sync();equal(remote.units.length,1);a.close();}
    });
    await test('a server-rejected destination rolls back the source and preserves the entire group for review',async()=>{
      const remote=server(),a=client('A',remote),operation=move();await a.replica.changeGroup(operation);remote.flags.rejectEvent='move:target';
      const result=await a.replica.sync();equal(result.blocked,1);equal(remote.units.length,0);equal(remote.head,0);
      assert(!C.isDeleted(remote.current()[key('source')]));equal(remote.current()[key(operation.target.id,'d2')],undefined);
      equal(a.store.current().blockedOutbox[0].event.kind,'atomic-group');equal(a.store.current().blockedOutbox[0].event.events.length,2);
      const b=client('B',remote);await b.replica.sync();equal(b.store.current().cursor,0);assert(!C.isDeleted(b.store.current().records[key('source')]));a.close();b.close();
    });
    await test('PostgREST SQLSTATE group collisions stay whole and allow unrelated queued records to continue',async()=>{
      for(const [code,message,status]of [['23505','DELTA_GROUP_ID_COLLISION',409],['23505','DELTA_GROUP_EVENT_ALREADY_ACCEPTED',409],['54000','DELTA_GROUP_TOO_LARGE',500]]){
        const remote=server(),a=client('A',remote),operation=move();await a.replica.changeGroup(operation);
        await a.replica.change(change(null,record('unrelated'),'unrelated-create'));
        remote.flags.beforePush=entry=>{if(entry.kind==='atomic-group')throw Object.assign(Error(message),{code,status});};
        const result=await a.replica.sync();equal(result.blocked,1);equal(result.pushed,1);equal(a.store.current().outbox,[]);
        equal(a.store.current().blockedOutbox[0].event.events.length,2);equal(remote.units.length,1);equal(remote.units[0].event.eventId,'unrelated-create');
        assert(!C.isDeleted(remote.current()[key('source')]));a.close();
      }
    });
    await test('rejection isolates dependent groups transitively without stopping unrelated records',async()=>{
      const initial={[key('source')]:record(),[key('other')]:record('other'),[key('unrelated')]:record('unrelated')},remote=server(initial),a=client('A',remote,memory(state('A',initial))),first=move();
      await a.replica.changeGroup(first);const other=record('other'),other1=edit(other,'依存する編集','other-1');
      await a.replica.changeGroup({groupId:'dependent',changes:[change(first.target,edit(first.target,'移動後追記','target-1'),'target-1','d2'),change(other,other1,'other-1')]});
      await a.replica.change(change(other1,edit(other1,'さらに追記','other-2'),'other-2'));
      const independent=record('unrelated');await a.replica.change(change(independent,edit(independent,'独立した記録','unrelated-1'),'unrelated-1'));
      remote.flags.rejectEvent='move:target';const result=await a.replica.sync();equal(result.blocked,3);equal(result.pushed,1);
      equal(a.store.current().blockedOutbox.map(b=>b.event.kind),['atomic-group','atomic-group','patch']);equal(remote.units.length,1);
      equal(remote.units[0].event.eventId,'unrelated-1');assert(!C.isDeleted(remote.current()[key('source')]));a.close();
    });
    await test('new edits to one blocked member keep an entire later group protected',async()=>{
      const remote=server(),a=client('A',remote),first=move();await a.replica.changeGroup(first);remote.flags.rejectEvent='move:target';await a.replica.sync();
      const extra=record('new-independent');await a.replica.changeGroup({groupId:'later-group',changes:[change(first.target,edit(first.target,'追記','later'),'later','d2'),change(null,extra,'new-independent')]});
      equal(a.store.current().outbox.length,0);equal(a.store.current().blockedOutbox.length,2);equal(a.store.current().blockedOutbox[1].event.events.length,2);a.close();
    });
    await test('unconfirmed or revoked capability never falls back to individual sends',async()=>{
      const remote=server(),a=client('A',remote),operation=move();a.transport.flag.capable=false;
      await rejects(()=>a.replica.changeGroup(operation),'DELTA_UPGRADE_REQUIRED');equal(a.store.writes,0);
      a.transport.flag.capable=true;await a.replica.changeGroup(operation);a.transport.flag.capable=false;
      await rejects(()=>a.replica.sync(),'DELTA_UPGRADE_REQUIRED');equal(remote.calls.solo,0);equal(remote.calls.group,0);equal(a.store.current().outbox.length,1);
      a.transport.flag.capable=true;await a.replica.sync();equal(remote.calls.group,1);a.close();
    });
    await test('offline restart retains a single group and reconnect sends both members together',async()=>{
      const remote=server(),store=memory(state()),a=client('A',remote,store),operation=move();a.transport.flag.online=false;
      await a.replica.changeGroup(operation);await a.replica.sync();a.close();const restarted=client('A',remote,store);
      equal((await restarted.replica.snapshot()).outbox[0].events.length,2);await restarted.replica.sync();equal(remote.units.length,1);equal(remote.head,2);restarted.close();
    });
    await test('timed-out and closed group requests cannot clear the outbox with a late ACK',async()=>{
      for(const mode of ['timeout','close']){
        const remote=server(),a=client('A',remote,memory(state()),{requestTimeoutMs:20});let release,entered;
        const observed=new Promise(resolve=>{entered=resolve;});remote.flags.beforePush=()=>new Promise(resolve=>{release=resolve;entered();});
        await a.replica.changeGroup(move());const sync=a.replica.sync();const settled=sync.then(()=>({ok:true}),error=>({error}));await observed;if(mode==='close')a.close();
        const outcome=await within(settled);equal(outcome.error.code,mode==='close'?'DELTA_CLOSED':'DELTA_TIMEOUT');equal(a.store.current().outbox.length,1);
        release();await new Promise(resolve=>setTimeout(resolve,0));equal(a.store.current().outbox.length,1);
        remote.flags.beforePush=null;if(mode==='close'){const next=client('A',remote,a.store);await next.replica.sync();next.close();}else await a.replica.sync();
        equal(remote.units.length,1);a.close();
      }
    });
    await test('an invalid later received member leaves both records and cursor unchanged',async()=>{
      const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());await a.replica.sync();
      remote.flags.page=page=>{const group=page[0]?.group;if(group){const original=record('missing');const modified=edit(original,'壊れた差分','bad');
        group.events[1]=D.diffRecord(original,modified,{projectId,deviceId:'A',drawingId:'d2',eventId:'bad'});}return page;};
      const b=client('B',remote),before=b.store.current();await rejects(()=>b.replica.sync(),'DELTA_MISSING_BASE');equal(b.store.current(),before);equal(b.store.writes,0);equal(b.conflicts.length,0);
      remote.flags.page=null;await b.replica.sync();equal(b.store.current().cursor,2);a.close();b.close();
    });
    await test('partial group pages and wrong sequence ranges cannot expose a source-only result',async()=>{
      const corrupt=[page=>{page[0].group.events.pop();return page;},page=>{page[0].endSeq++;return page;},
        page=>[{seq:page[0].seq,event:page[0].group.events[0],groupId:page[0].group.groupId}]];
      for(const mutate of corrupt){const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());await a.replica.sync();remote.flags.page=mutate;
        const b=client('B',remote),before=b.store.current();await rejects(()=>b.replica.sync(),['DELTA_SEQUENCE_GAP','DELTA_SERVER']);equal(b.store.current(),before);equal(b.store.writes,0);a.close();b.close();}
    });
    await test('receive write failure and close before a late page never commit one member or an inner cursor',async()=>{
      const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());await a.replica.sync();
      const b=client('B',remote);b.store.failNext();await rejects(()=>b.replica.sync());equal(b.store.current().cursor,0);assert(!C.isDeleted(b.store.current().records[key('source')]));
      await b.replica.sync();equal(b.store.current().cursor,2);equal(b.store.writes,1);
      let release,entered;const reached=new Promise(resolve=>{entered=resolve;});remote.flags.beforeList=()=>new Promise(resolve=>{release=resolve;entered();});
      const c=client('C',remote),pending=c.replica.sync();const rejection=rejects(()=>pending,'DELTA_CLOSED');await reached;c.close();await rejection;release();
      await new Promise(resolve=>setTimeout(resolve,0));equal(c.store.writes,0);equal(c.store.current().cursor,0);a.close();b.close();
    });
    await test('short unit pages continue across groups without ever requesting an internal event cursor',async()=>{
      const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());const one=record('standalone');await a.replica.change(change(null,one,'solo-last'));
      await a.replica.sync();remote.calls.lists.length=0;const b=client('B',remote,memory(state('B')),{pageLimit:100});
      remote.flags.page=page=>page.slice(0,1);await b.replica.sync();equal(remote.calls.lists.filter(c=>c.device==='B').map(c=>c.cursor),[0,2]);
      equal(b.store.snapshots.map(s=>s.cursor),[2,3]);a.close();b.close();
    });
    await test('concurrent moves from two devices retain both destinations and every immutable history',async()=>{
      const remote=server(),a=client('A',remote),b=client('B',remote),first=move(record(),'move-A','A'),second=move(record(),'move-B','B');
      await Promise.all([a.replica.changeGroup(first),b.replica.changeGroup(second)]);await Promise.all([a.replica.sync(),b.replica.sync()]);await a.replica.sync();await b.replica.sync();
      equal(a.store.current().records,b.store.current().records);assert(a.store.current().records[key(first.target.id,'d2')]);assert(a.store.current().records[key(second.target.id,'d2')]);
      equal(remote.units.length,2);assert(a.store.snapshots.every(s=>s.cursor!==1&&s.cursor!==3));assert(b.store.snapshots.every(s=>s.cursor!==1&&s.cursor!==3));a.close();b.close();
    });
    await test('a peer comment concurrent with moving a record remains visible as pending deletion',async()=>{
      const remote=server(),a=client('A',remote),b=client('B',remote),operation=move();await a.replica.changeGroup(operation);
      await b.replica.change(change(record(),edit(record(),'相手の未確認コメント','peer','B'),'peer'));await b.replica.sync();await a.replica.sync();await b.replica.sync();
      const source=a.store.current().records[key('source')];assert(C.view(source).pendingDelete);assert(source.memo.includes('相手の未確認コメント'));
      assert(a.store.current().records[key(operation.target.id,'d2')]);equal(a.store.current().records,b.store.current().records);assert(a.statuses.some(s=>s.level==='review'));a.close();b.close();
    });
    await test('malformed recovered group scope identities and nested metadata fail before sending',async()=>{
      const remote=server(),a=client('A',remote);await a.replica.changeGroup(move());const saved=a.store.current();a.close();
      for(const mutate of [s=>s.outbox[0].events[0].deviceId='other',s=>s.outbox[0].events.push(copy(s.outbox[0].events[0])),
        s=>s.outbox[0].extra='unexpected',s=>s.outbox[0].events[1].projectId='foreign']){
        const bad=copy(saved);mutate(bad);const recovered=client('A',remote,memory(bad));await rejects(()=>recovered.replica.sync());equal(remote.calls.group,0);equal(recovered.store.writes,0);recovered.close();}
    });
    await test('group capacity and duplicate event IDs are rejected without a durable partial batch',async()=>{
      const remote=server(),a=client('A',remote),operation=move(),duplicate=copy(operation);duplicate.changes[1].eventId=duplicate.changes[0].eventId;
      await rejects(()=>a.replica.changeGroup(duplicate),['DELTA_COLLISION','DELTA_GROUP_COLLISION']);equal(a.store.writes,0);
      const group={schema:1,kind:'atomic-group',groupId:'oversized',projectId,deviceId:'A',events:[]};
      for(let i=0;i<23;i++){const r=record('large:'+i),next=edit(r,'x'.repeat(190000),'large:'+i);group.events.push(D.diffRecord(r,next,{projectId,deviceId:'A',drawingId:'d1',eventId:'large:'+i}));}
      await rejects(()=>D.validateGroup(group),'DELTA_GROUP_TOO_LARGE');a.close();
    });
    if(S&&root.indexedDB)await test('actual IndexedDB persists a grouped outbox and atomic receiver cursor across reopen',async()=>{
      const name='sentlog-delta-test-groups-'+engine+'-'+(++serial),remote=server(),s=S.createStore({...scope('A'),databaseName:name});
      await s.read();await s.write(state('A'));const a=client('A',remote,s),operation=move();a.transport.flag.online=false;await a.replica.changeGroup(operation);a.close();s.close();
      const reopened=S.createStore({...scope('A'),databaseName:name}),next=client('A',remote,reopened);equal((await reopened.read()).outbox[0].kind,'atomic-group');
      await next.replica.sync();next.close();reopened.close();const final=S.createStore({...scope('A'),databaseName:name});
      const saved=await final.read();equal(saved.cursor,2);equal(saved.outbox.length,0);assert(whole(saved,operation.target));final.close();
    });
    return results;
  }
  if(typeof module==='object'&&module.exports)module.exports=run;else root.runDeltaGroupCases=run;
})(typeof window!=='undefined'?window:globalThis);

/* Contract scenarios shared by Node and disposable browser fixtures. */
(function(root){
  'use strict';
  async function run({API,C,D,onPass=()=>{}}){
    const results=[],scope={ownerId:'owner-one',projectId:'cloud-project',deviceId:'device-one'},localId='local-project';
    const clone=value=>structuredClone(value),assert=(ok,message)=>{if(!ok)throw Error(message||'assertion failed');};
    const equal=(a,b,message)=>assert(C.equal(a,b),message||JSON.stringify(a)+' != '+JSON.stringify(b));
    const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const omit=(v,keys)=>Object.fromEntries(Object.entries(v).filter(([key])=>!keys.includes(key)));
    const pg=v=>Array.isArray(v)?'['+v.map(pg).join(', ')+']':v&&typeof v==='object'?'{'+Object.entries(v).reverse().map(([k,x])=>JSON.stringify(k)+': '+pg(x)).join(', ')+'}':JSON.stringify(v);
    const record=(id='record-a')=>C.upgrade({id,kind:'point',x:10,y:20,member:'pier',memo:'既存の所見 🌧️',photos:[]});
    const comment=(r,label,text='追記 '+label)=>C.appendComment(r,text,{commentId:'comment:'+label,revisionId:'revision:'+label,actor:{deviceId:'phone:'+label,deviceName:label},at:100});
    const field=(r,label,value)=>C.setField(r,'member',value,{revisionId:'field:'+label,expectedHeads:C.view(r).fields.member.headIds,actor:{deviceId:label,deviceName:label},at:100});
    const drawing=(id,shapes=[],deleted=[])=>({meta:{id,name:'図面 '+id,updatedAt:1,shapeCount:shapes.length,photoCount:0},
      state:{sourceType:'pdf',fileName:'drawing.pdf',pageCount:2,pageSettings:{1:{scale:100}},pageRotations:{},shapes,collabDeletedRecords:deleted}});
    async function fixture(options={}){
      const server=clone(options.server||[drawing('d1',[record()]),drawing('d2')]);
      const local=clone(options.local||server);
      const project={id:localId,name:'テスト案件',collaborationVersion:1,updatedAt:1,drawings:server.map(d=>clone(d.meta)),...clone(options.serverProject||{})};
      const localProject={...clone(project),drawings:local.map(d=>clone(d.meta)),...clone(options.localProject||{})};
      const rows=[],metadata=[];
      for(const d of server)for(const r of [...d.state.shapes,...(d.state.collabDeletedRecords||[])]){
        const row={ordinal:rows.length+1,drawingId:d.meta.id,recordId:r.id,recordJson:pg(r),sha256:await hash(pg(r))};
        row.manifestEntryJson=pg(omit(row,['recordJson']));rows.push(row);
      }
      for(const value of [{kind:'header',key:'project',value:{project}},...server.map(d=>({kind:'drawing',key:d.meta.id,value:{...d,state:omit(d.state,['shapes','collabDeletedRecords'])}}))]){
        const row={ordinal:metadata.length+1,kind:value.kind,key:value.key,metadataJson:pg(value.value),sha256:await hash(pg(value.value))};
        row.manifestEntryJson=pg(omit(row,['metadataJson']));metadata.push(row);
      }
      const receipt={schema:1,baselineId:'baseline-one',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:localId,
        drawingIds:server.map(d=>d.meta.id),snapshotRevision:7,cursor:0,recordCount:rows.length,importedCount:rows.length,
        metadataCount:metadata.length,metadataManifestSha256:await hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),
        snapshotSha256:await hash(pg({project,drawings:server})),manifestSha256:await hash('['+rows.map(r=>r.manifestEntryJson).join(', ')+']'),
        hashFormat:'postgres-jsonb-text-sha256-v1',state:'verified',deltaEnabled:false,deviceMigrationVerified:false,assetDeliveryVerified:false};
      const rawEntries=[{key:'surveyFieldNoteWorkspaceV1',value:JSON.stringify({projects:[localProject]})},
        ...local.map(d=>({key:'surveyFieldNoteDrawingV1:'+d.meta.id,value:JSON.stringify(d.state)}))];
      const snapshot={version:1,kind:'sentlog-legacy-source',projectId:localId,source:{recordRevision:9},rawEntries,
        originals:[],captureIntentRaw:null,files:[],manifest:[],issues:[],fingerprint:await hash(JSON.stringify(rawEntries)),readyForStaging:true,readyForActivation:false};
      const calls={records:[],metadata:[]};
      const page=(all,field,after,limit)=>({receipt:clone(receipt),[field]:clone(all.slice(after,after+limit)),
        nextOrdinal:Math.min(after+limit,all.length),hasMore:after+limit<all.length});
      const args={scope,receipt,readPage:async(after,limit)=>{calls.records.push([after,limit]);return page(rows,'records',after,limit);},
        readMetadataPage:async(after,limit)=>{calls.metadata.push([after,limit]);return page(metadata,'metadata',after,limit);}};
      return {server,local,project,localProject,receipt,rows,metadata,snapshot,args,calls,
        baseline:()=>API.readBaseline(args),plan:async more=>API.plan({scope,baseline:await API.readBaseline(args),localSnapshot:snapshot,...more})};
    }
    async function rejects(fn,code){let error;try{await fn();}catch(e){error=e;}assert(error,'expected rejection '+code);
      if(code)assert((Array.isArray(code)?code:[code]).includes(error.code),'expected '+code+', got '+error.code+': '+error.message);return error;}
    async function test(name,fn){try{await fn();results.push(name);onPass(name);}catch(cause){throw new Error(name+': '+String(cause?.message||cause),{cause});}}
    function review(plan,code){assert(plan.reviewItems.some(x=>x.code===code),'missing review '+code);assert(!plan.readyForInstall);}
    function changeState(f,id,change){const entry=f.snapshot.rawEntries.find(x=>x.key==='surveyFieldNoteDrawingV1:'+id),state=JSON.parse(entry.value);change(state);entry.value=JSON.stringify(state);}
    async function refreshMetadata(f){
      for(let i=0;i<f.metadata.length;i++){
        const row=f.metadata[i];row.ordinal=i+1;row.sha256=await hash(row.metadataJson);
        row.manifestEntryJson=pg(omit(row,['metadataJson','manifestEntryJson']));
      }
      f.receipt.metadataManifestSha256=await hash('['+f.metadata.map(r=>r.manifestEntryJson).join(', ')+']');
    }

    await test('both page streams verify exact server JSON and complete manifest hashes',async()=>{
      const f=await fixture(),baseline=await API.readBaseline({...f.args,pageLimit:1});
      assert(baseline.verified);equal(baseline.records[0].record,f.server[0].state.shapes[0]);
      equal(baseline.metadata[0].value.project,f.project);equal(f.calls.metadata,[[0,1],[1,1],[2,1]]);
      assert(f.rows[0].recordJson!==JSON.stringify(baseline.records[0].record),'fixture must exercise exact bytes, not JS reserialization');
    });
    await test('an empty record baseline still verifies its authenticated empty page and drawing metadata',async()=>{
      const f=await fixture({server:[drawing('d1'),drawing('d2')]}),b=await f.baseline();
      equal(b.records,[]);equal(f.calls.records,[[0,100]]);equal(b.metadata.length,3);
    });
    await test('active baselines retain cursor zero rather than guessing later receive progress',async()=>{
      const f=await fixture();f.receipt.state='active';f.receipt.deltaEnabled=true;const p=await f.plan();
      equal(p.state.cursor,0);assert(p.readyForInstall);equal(p.readyForActivation,false);equal(p.readyForCloudSync,false);
    });
    await test('a modified record byte is refused even when its parsed meaning seems plausible',async()=>{
      const f=await fixture();f.rows[0].recordJson+=' ';await rejects(()=>f.baseline(),'RECONCILE_BASELINE_HASH');
    });
    await test('a manifest digest mismatch never becomes a verified baseline',async()=>{
      const f=await fixture();f.receipt.manifestSha256='0'.repeat(64);await rejects(()=>f.baseline(),'RECONCILE_BASELINE_MANIFEST');
    });
    await test('metadata bytes and their independent manifest are both checked',async()=>{
      const f=await fixture();f.metadata[1].metadataJson+=' ';await rejects(()=>f.baseline(),'RECONCILE_BASELINE_HASH');
      const g=await fixture();g.receipt.metadataManifestSha256='0'.repeat(64);await rejects(()=>g.baseline(),'RECONCILE_BASELINE_MANIFEST');
    });
    await test('record IDs and drawings must agree across manifest envelope and content',async()=>{
      const f=await fixture();f.rows[0].recordId='other';await rejects(()=>f.baseline(),'RECONCILE_BASELINE_RECORD');
      const g=await fixture();g.rows[0].drawingId='missing';await rejects(()=>g.baseline(),'RECONCILE_BASELINE_RECORD');
      const h=await fixture();h.rows[0].manifestEntryJson=pg({...JSON.parse(h.rows[0].manifestEntryJson),recordId:'other'});
      await rejects(()=>h.baseline(),'RECONCILE_BASELINE_MANIFEST');
    });
    await test('skipped repeated and nonprogressing pages never silently omit records',async()=>{
      for(const mutate of [p=>p.records[0].ordinal=2,p=>p.nextOrdinal=0,p=>{p.records=[];p.nextOrdinal=0;},p=>p.hasMore=true]){
        const f=await fixture(),original=f.args.readPage;f.args.readPage=async(...args)=>{const p=await original(...args);mutate(p);return p;};
        await rejects(()=>f.baseline(),['RECONCILE_BASELINE_ORDINAL','RECONCILE_BASELINE_PAGE']);
      }
    });
    await test('a page cannot replace the baseline revision or activation state halfway through',async()=>{
      const f=await fixture(),original=f.args.readMetadataPage;f.args.readMetadataPage=async(...args)=>{
        const p=await original(...args);p.receipt.snapshotRevision++;return p;};await rejects(()=>f.baseline(),'RECONCILE_BASELINE_CHANGED');
    });
    await test('foreign owner project and unverified receipts are refused before reading pages',async()=>{
      for(const mutation of [r=>r.ownerId='foreign',r=>r.projectId='foreign',r=>r.state='prepared',r=>r.cursor=1,
        r=>r.metadataCount++,r=>r.hashFormat='unknown',r=>r.assetDeliveryVerified=true,r=>r.drawingIds.push(r.drawingIds[0])]){
        const f=await fixture();mutation(f.receipt);await rejects(()=>f.baseline(),'RECONCILE_BASELINE_RECEIPT');equal(f.calls.records,[]);
      }
    });
    await test('scope changes and cancellation fence late baseline replies',async()=>{
      const f=await fixture(),current=clone(scope),old=f.args.readPage;f.args.currentScope=()=>current;
      f.args.readPage=async(...args)=>{const p=await old(...args);current.deviceId='other';return p;};await rejects(()=>f.baseline(),'RECONCILE_SCOPE');
      const g=await fixture(),controller=new AbortController();controller.abort();await rejects(()=>API.readBaseline({...g.args,signal:controller.signal}),'RECONCILE_ABORTED');equal(g.calls.records,[]);
    });
    await test('bounded reader stops before accepting excessive record count or bytes',async()=>{
      const f=await fixture();await rejects(()=>API.readBaseline({...f.args,maxRecords:0}),'RECONCILE_BASELINE_LIMIT');equal(f.calls.records,[]);
      await rejects(()=>API.readBaseline({...f.args,maxBytes:10}),'RECONCILE_BASELINE_LIMIT');
    });
    await test('parsed record and metadata mutations cannot reuse a previously verified receipt',async()=>{
      const f=await fixture(),b=await f.baseline();b.records[0].record.memo='changed';await rejects(()=>API.verifyBaseline(b,{scope}),'RECONCILE_BASELINE_MUTATED');
      const c=await f.baseline();c.metadata[1].value.state.pageCount++;await rejects(()=>API.verifyBaseline(c,{scope}),'RECONCILE_BASELINE_MUTATED');
    });
    await test('verified but contradictory server metadata is preserved as a blocking review',async()=>{
      const f=await fixture(),value=JSON.parse(f.metadata[1].metadataJson);value.meta.pdfFileId='header-has-no-copy';
      f.metadata[1].metadataJson=pg(value);await refreshMetadata(f);const baseline=await f.baseline();assert(baseline.verified);
      const p=await f.plan();review(p,'RECONCILE_BASELINE_DRAWING_METADATA');
      equal(p.metadata.drawings[0].meta.pdfFileId,'header-has-no-copy');equal(p.metadata.header.project.drawings[0].pdfFileId,undefined);
    });
    await test('independently ordered drawing envelopes verify by identity and require review before installation',async()=>{
      const f=await fixture();[f.metadata[1],f.metadata[2]]=[f.metadata[2],f.metadata[1]];await refreshMetadata(f);
      const b=await f.baseline();equal(b.metadata.slice(1).map(x=>x.key),['d2','d1']);
      const p=await f.plan();review(p,'RECONCILE_BASELINE_DRAWING_METADATA');equal(p.metadata.header.project.drawings.map(x=>x.id),['d1','d2']);
    });
    await test('a correctly hashed duplicate metadata identity still cannot hide a missing drawing',async()=>{
      const f=await fixture();f.metadata[2]=clone(f.metadata[1]);await refreshMetadata(f);
      await rejects(()=>f.baseline(),'RECONCILE_BASELINE_METADATA');
    });
    await test('same revision ID with rewritten content is retained as an individual review',async()=>{
      const f=await fixture();changeState(f,'d1',s=>{const c=Object.values(s.shapes[0].collab.comments)[0];c.revisions[0].text='書き換え';s.shapes[0]=C.upgrade(s.shapes[0]);});
      const p=await f.plan();review(p,'COLLAB_REVISION_COLLISION');equal(p.state.outbox,[]);
      equal(p.state.records[D.keyOf('d1','record-a')],f.server[0].state.shapes[0]);assert(p.reviewItems.find(x=>x.code==='COLLAB_REVISION_COLLISION').localRecords[0].record.memo.includes('書き換え'));
    });
    await test('an unchanged local copy creates no events and preserves both baseline drawings',async()=>{
      const f=await fixture(),p=await f.plan();assert(p.readyForInstall);equal(p.state.outbox,[]);equal(p.metadata.drawings.length,2);assert(await API.verifyPlan(p,{scope}));
    });
    await test('local-only records become deterministic create events',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes.push(record('new-record')));const p=await f.plan();
      assert(p.readyForInstall);equal(p.state.outbox.length,1);equal(p.state.outbox[0].kind,'create');
      equal(D.combine(null,p.state.outbox[0]),p.state.records[D.keyOf('d1','new-record')]);
      equal((await f.plan()).state.outbox,p.state.outbox);
    });
    await test('local additions become patches while server-only records remain present',async()=>{
      const a=record(),remote=comment(a,'remote'),f=await fixture({server:[drawing('d1',[remote,record('server-only')]),drawing('d2')],
        local:[drawing('d1',[comment(a,'local')]),drawing('d2')]});const p=await f.plan();
      assert(p.readyForInstall);equal(p.state.outbox.length,1);equal(p.state.outbox[0].kind,'patch');
      assert(p.state.records[D.keyOf('d1','server-only')]);
      const merged=p.state.records[D.keyOf('d1','record-a')];assert(merged.memo.includes('追記 remote')&&merged.memo.includes('追記 local'));
      equal(D.combine(remote,p.state.outbox[0]),merged);
    });
    await test('absence in local state never becomes a deletion of a server record',async()=>{
      const f=await fixture({local:[drawing('d1'),drawing('d2')]}),p=await f.plan();
      assert(p.readyForInstall);equal(p.state.outbox,[]);assert(!C.isDeleted(p.state.records[D.keyOf('d1','record-a')]));
    });
    await test('separate same-text comments remain separate immutable operations',async()=>{
      const base=record(),f=await fixture({server:[drawing('d1',[comment(base,'remote','同じ文')])],local:[drawing('d1',[comment(base,'local','同じ文')])]});
      const p=await f.plan(),v=C.view(p.state.records[D.keyOf('d1','record-a')]);assert(p.readyForInstall);equal(v.comments.filter(c=>c.text==='同じ文').length,2);
    });
    await test('legitimate concurrent fields remain explicit nonblocking alternatives',async()=>{
      const base=record(),f=await fixture({server:[drawing('d1',[field(base,'remote','column')])],local:[drawing('d1',[field(base,'local','beam')])]});
      const p=await f.plan();assert(p.readyForInstall);equal(p.summary.conflicts,1);
      const v=C.view(p.state.records[D.keyOf('d1','record-a')]);assert(v.fields.member.conflict);equal(v.fields.member.heads.map(r=>r.value).sort(),['beam','column']);
    });
    await test('photos independently added on two devices both survive reconciliation',async()=>{
      const base=record(),add=(r,id)=>C.addPhoto(r,{id,size:3,sha256:'1'.repeat(64)},{revisionId:'photo-revision:'+id,at:1});
      const f=await fixture({server:[drawing('d1',[add(base,'remote-photo')])],local:[drawing('d1',[add(base,'local-photo')])]});
      const p=await f.plan();assert(p.readyForInstall);equal(p.state.records[D.keyOf('d1','record-a')].photos.map(p=>p.id).sort(),['local-photo','remote-photo']);
    });
    await test('local deletion tombstones retain their complete history in the initial state',async()=>{
      const base=record(),deleted=C.markDeleted(base,{revisionId:'delete-local',expectedToken:C.revisionToken(base),at:1});
      const f=await fixture({server:[drawing('d1',[base])],local:[drawing('d1',[],[deleted])]}),p=await f.plan();
      assert(p.readyForInstall);assert(C.isDeleted(p.state.records[D.keyOf('d1','record-a')]));equal(p.state.outbox.length,1);
    });
    await test('a concurrent edit against a server deletion is retained as a deletion conflict',async()=>{
      const base=record(),deleted=C.markDeleted(base,{revisionId:'delete-remote',expectedToken:C.revisionToken(base),at:1});
      const f=await fixture({server:[drawing('d1',[],[deleted])],local:[drawing('d1',[comment(base,'local')])]}),p=await f.plan();
      assert(p.readyForInstall);const view=C.view(p.state.records[D.keyOf('d1','record-a')]);assert(view.pendingDelete&&!view.deleted);assert(view.comments.some(c=>c.text==='追記 local'));
    });
    await test('a pending move keeps its source tombstone and destination but cannot seed independently sent events',async()=>{
      const base=record(),deleted=C.markDeleted(base,{revisionId:'pending-move-delete',expectedToken:C.revisionToken(base),at:1});
      const target=C.upgrade({id:'moved-record',kind:'point',x:1,y:2,memo:'移動先',photos:[],transferOrigin:{drawingId:'d1',recordId:base.id,operation:'move'}});
      const f=await fixture({server:[drawing('d1',[base]),drawing('d2')],local:[drawing('d1',[],[deleted]),drawing('d2',[target])]}),p=await f.plan();
      review(p,'RECONCILE_ATOMIC_GROUP_REQUIRED');equal(p.state.outbox.length,2);
      assert(C.isDeleted(p.state.records[D.keyOf('d1',base.id)]));assert(p.state.records[D.keyOf('d2',target.id)]);equal(p.preservedLocal.rawEntries,f.snapshot.rawEntries);
    });
    await test('a destination-only move marker and an unlinked create plus delete both require atomic grouping review',async()=>{
      const marker=C.upgrade({id:'moved-record',memo:'移動先',photos:[],transferOrigin:{drawingId:'other',recordId:'source',operation:'move'}});
      const f=await fixture({local:[drawing('d1',[record(),marker]),drawing('d2')]});review(await f.plan(),'RECONCILE_ATOMIC_GROUP_REQUIRED');
      const base=record(),deleted=C.markDeleted(base,{revisionId:'unlinked-delete',expectedToken:C.revisionToken(base),at:1});
      const g=await fixture({local:[drawing('d1',[record('new-unlinked')],[deleted]),drawing('d2')]});review(await g.plan(),'RECONCILE_ATOMIC_GROUP_REQUIRED');
    });
    await test('moving an identical record ID across drawings cannot bypass pending group detection',async()=>{
      const base=record(),f=await fixture({server:[drawing('d1',[base]),drawing('d2')],local:[drawing('d1'),drawing('d2',[base])]}),p=await f.plan();
      review(p,'RECONCILE_ATOMIC_GROUP_REQUIRED');assert(p.state.records[D.keyOf('d1',base.id)]);assert(p.state.records[D.keyOf('d2',base.id)]);
    });
    await test('ordinary edits after a completed baseline move and genuine non-destructive copies remain possible',async()=>{
      const moved=C.upgrade({id:'moved-record',memo:'既に移動済み',photos:[],transferOrigin:{drawingId:'old',recordId:'source',operation:'move'}});
      const f=await fixture({server:[drawing('d1',[moved])],local:[drawing('d1',[comment(moved,'after move')])]});assert((await f.plan()).readyForInstall);
      const copied=C.upgrade({id:'copied-record',memo:'コピー',photos:[],transferOrigin:{drawingId:'d1',recordId:'record-a',operation:'copy'}});
      const g=await fixture({local:[drawing('d1',[record(),copied]),drawing('d2')]});assert((await g.plan()).readyForInstall);
    });
    await test('identical record IDs in different drawings cannot cross-merge',async()=>{
      const f=await fixture({server:[drawing('d1',[record()]),drawing('d2',[record()])]});changeState(f,'d1',s=>s.shapes[0]=comment(s.shapes[0],'only-d1'));
      const p=await f.plan();equal(p.state.outbox.length,1);equal(p.state.outbox[0].drawingId,'d1');assert(!p.state.records[D.keyOf('d2','record-a')].memo.includes('only-d1'));
    });
    await test('event identities remain stable across repeated source captures of the same changes',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes[0]=comment(s.shapes[0],'stable'));
      const a=await f.plan();f.snapshot.fingerprint='b'.repeat(64);const b=await f.plan();equal(a.state.outbox,b.state.outbox);assert(a.planSha256!==b.planSha256);
      const other={...scope,deviceId:'other-device'},c=await API.plan({scope:other,baseline:await f.baseline(),localSnapshot:f.snapshot});
      assert(c.state.outbox[0].eventId!==a.state.outbox[0].eventId);
    });
    await test('raw local input and server candidates are never mutated while planning',async()=>{
      const f=await fixture(),b=await f.baseline(),before=clone({b,s:f.snapshot});await API.plan({scope,baseline:b,localSnapshot:f.snapshot});
      equal({b,s:f.snapshot},before);
    });
    await test('a drawing absent from the authoritative baseline cannot receive a queued record',async()=>{
      const f=await fixture({local:[drawing('d1',[record()]),drawing('d2'),drawing('new-drawing',[record('new-record')])]});
      const p=await f.plan();review(p,'RECONCILE_DRAWING_NOT_IN_BASELINE');assert(!p.state.records[D.keyOf('new-drawing','new-record')]);
      assert(p.reviewItems.some(x=>x.localRecords?.[0]?.record.id==='new-record'));equal(p.state.outbox,[]);
    });
    await test('duplicate IDs preserve every local candidate rather than choosing the first',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes.push(comment(s.shapes[0],'duplicate')));const p=await f.plan();review(p,'RECONCILE_DUPLICATE_RECORD');
      equal(p.reviewItems.find(x=>x.code==='RECONCILE_DUPLICATE_RECORD').localRecords.length,2);equal(p.state.outbox,[]);
    });
    await test('scale PDF rotation drawing order and project name differences remain protected reviews',async()=>{
      for(const mutate of [f=>changeState(f,'d1',s=>s.pageSettings[1].scale=200),f=>changeState(f,'d1',s=>s.fileName='new.pdf'),
        f=>changeState(f,'d1',s=>s.pageRotations={1:90}),f=>{const e=f.snapshot.rawEntries[0],w=JSON.parse(e.value);w.projects[0].drawings.reverse();e.value=JSON.stringify(w);},
        f=>{const e=f.snapshot.rawEntries[0],w=JSON.parse(e.value);w.projects[0].name='new name';e.value=JSON.stringify(w);}]){
        const f=await fixture();mutate(f);const p=await f.plan();assert(!p.readyForInstall);assert(p.reviewItems.some(x=>/METADATA/.test(x.code)));equal(p.preservedLocal.rawEntries,f.snapshot.rawEntries);
      }
    });
    await test('view preferences and derived counts are kept separately without blocking record changes',async()=>{
      const f=await fixture();const e=f.snapshot.rawEntries[0],w=JSON.parse(e.value);w.projects[0].updatedAt=999;
      w.projects[0].drawings[0].updatedAt=999;w.projects[0].drawings[0].shapeCount=88;e.value=JSON.stringify(w);
      changeState(f,'d1',s=>{s.currentPage=2;s.labelSize='small';s.nextGlobalNo=90;s.width=400;s.shapes[0]=comment(s.shapes[0],'new');});
      const p=await f.plan();assert(p.readyForInstall);equal(p.metadata.localView.project.updatedAt,999);equal(p.metadata.localView.drawings.d1.state.labelSize,'small');equal(p.state.outbox.length,1);
    });
    await test('local cache fields do not enter events while their exact original rows remain protected',async()=>{
      const withPhoto=C.addPhoto(record(),{id:'p1',size:3,sha256:'2'.repeat(64)},{revisionId:'p1-revision',at:1});
      const f=await fixture({server:[drawing('d1',[withPhoto])]});changeState(f,'d1',s=>{s.shapes[0].photos[0].localBlob=true;s.shapes[0].photos[0].data='data:image/jpeg;base64,YWJj';});
      const p=await f.plan();assert(p.readyForInstall);equal(p.state.outbox,[]);assert(!own(p.state.records[D.keyOf('d1','record-a')].photos[0],'data'));
      equal(p.preservedLocal.rawEntries,f.snapshot.rawEntries);
      function own(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
    });
    await test('unrecorded raw textarea edits are preserved rather than silently projected away',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes[0].memo='まだ履歴化されていない追記');const p=await f.plan();review(p,'RECONCILE_UNRECORDED_EDIT');
      equal(p.reviewItems.find(x=>x.code==='RECONCILE_UNRECORDED_EDIT').localRecords[0].record.memo,'まだ履歴化されていない追記');equal(p.state.outbox,[]);
    });
    await test('unknown collaboration container metadata remains in the original review record',async()=>{
      for(const change of [r=>r.collab.future={value:'keep'},r=>r.collab.projection.future='keep',
        r=>r.collab.fields.member.future='keep',r=>r.collab.deletion.future='keep']){
        const f=await fixture();changeState(f,'d1',s=>change(s.shapes[0]));const p=await f.plan();review(p,'RECONCILE_UNKNOWN_HISTORY_METADATA');
        equal(p.reviewItems.find(x=>x.code==='RECONCILE_UNKNOWN_HISTORY_METADATA').localRecords[0].record,
          JSON.parse(f.snapshot.rawEntries[1].value).shapes[0]);equal(p.state.outbox,[]);
      }
    });
    await test('a pre-collaboration record is retained without inventing its history',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes.push({id:'old-record',memo:'古い入力',photos:[]}));const p=await f.plan();review(p,'RECONCILE_LEGACY_RECORD');
      assert(p.reviewItems.find(x=>x.code==='RECONCILE_LEGACY_RECORD').localRecords[0].record.memo==='古い入力');
    });
    await test('unknown deletion observations cannot seed changes the SQL receiver would reject',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes[0].collab.deletion.revisions[0].observed.push('missing-history'));
      const p=await f.plan();review(p,'RECONCILE_UNKNOWN_OBSERVED');equal(p.state.outbox,[]);
    });
    await test('a huge pending record keeps its local content outside the send queue',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes[0]=comment(s.shapes[0],'huge','x'.repeat(270000)));
      const p=await f.plan();review(p,'DELTA_TOO_LARGE');equal(p.state.outbox,[]);assert(p.reviewItems.find(x=>x.code==='DELTA_TOO_LARGE').localRecords[0].record.memo.length>270000);
    });
    await test('jsonb separator overhead is checked before a barely fitting JS event is queued',async()=>{
      const f=await fixture(),base=f.server[0].state.shapes[0],probe=comment(base,'limit','x');
      const ev=D.diffRecord(base,probe,{eventId:'migration:'+'0'.repeat(64),projectId:scope.projectId,drawingId:'d1',deviceId:scope.deviceId});
      const size=new TextEncoder().encode(JSON.stringify(ev)).byteLength,n=256*1024-size;
      changeState(f,'d1',s=>s.shapes[0]=comment(base,'limit','x'.repeat(n)));
      const p=await f.plan();review(p,'RECONCILE_EVENT_TOO_LARGE');equal(p.state.outbox,[]);
    });
    await test('a pending source recovery issue prevents installation without dropping valid other changes',async()=>{
      const f=await fixture();changeState(f,'d1',s=>s.shapes[0]=comment(s.shapes[0],'valid'));
      f.snapshot.issues.push({code:'LEGACY_SOURCE_FILE_MISSING',message:'photo waiting',blocking:true,drawingId:'d1'});
      const p=await f.plan();review(p,'LEGACY_SOURCE_FILE_MISSING');equal(p.state.outbox.length,1);assert(await API.verifyPlan(p,{scope}));
    });
    await test('source informational notices do not pretend to prove photo delivery',async()=>{
      const f=await fixture();f.snapshot.issues.push({code:'ORIGINAL_NOT_REQUIRED',message:'shared-only legacy',blocking:false});const p=await f.plan();
      assert(p.readyForInstall);assert(!p.readyForCloudSync&&!p.readyForActivation);
    });
    await test('local project ID mapping cannot be supplied by a different staged copy',async()=>{
      const f=await fixture();f.snapshot.projectId='another-local-project';await rejects(()=>f.plan(),'RECONCILE_SCOPE');
    });
    await test('malformed workspace or missing drawing data is kept as a global review',async()=>{
      const f=await fixture();f.snapshot.rawEntries[0].value='broken JSON';const p=await f.plan();review(p,'RECONCILE_SOURCE_PROJECT');equal(p.preservedLocal.rawEntries,f.snapshot.rawEntries);
      const g=await fixture();g.snapshot.rawEntries=g.snapshot.rawEntries.filter(x=>x.key!=='surveyFieldNoteDrawingV1:d1');const q=await g.plan();review(q,'RECONCILE_SOURCE_DRAWING');assert(q.state.records[D.keyOf('d1','record-a')]);
    });
    await test('special object-looking identifiers remain data and cannot change prototypes',async()=>{
      const f=await fixture({server:[drawing('__proto__',[record('__proto__')])]}),p=await f.plan();assert(p.readyForInstall);
      assert(Object.prototype.hasOwnProperty.call(p.metadata.localView.drawings,'__proto__'));assert(p.state.records[D.keyOf('__proto__','__proto__')]);assert({}.polluted===undefined);
    });
    await test('plans bind state metadata protected originals and readiness to their checksum',async()=>{
      const f=await fixture(),p=await f.plan();for(const mutate of [x=>x.state.records[D.keyOf('d1','record-a')].memo='bad',
        x=>x.metadata.header.project.name='bad',x=>x.preservedLocal.rawEntries[0].value='bad',x=>x.sourceFingerprint='f'.repeat(64)]){
        const changed=clone(p);mutate(changed);await rejects(()=>API.verifyPlan(changed,{scope}),'RECONCILE_PLAN_CHANGED');
      }
      await rejects(()=>API.verifyPlan(p,{scope:{...scope,deviceId:'foreign'}}),'RECONCILE_PLAN');
    });
    return results;
  }
  if(typeof module==='object'&&module.exports)module.exports={run};else root.SentlogReconcileTestCases={run};
})(typeof window!=='undefined'?window:globalThis);

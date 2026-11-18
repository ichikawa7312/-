// Pure planning plus the real asynchronous transfer executor (no browser/filesystem IO).
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../sentlog/record-collaboration.js'),T=require('../sentlog/record-transfer.js');
const code=fs.readFileSync(path.join(__dirname,'../sentlog/record-transfer.js'),'utf8'),copy=x=>JSON.parse(JSON.stringify(x));
const WS='surveyFieldNoteWorkspaceV1',DRAW=id=>'surveyFieldNoteDrawingV1:'+id;
const actor={deviceId:'copy-device',deviceName:'コピー端末'};
const opts=prefix=>{let n=0;return {actor:{deviceId:prefix,deviceName:prefix},at:10,idFactory:()=>prefix+'-'+(++n)};};
function sourceRecord(){let s=C.upgrade({id:'original',kind:'field-record',recordKind:'field-record',recordType:'survey',page:1,type:'調査',point:{x:10,y:20},points:[{x:10,y:20},{x:10,y:20}],labelPos:{x:30,y:40},memo:'最初の記録',photos:[{id:'original-photo',name:'撮影.jpg',type:'image/jpeg',size:3}]});s=C.appendComment(s,'Aが追記',opts('Author-A'));const id=C.view(s).comments[0].id;return C.editComment(s,id,'最初の記録を修正',{...opts('Author-B'),expectedHeads:C.view(s).comments[0].headIds});}
function states(){return {source:{sourceType:'pdf',fileName:'source.pdf',pageCount:3,currentPage:1,pageSettings:{},pageRotations:{},shapes:[sourceRecord()],collabDeletedRecords:[]},target:{sourceType:'pdf',fileName:'target.pdf',pageCount:3,currentPage:1,pageSettings:{},pageRotations:{},shapes:[],collabDeletedRecords:[]}};}
function planOptions(extra={}){let record=0,photo=0,revision=0;return {collaborative:true,operation:'move',sourceDrawingId:'d1',targetDrawingId:'d2',targetPage:2,sx:2,sy:3,actor,at:90,idFactory:()=>`record-${++record}`,photoIdFactory:()=>`photo-${++photo}`,revisionIdFactory:()=>`revision-${++revision}`,...extra};}
function fixture({onRead,onFlush,onOpen,pendingDraft=false}={}){
  const initial=states(),sourceMeta={id:'d1',name:'元図面',sourceType:'pdf',pageCount:3},targetMeta={id:'d2',name:'先図面',sourceType:'pdf',pageCount:3};
  const workspace={projects:[{id:'project',name:'試験',collaborationVersion:1,drawings:[sourceMeta,targetMeta]}]},records=new Map([[WS,JSON.stringify(workspace)],[DRAW('d1'),JSON.stringify(initial.source)],[DRAW('d2'),JSON.stringify(initial.target)]]);
  const files=new Map([['photo:d1:original-photo',new Blob(['abc'],{type:'image/jpeg'})]]);let uuid=0,batches=0,user='owner-a';
  const ctx={console:{error(){}},Blob,JSON,Map,Set,Date,Number,Promise,Uint8Array,crypto:{subtle:crypto.webcrypto.subtle,randomUUID:()=>`runtime-id-${++uuid}`},document:{getElementById:()=>null},
    SentlogRecordCollaboration:C,SentlogCollaboration:{actor:()=>actor,flushDraft:()=>false,hasPendingDraft:()=>pendingDraft,onRemote(){}},
    sentlogCollaborationAccountId:()=>user,sentlogAppReady:new Promise(()=>{}),activeProjectId:'project',activeDrawingId:'d1',selected:'original',currentView:'editor',state:copy(initial.source),workspace:copy(workspace),
    normalizeRotation:x=>x,pdfjsLib:{getDocument:()=>({promise:Promise.resolve({numPages:3,getPage:async()=>({rotate:0,getViewport:({scale})=>({width:100*scale,height:200*scale})}),destroy:async()=>{}})})},
    getProject:id=>ctx.workspace.projects.find(p=>p.id===(id||ctx.activeProjectId)),getBackgroundFile:async()=>new Blob(['pdf'],{type:'application/pdf'}),
    getDBFile:async key=>{if(onRead)await onRead(key,{ctx,records,files,setAccount:v=>{user=v;}});return files.get(key);},
    confirm:()=>true,alert:()=>{},rebuildNumberingState:()=>{},
    openDrawing:async(projectId,drawingId)=>{if(onOpen)await onOpen({ctx,records,files});ctx.activeProjectId=projectId;ctx.activeDrawingId=drawingId;ctx.state=JSON.parse(records.get(DRAW(drawingId)));},renderPdfPage:async page=>{ctx.state.currentPage=page;},
    SentlogRecords:{getItem:key=>records.get(key)??null,settled:async()=>{},assertSafe:()=>{},writeFile:async(key,file)=>{files.set(key,file);},batch:writes=>{batches++;for(const [k,v] of writes)records.set(k,v);},flush:async()=>{if(onFlush)await onFlush({ctx,records,files});}}};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
  return {ctx,records,files,initial,get batches(){return batches;},execute:options=>ctx.SentlogRecordTransfer.execute({ids:['original'],operation:'move',targetDrawingId:'d2',targetPage:2,...options})};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
await test('collaborative moves retain complete source history and create valid destination revisions with new photo identities',()=>{
  const {source,target}=states(),before=JSON.stringify([source,target]),original=source.shapes[0];
  const p=T.makeTransferPlan(source,target,['original'],planOptions()),tomb=p.sourceState.collabDeletedRecords[0],moved=p.targetState.shapes[0];
  assert.equal(JSON.stringify([source,target]),before);assert.equal(p.sourceState.shapes.length,0);assert(C.isDeleted(tomb));
  for(const kind of ['comments','fields','photos'])for(const [key,entry] of Object.entries(original.collab[kind]))assert.deepEqual(tomb.collab[kind][key],entry);
  assert.equal(moved.id,'record-1');assert.equal(moved.page,2);assert.deepEqual(moved.point,{x:20,y:60});assert.deepEqual(moved.points,[{x:20,y:60},{x:20,y:60}]);assert.deepEqual(moved.labelPos,{x:60,y:120});
  assert.equal(moved.memo,original.memo);assert.deepEqual(moved.collab.comments,original.collab.comments,'copied comment author/order/history stay intact');
  assert.equal(C.view(moved).fields.geometry.heads[0].actor.deviceId,actor.deviceId);assert.equal(moved.transferOrigin.recordId,original.id);
  assert.deepEqual(moved.photos.map(p=>p.id),['photo-1']);assert.deepEqual(Object.keys(moved.collab.photos),['photo-1']);assert.equal(moved.photos[0].transferSource.photoId,'original-photo');
  assert(C.equal(C.upgrade(moved),moved),'reopening cannot revert transformed points or photo IDs through an old projection');assert.equal(C.view(moved).conflicts.length,0);
  assert.deepEqual(p.photoJobs.map(j=>[j.sourcePhotoId,j.targetPhotoId]),[['original-photo','photo-1']]);
});
await test('copy retains source and same-drawing page move keeps the source tombstone beside the new record',()=>{
  const {source,target}=states(),copied=T.makeTransferPlan(source,target,['original'],planOptions({operation:'copy'}));assert.deepEqual(copied.sourceState,source);
  const moved=T.makeTransferPlan(source,source,['original'],planOptions({sameDrawing:true,targetDrawingId:'d1'}));assert.equal(moved.sourceState,moved.targetState);assert.equal(moved.sourceState.shapes.length,1);assert.equal(moved.sourceState.shapes[0].page,2);assert.equal(moved.sourceState.collabDeletedRecords[0].id,'original');
});
await test('pending candidates and identity reuse are rejected before any record or file mutation',()=>{
  const {source,target}=states(),base=source.shapes[0],a=C.setField(base,'type','A',{...opts('A'),expectedHeads:C.view(base).fields.type.headIds}),b=C.setField(base,'type','B',{...opts('B'),expectedHeads:C.view(base).fields.type.headIds});source.shapes=[C.mergeRecords(a,b,{base}).record];
  assert.throws(()=>T.makeTransferPlan(source,target,['original'],planOptions()),/確認待ち/);
  const fresh=states();assert.throws(()=>T.makeTransferPlan(fresh.source,fresh.target,['original'],planOptions({idFactory:()=> 'original'})),/IDが重複/);
  assert.throws(()=>T.makeTransferPlan(fresh.source,fresh.target,['original'],planOptions({photoIdFactory:()=> 'original-photo'})),/写真IDが重複/);
});
await test('mixed old-client raw memo survives transfer as an attributed legacy import',()=>{
  const {source,target}=states();source.shapes[0].memo='旧版で残した文章';const p=T.makeTransferPlan(source,target,['original'],planOptions());assert(p.targetState.shapes[0].memo.includes('旧版で残した文章'));assert(p.sourceState.collabDeletedRecords[0].memo.includes('旧版で残した文章'));
});
await test('the real executor verifies copied files and commits source/destination/workspace exactly once',async()=>{
  const f=fixture();assert.equal(await f.execute(),true);assert.equal(f.batches,1);const source=JSON.parse(f.records.get(DRAW('d1'))),target=JSON.parse(f.records.get(DRAW('d2')));
  assert.equal(source.shapes.length,0);assert(C.isDeleted(source.collabDeletedRecords[0]));assert.equal(target.shapes.length,1);const photo=target.shapes[0].photos[0];assert.equal(await f.files.get('photo:d2:'+photo.id).text(),'abc');assert(f.files.has('photo:d1:original-photo'));assert.equal(f.ctx.activeDrawingId,'d2');assert.equal(f.ctx.state.currentPage,2);
});
await test('changes during awaited photo work abort instead of replacing a newer source, target, account or preview',async()=>{
  for(const change of ['source','target','workspace','account','preview']){
    let changed=false;const f=fixture({onRead:async(key,env)=>{if(changed||key!=='photo:d1:original-photo')return;changed=true;const {ctx,records}=env;
      if(change==='source'){const s=JSON.parse(records.get(DRAW('d1')));s.shapes[0]=C.appendComment(s.shapes[0],'遅れて届いた文章',opts('Peer'));records.set(DRAW('d1'),JSON.stringify(s));ctx.state=copy(s);}
      if(change==='target'){const s=JSON.parse(records.get(DRAW('d2')));s.shapes.push(C.upgrade({id:'peer-record',memo:'移動先の追記',photos:[]}));records.set(DRAW('d2'),JSON.stringify(s));}
      if(change==='workspace'){const ws=JSON.parse(records.get(WS));ws.projects[0].name='相手が変更';records.set(WS,JSON.stringify(ws));ctx.workspace=copy(ws);}
      if(change==='account')env.setAccount('owner-b');if(change==='preview')ctx.state.shapes[0].point.x=777;
    }});
    await assert.rejects(f.execute(),e=>e.code==='TRANSFER_CHANGED',change);assert.equal(f.batches,0,change);assert.equal(JSON.parse(f.records.get(DRAW('d1'))).shapes.length,1,change);
    if(change==='source')assert(JSON.parse(f.records.get(DRAW('d1'))).shapes[0].memo.includes('遅れて届いた文章'));
    if(change==='target')assert.equal(JSON.parse(f.records.get(DRAW('d2'))).shapes[0].id,'peer-record');if(change==='preview')assert.equal(f.ctx.state.shapes[0].point.x,777);
  }
});
await test('flush or post-commit navigation failure never restores stale complete snapshots over later updates',async()=>{
  for(const stage of ['flush','open']){
    let f;const later=async({records})=>{const target=JSON.parse(records.get(DRAW('d2')));target.shapes[0]=C.appendComment(target.shapes[0],'確定後に届いた追記',opts('After'));records.set(DRAW('d2'),JSON.stringify(target));throw Error('一時的なエラー');};
    f=fixture(stage==='flush'?{onFlush:later}:{onOpen:later});await assert.rejects(f.execute(),/記録は残しています/);assert.equal(f.batches,1);assert.equal(JSON.parse(f.records.get(DRAW('d1'))).collabDeletedRecords[0].id,'original');assert(JSON.parse(f.records.get(DRAW('d2'))).shapes[0].memo.includes('確定後に届いた追記'));assert(f.files.has('photo:d1:original-photo'));
  }
});
await test('a preexisting unsaved preview or pending draft cannot be discarded by transfer startup',async()=>{
  const f=fixture();f.ctx.state.shapes[0].point.x=555;await assert.rejects(f.execute(),/保存待ち/);assert.equal(f.batches,0);assert.equal(f.ctx.state.shapes[0].point.x,555);
  const pending=fixture({pendingDraft:true});await assert.rejects(pending.execute(),/入力中のコメント/);assert.equal(pending.batches,0);
});
console.log(passed+' collaborative transfer scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});

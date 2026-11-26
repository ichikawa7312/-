'use strict';
const assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const Recovery=require('../sentlog/delta-sync-migration-recovery.js');
const copy=x=>structuredClone(x),scope={ownerId:'owner',projectId:'cloud-project',deviceId:'phone'};
const digest=async blob=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
async function fixture(options={}){
 const blob=new Blob(['verified existing photograph'],{type:'image/jpeg'}),sha=await digest(blob);
 const item={key:'photo:d1:p1',kind:'photo',drawingId:'d1',photoId:'p1',expected:[{id:'p1',size:blob.size,sha256:sha}],
  drawing:{id:'d1',fileName:'a.pdf',sourceType:'pdf'},state:{fileName:'a.pdf',sourceType:'pdf',pageCount:1}};
 const asset={id:'asset1',owner_id:'owner',project_id:'cloud-project',client_key:item.key,kind:'photo',
  storage_path:'owner/cloud-project/photos/a.jpg',file_name:'a.jpg',byte_size:blob.size,sha256:sha,status:'uploaded',
  metadata:{local_project_key:'local-project',drawing_id:'d1',photo_id:'p1'}};
 let items=[item],assets=[asset],valid=true,after=async()=>{},beforeReadAsset=async()=>{},receivedBlob=blob,snap={revision:12,payload:{project:{id:'local-project'},
  drawings:[{meta:copy(item.drawing),state:copy(item.state)}]}};
 const saved=[],downloaded=[],listed=[],f={item,asset,blob,sha,saved,downloaded,listed,
  set items(v){items=v;},set assets(v){assets=v;},set after(v){after=v;},set snapshot(v){snap=v;},get snapshot(){return copy(snap);},
  set receivedBlob(v){receivedBlob=v;},set beforeReadAsset(v){beforeReadAsset=v;},invalidate(){valid=false;}};
 const recovery=Recovery.createRecovery({...options,
  async listAssets(s,keys){assert.deepEqual(s,scope);listed.push(copy(keys));return copy(assets);},
  async readAsset(s,id){await beforeReadAsset(id);return copy(assets.find(a=>a.id===id)||null);},
  async download(a){downloaded.push(a.id);await after(a);return receivedBlob;},
  async readSnapshot(){return copy(snap);}});
 const args=()=>({scope,localProjectId:'local-project',serverRevision:12,missing:items,
  validate(){assert(valid,'scope expired');}});
 f.recovery=recovery;
 f.review=(extra={})=>recovery.prepareReview({...args(),key:item.key,...extra});
 f.run=()=>recovery({...args(),
  async restore(value){assert.equal(await digest(value.blob),value.sha256);assert.equal(value.size,value.blob.size);saved.push(value);}});
 f.background=()=>{item.kind='background';item.key='background:d1';delete item.photoId;item.expected=[];
  asset.kind='drawing';asset.client_key='drawing:d1';asset.file_name='a.pdf';asset.storage_path='owner/cloud-project/drawings/a.pdf';delete asset.metadata.photo_id;asset.metadata.source_type='pdf';};
 return f;
}
(async()=>{
 {const f=await fixture();const result=await f.run();assert.equal(result.restored,1);assert.equal(f.saved[0].proof.assetId,'asset1');
  assert.equal(f.saved[0].proof.clientKey,f.item.key);assert.deepEqual(f.listed,[['photo:d1:p1']]);assert.deepEqual(result.issues,[]);}
 for(const [name,mutate]of [
  ['different owner',f=>f.asset.owner_id='other'],['different project',f=>f.asset.project_id='other'],
  ['different drawing',f=>f.asset.metadata.drawing_id='other'],['different photo',f=>f.asset.metadata.photo_id='other'],
  ['different local project',f=>f.asset.metadata.local_project_key='other'],['different hash',f=>f.asset.sha256='f'.repeat(64)],
  ['foreign storage path',f=>f.asset.storage_path='another/cloud-project/photos/a.jpg'],
  ['unsafe storage path',f=>f.asset.storage_path='owner/cloud-project/photos/../a.jpg'],
  ['different size',f=>f.asset.byte_size++],['deleted remote bytes',f=>f.asset.status='storage_deleted'],
  ['ambiguous duplicate',f=>f.assets=[f.asset,{...copy(f.asset),id:'second'}]],
  ['protected corrupt local file',f=>f.item.recoverable=false]]){
  const f=await fixture();mutate(f);const result=await f.run();assert.equal(f.saved.length,0,name);assert.equal(f.downloaded.length,0,name);
  assert.equal(result.issues.length,1,name);assert.equal(result.issues[0].reviewable,false,name);
  assert.equal(result.issues[0].key,f.item.key,name);assert.equal(typeof result.issues[0].reason,'string',name);
 }
 {const f=await fixture();f.after=async()=>{f.asset.storage_path='changed-after-download';};await f.run();assert.equal(f.saved.length,0);}
 {const f=await fixture();f.after=async()=>f.invalidate();await assert.rejects(f.run(),/scope expired/);assert.equal(f.saved.length,0);}
 {const f=await fixture();f.item.expected=[{id:'p1'}];await f.run();assert.equal(f.saved.length,1,'legacy metadata without hashes uses exact authenticated immutable asset');}
 {const f=await fixture();f.background();await f.run();assert.deepEqual(f.listed,[['drawing:d1']]);
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].proof.clientKey,'drawing:d1');}
 {const f=await fixture();f.background();f.snapshot={revision:13};await f.run();assert.equal(f.saved.length,0,'cannot recover unversioned background against another snapshot');}
 {const f=await fixture();f.background();f.item.state.pageReplacements={1:{updatedAt:1,pdfHash:'f'.repeat(64),pdfSize:f.blob.size}};
  await f.run();assert.equal(f.saved.length,0,'wrong PDF revision');}
 {const f=await fixture();f.background();f.item.state.pageReplacements={1:{updatedAt:1,pdfHash:f.sha,pdfSize:f.blob.size}};
  f.snapshot={revision:13};await f.run();assert.equal(f.saved.length,1,'exact declared hash survives unrelated newer metadata revision');}
 {const f=await fixture();f.background();f.item.state.pageReplacements={1:{updatedAt:1}};await f.run();assert.equal(f.saved.length,0,'ambiguous old replacement remains protected');}
 {const f=await fixture();f.background();f.after=async()=>{f.snapshot={revision:13};};await f.run();assert.equal(f.saved.length,0,'snapshot change during drawing download');}
 for(const options of [{maxFiles:2},{maxFiles:10,maxBytes:60},{maxFiles:10,maxBytes:1}]){
  const f=await fixture(options),items=[],assets=[];
  for(let i=0;i<5;i++){const photoId='p'+i,key='photo:d1:'+photoId;
   items.push({...copy(f.item),key,photoId,expected:[{id:photoId,size:f.blob.size,sha256:f.sha}]});
   assets.push({...copy(f.asset),id:'a'+i,client_key:key,metadata:{...f.asset.metadata,photo_id:photoId}});}
  f.items=items;f.assets=assets;const r=await f.run();assert.equal(r.restored,options.maxBytes===1?0:2);
  assert.equal(f.downloaded.length,r.restored);assert.equal(r.remaining,5-r.restored);
 }
 {const f=await fixture({maxBytes:1});f.background();assert.equal((await f.run()).restored,1,'one large drawing can make progress');}
 {const f=await fixture({maxBytes:30}),second=copy(f.item),a=copy(f.asset);second.photoId='p2';second.key='photo:d1:p2';second.expected=[{id:'p2'}];
  a.id='asset2';a.client_key=second.key;a.metadata.photo_id='p2';f.items=[f.item,second];f.assets=[f.asset,a];
  f.after=async()=>{f.asset.storage_path='owner/cloud-project/photos/changed.jpg';};await f.run();
  assert.equal(f.downloaded.length,1,'rejected downloads still consume the byte budget');assert.equal(f.saved.length,0);}
 {let aborted=false,written=false;
  const f=await fixture();const recovery=Recovery.createRecovery({timeoutMs:10,listAssets:async()=>[f.asset],readAsset:async()=>f.asset,readSnapshot:async()=>null,
   download:async(a,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}});
  await assert.rejects(recovery({scope,localProjectId:'local-project',serverRevision:12,missing:[f.item],validate(){},restore:async()=>{written=true;}}),e=>e.code==='DELTA_RECOVERY_TIMEOUT');
  assert(aborted);assert(!written);}
 {const f=await fixture();f.asset.storage_path='owner/cloud-project/active-restore/asset1/'+f.sha+'/'+'d'.repeat(64)+'/11111111-1111-4111-8111-111111111111.jpg';
  assert.equal((await f.run()).restored,1,'verified recovery path stays readable');}
 {const f=await fixture({maxFiles:1}),missing=copy(f.item);missing.key='photo:d1:unavailable';missing.photoId='unavailable';
  missing.expected=[{id:'unavailable'}];f.items=[missing,f.item];
  await f.run();assert.equal(f.saved.length,0);await f.run();assert.equal(f.saved.length,1,'unavailable early rows cannot starve later verified files');}
 // An unchanged source descriptor cannot prove that an unversioned PDF still
 // has its original bytes. A newer same-name file must remain a user choice.
 {const f=await fixture();f.background();const snapshot=f.snapshot;snapshot.revision=13;f.snapshot=snapshot;
  const changed=new Blob(['different unversioned PDF bytes'],{type:'application/pdf'});
  f.receivedBlob=changed;f.asset.sha256=await digest(changed);f.asset.byte_size=changed.size;f.asset.mime_type='application/pdf';
  const result=await f.run();assert.equal(result.restored,0);assert.equal(f.downloaded.length,0);assert.equal(f.saved.length,0);
  assert.deepEqual(result.issues,[{key:'background:d1',kind:'background',drawingId:'d1',reason:'SNAPSHOT_REVISION_MISMATCH',
   message:'図面「a.pdf」：以前の図面とクラウドのPDFが同じ内容か自動では確認できません。候補PDFを確認して復旧できます',reviewable:true}]);
  const prepared=await f.review();assert.equal(prepared.originalSnapshotRevision,12);assert.equal(prepared.selectedSnapshotRevision,13);
  assert.equal(prepared.proof.snapshotRevision,13);assert.equal(prepared.proof.ownerId,scope.ownerId);
  assert.equal(prepared.proof.projectId,scope.projectId);assert.equal(prepared.proof.clientKey,'drawing:d1');
  assert.deepEqual(prepared.source,{id:'d1',fileName:'a.pdf',sourceType:'pdf',pageCount:1,pageReplacements:{}});
  assert.deepEqual(prepared.proof.source,prepared.source);assert.equal(await prepared.blob.text(),await changed.text());
  assert.notEqual(prepared.sha256,f.sha);assert.equal(f.saved.length,0,'preparing a candidate never calls restore');
  assert.equal('originalVerified' in prepared.proof,false);assert.equal('sourceKind' in prepared.proof,false);
  assert.equal(Object.isFrozen(prepared.ticket),true);assert.deepEqual(Object.keys(prepared.ticket),[]);
  const verified=await f.recovery.validateReview(prepared.ticket);assert.equal(verified.sha256,prepared.sha256);
  assert.equal(verified.proof.snapshotRevision,13);assert.equal(f.saved.length,0,'validating a candidate never calls restore');
  assert.equal(f.recovery.releaseReview(prepared.ticket),true);
 }
 // Cancelling or releasing a preview has no save path, including a validation
 // whose remote read was already in flight at the moment of cancellation.
 {const f=await fixture();f.background();const snapshot=f.snapshot;snapshot.revision=13;f.snapshot=snapshot;
  const prepared=await f.review();assert.equal(f.recovery.releaseReview(prepared.ticket),true);
  assert.equal(f.recovery.releaseReview(prepared.ticket),false);
  await assert.rejects(f.recovery.validateReview(prepared.ticket),e=>e.code==='DELTA_RECOVERY_REVIEW_TICKET');
  assert.equal(f.saved.length,0);
 }
 {const f=await fixture();f.background();const prepared=await f.review();let unblock,started;
  const reading=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{unblock=resolve;});
  f.beforeReadAsset=async()=>{started();await wait;};
  const checking=f.recovery.validateReview(prepared.ticket);await reading;
  f.recovery.releaseReview(prepared.ticket);unblock();
  await assert.rejects(checking,e=>e.code==='DELTA_RECOVERY_REVIEW_TICKET');assert.equal(f.saved.length,0);
 }
 {const f=await fixture();f.background();const prepared=await f.review();
  prepared.sha256='f'.repeat(64);prepared.proof.snapshotRevision=100;prepared.source.fileName='changed.pdf';
  prepared.proof.source.sourceType='image';prepared.originalSnapshotRevision=1;
  const verified=await f.recovery.validateReview(prepared.ticket);
  assert.equal(verified.sha256,f.sha);assert.equal(verified.proof.snapshotRevision,12);assert.equal(verified.source.fileName,'a.pdf');
  assert.equal(verified.proof.source.sourceType,'pdf');assert.equal(verified.originalSnapshotRevision,12);
  const other=await fixture();await assert.rejects(other.recovery.validateReview(prepared.ticket),e=>e.code==='DELTA_RECOVERY_REVIEW_TICKET');
  f.recovery.releaseReview(prepared.ticket);assert.equal(f.saved.length,0);
 }
 for(const [name,mutate]of [
  ['wrong owner',f=>f.asset.owner_id='other'],['wrong project',f=>f.asset.project_id='other'],
  ['wrong file key',f=>f.asset.client_key='drawing:other'],['wrong drawing',f=>f.asset.metadata.drawing_id='other'],
  ['wrong source type',f=>f.asset.metadata.source_type='image'],['wrong filename',f=>f.asset.file_name='other.pdf'],
  ['invalid digest',f=>f.asset.sha256='not-a-digest'],['wrong path',f=>f.asset.storage_path='other/cloud-project/drawings/a.pdf'],
  ['duplicate asset',f=>f.assets=[f.asset,{...copy(f.asset),id:'other'}]],
  ['protected empty file',f=>f.item.recoverable=false],
  ['known conflicting replacement',f=>f.item.state.pageReplacements={1:{updatedAt:1,pdfHash:'f'.repeat(64)}}],
  ['unverified replacement marker',f=>f.item.state.pageReplacements={1:{updatedAt:0}}],
  ['different source descriptor',f=>{const s=f.snapshot;s.payload.drawings[0].state.pageCount=2;f.snapshot=s;}],
  ['older snapshot revision',f=>{const s=f.snapshot;s.revision=11;f.snapshot=s;}],
  ['wrong snapshot project',f=>{const s=f.snapshot;s.payload.project.id='other';f.snapshot=s;}]]){
  const f=await fixture();f.background();const snapshot=f.snapshot;snapshot.revision=13;f.snapshot=snapshot;mutate(f);
  const result=await f.run();assert.equal(result.restored,0,name);assert(result.issues.every(item=>!item.reviewable),name);
  await assert.rejects(f.review(),e=>/^DELTA_RECOVERY_REVIEW_/.test(e.code),name);
  assert.equal(f.downloaded.length,0,name);assert.equal(f.saved.length,0,name);
 }
 for(const [name,mutate]of [
  ['asset changes during candidate download',f=>f.asset.storage_path='owner/cloud-project/drawings/new.pdf'],
  ['snapshot advances during candidate download',f=>{const s=f.snapshot;s.revision++;f.snapshot=s;}],
  ['same revision payload changes during candidate download',f=>{const s=f.snapshot;s.payload.project.name='changed';f.snapshot=s;}],
  ['auth changes during candidate download',f=>f.invalidate()]]){
  const f=await fixture();f.background();f.after=async()=>mutate(f);
  await assert.rejects(f.review(),e=>e.code==='DELTA_RECOVERY_REVIEW_CHANGED'||/scope expired/.test(e.message),name);
  assert.equal(f.saved.length,0,name);
 }
 for(const [name,mutate]of [
  ['asset digest changes after preview',f=>f.asset.sha256='f'.repeat(64)],
  ['asset identity changes after preview',f=>f.asset.owner_id='other'],
  ['asset metadata changes after preview',f=>f.asset.metadata.drawing_id='other'],
  ['snapshot advances after preview',f=>{const s=f.snapshot;s.revision++;f.snapshot=s;}],
  ['same revision payload changes after preview',f=>{const s=f.snapshot;s.payload.project.name='changed';f.snapshot=s;}],
  ['auth changes after preview',f=>f.invalidate()]]){
  const f=await fixture();f.background();const prepared=await f.review();mutate(f);
  await assert.rejects(f.recovery.validateReview(prepared.ticket),e=>e.code==='DELTA_RECOVERY_REVIEW_CHANGED'||/scope expired/.test(e.message),name);
  await assert.rejects(f.recovery.validateReview(prepared.ticket),e=>e.code==='DELTA_RECOVERY_REVIEW_TICKET',name);
  assert.equal(f.saved.length,0,name);
 }
 for(const validate of [()=>false,()=>Promise.resolve(true)]){
  const f=await fixture();f.background();await assert.rejects(f.review({validate}),e=>e.code==='DELTA_RECOVERY_SCOPE');
  assert.equal(f.listed.length,0);assert.equal(f.saved.length,0);
 }
 {const f=await fixture();await assert.rejects(f.review(),e=>e.code==='DELTA_RECOVERY_REVIEW_UNAVAILABLE');
  assert.equal(f.downloaded.length,0,'photo reference cannot be reviewed as a drawing');assert.equal(f.saved.length,0);}
 {const f=await fixture();f.background();f.receivedBlob=new Blob(['wrong-size']);
  await assert.rejects(f.review(),e=>e.code==='DELTA_RECOVERY_BYTES');assert.equal(f.saved.length,0);}
 // The journal performs the final byte digest verification. This helper does
 // not certify a downloaded candidate as the original or write it itself.
 {const f=await fixture();f.background();f.receivedBlob=new Blob(['x'.repeat(f.blob.size)]);
  const prepared=await f.review();assert.notEqual(await digest(prepared.blob),prepared.sha256);
  assert.equal(prepared.sha256,f.asset.sha256);assert.equal(f.saved.length,0);f.recovery.releaseReview(prepared.ticket);}
 console.log('PASS migration recovery: exact cloud identity/hash/version, bounded sequential files, changed asset/auth/snapshot fences, preserved missing and ambiguous sources');
 console.log('PASS drawing review: no automatic same-name substitution, read-only opaque candidates, cancel/changed remote/auth guards, explicit selected-version proof');
})().catch(error=>{console.error(error);process.exitCode=1;});

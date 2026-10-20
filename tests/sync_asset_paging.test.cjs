const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/../sentlog/sync-merge-runtime.txt','utf8');
const hash=async blob=>createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const original=new Blob(['original drawing bytes']);
const photo=new Blob(['original photo bytes']);
let rows=[],calls=[],files=new Map(),cap=1000,onRead=null;
const api=vm.runInNewContext(source+';({readProjectAssets,checkMergeFiles})',{
  Blob,Map,Set,window:{},enc:encodeURIComponent,sha256Hex:hash,dbGet:async key=>files.get(key),
  rest:async path=>{
    const q=new URL(path,'https://test.invalid').searchParams;
    calls.push(path);if(onRead)onRead(q);
    let found=rows.filter(a=>'eq.'+a.project_id===q.get('project_id'));
    if(q.get('status')==='neq.storage_deleted')found=found.filter(a=>a.status!=='storage_deleted');
    if(q.has('id'))found=found.filter(a=>'gt.'+a.id>q.get('id'));
    if(q.get('order')==='id.asc')found.sort((a,b)=>a.id.localeCompare(b.id));
    return found.slice(0,Math.min(cap,Number(q.get('limit')||cap))).map(a=>({...a}));
  }
});
const pack={project:{drawings:[{id:'d'}]},drawings:[{meta:{id:'d',name:'護岸4'},state:{sourceType:'image',shapes:[{photos:[{id:'late'}]}]}}]};
(async()=>{
  rows=Array.from({length:1339},(_,i)=>({id:id(i+1),project_id:'p',client_key:'photo:other:'+i,kind:'photo',status:'storage_deleted'}));
  Object.assign(rows[1300],{client_key:'drawing:d',kind:'drawing',sha256:await hash(original),byte_size:original.size});
  Object.assign(rows[1338],{client_key:'photo:d:late',sha256:await hash(photo),byte_size:photo.size});
  files.set('background:d',original);files.set('photo:d:late',photo);
  assert(!rows.slice(0,1000).some(a=>a.client_key==='drawing:d'),'fixture reproduces the previous truncated lookup');
  await api.checkMergeFiles({id:'p'},pack,pack);
  assert(calls.length>3);
  assert.equal((await api.readProjectAssets('p','client_key')).length,1339);
  // Even a server cap below the requested page size must not end the scan early.
  cap=137;calls=[];
  assert.equal((await api.readProjectAssets('p','client_key')).length,1339);
  assert(calls.length>=10);
  // A mismatching late photo or drawing must still block, including deleted cloud copies.
  files.set('photo:d:late',new Blob(['different photo bytes']));
  await assert.rejects(api.checkMergeFiles({id:'p'},pack,pack),/同じ写真ID/);
  files.set('photo:d:late',photo);files.set('background:d',new Blob(['different drawing bytes']));
  await assert.rejects(api.checkMergeFiles({id:'p'},pack,pack),/図面原本の一致/);
  files.delete('background:d');
  await assert.rejects(api.checkMergeFiles({id:'p'},pack,pack),/図面原本の一致/);
  files.set('background:d',original);
  // A later-page network error cannot turn a partial list into an approved merge.
  onRead=q=>{if(q.has('id'))throw Error('synthetic page failure')};
  await assert.rejects(api.checkMergeFiles({id:'p'},pack,pack),/synthetic page failure/);
  onRead=null;
  // Delivery also reaches the final asset, preserving the status/project filters.
  rows.forEach(a=>a.status='uploaded');rows[20].status='storage_deleted';
  rows.push({id:id(2000),project_id:'other',status:'uploaded'});
  let found=await api.readProjectAssets('p','client_key',{availableOnly:true});
  assert.equal(found.length,1338);assert(found.some(a=>a.client_key==='photo:d:late'));
  assert(found.every(a=>a.project_id==='p'&&a.status!=='storage_deleted'));
  // Deletion behind the cursor while reading cannot skip the next surviving ID.
  onRead=q=>{if(q.has('id'))rows=rows.filter(a=>a.id!==id(1))};
  found=await api.readProjectAssets('p','client_key');onRead=null;
  assert.equal(new Set(found.map(a=>a.id)).size,1339);
  // Invalid repeated pages fail instead of hanging or accepting incomplete data.
  rows=[{id:id(1),project_id:'p'},{id:id(1),project_id:'p'}];
  await assert.rejects(api.readProjectAssets('p','client_key'),/最後まで確認/);
  console.log('PASS 1,339 assets: full merge/delivery scans, lower server cap, late mismatches, missing original, partial failure, stable cursor and scope filters');
})().catch(e=>{console.error(e);process.exitCode=1});

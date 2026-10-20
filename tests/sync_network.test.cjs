const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHash}=require('node:crypto');
let attempts=0,handler;
const api=vm.runInNewContext(fs.readFileSync(__dirname+'/../sentlog/sync-network-runtime.txt','utf8')+';({readSyncResponse})',{
  AbortController,setTimeout,clearTimeout,navigator:{onLine:true},SUPABASE_URL:'https://test.invalid',headers:x=>x,sleep:async()=>{},
  fetch:async(...args)=>{attempts++;return handler(...args)}
});
const ok=()=>({status:200,text:async()=>'[]'});
(async()=>{
  handler=()=>{if(attempts===1)throw new TypeError('Load failed');return ok()};
  assert.equal((await api.readSyncResponse('/read')).text,'[]');assert.equal(attempts,2);
  attempts=0;handler=()=>({status:200,text:async()=>{if(attempts===1)throw new TypeError('body interrupted');return '[]'}});
  await api.readSyncResponse('/read');assert.equal(attempts,2);
  attempts=0;handler=()=>{throw new TypeError('Load failed')};
  await assert.rejects(api.readSyncResponse('/read'),/通信が途中/);assert.equal(attempts,2);
  attempts=0;await assert.rejects(api.readSyncResponse('/write',{method:'POST',body:'{}'}),/通信が途中/);assert.equal(attempts,1);
  attempts=0;handler=()=>({status:409,text:async()=>'conflict'});
  assert.equal((await api.readSyncResponse('/write',{method:'POST'})).response.status,409);assert.equal(attempts,1);
  attempts=0;handler=()=>({status:401,text:async()=>'unauthorized'});await api.readSyncResponse('/read');assert.equal(attempts,1);
  attempts=0;handler=()=>({status:attempts===1?503:200,text:async()=>'[]'});await api.readSyncResponse('/read');assert.equal(attempts,2);
  // Exercise the built upload function: matched originals need no per-file
  // request, but every absent/mismatching cache entry is checked freshly.
  const code=fs.readFileSync(__dirname+'/../sentlog/cloud-sync.js','utf8');
  const fn=code.slice(code.indexOf('async function uploadAsset('),code.indexOf('async function uploadPhoto('));
  let lookups=0;const blob=new Blob(['exact original']),hash=createHash('sha256').update('exact original').digest('hex');
  const existing={kind:'photo',sha256:hash,byte_size:blob.size,status:'storage_deleted'};
  const upload=vm.runInNewContext(fn+';uploadAsset',{Blob,sha256Hex:async()=>hash,existingAsset:async()=>{lookups++;return existing}});
  const knownAssets=new Map(Array.from({length:1339},(_,n)=>['photo:'+n,{...existing}]));
  for(const [clientKey] of knownAssets)assert.equal((await upload({blob,kind:'photo',clientKey,knownAssets})).status,'exists');
  assert.equal(lookups,0);
  await upload({blob,kind:'photo',clientKey:'missing',knownAssets});assert.equal(lookups,1);
  knownAssets.set('wrong',{...existing,sha256:'0'.repeat(64)});await upload({blob,kind:'photo',clientKey:'wrong',knownAssets});assert.equal(lookups,2);
  console.log('PASS bounded network/body read retries, writes never retried, auth/conflict handling, 1,339 matched assets without individual requests, fresh mismatch checks');
})().catch(e=>{console.error(e);process.exitCode=1});

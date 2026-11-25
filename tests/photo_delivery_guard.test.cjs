'use strict';
// Execute the actual retention-only Edge Function with synthetic data.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('supabase/functions/sentlog-delete-verified/index.ts','utf8');
assert(!source.includes('SUPABASE_SERVICE_ROLE_KEY'),'retention never creates an admin client');
assert(!/\.remove\(|\.update\(|\.delete\(/.test(source),'retention has no mutation path');
const script=source.replace(/^import .*;\s*$/gm,'').replace(/:\s*unknown\b/g,'').replace(/:\s*Request(?=\s*\))/g,'').replace(/\)!(?=[,;])/g,')');
async function scenario({kind='photo',projectStatus='active',status='pc_verified',badPc=false,projectMissing=false,foreign=false,auth=true,missing=false}={}){
 const asset={id:'asset-1',owner_id:foreign?'other':'account-1',project_id:'project-1',kind,status,storage_path:'account-1/project/f',
  storage_deleted_at:status==='storage_deleted'?'old':null,sha256:'f'.repeat(64),byte_size:101,source_device_id:'phone'};
 const rows={sentlog_assets:missing?[]:[asset],sentlog_projects:projectMissing?[]:[{id:'project-1',status:projectStatus}],
  sentlog_pc_receipts:[{asset_id:asset.id,sha256:badPc?'e'.repeat(64):asset.sha256,byte_size:asset.byte_size}]};
 let handler=null,queries=0;
 const client={auth:{getUser:async()=>auth?{data:{user:{id:'account-1'}},error:null}:{data:{user:null},error:{message:'invalid'}}},
  from:table=>{queries++;assert(Object.hasOwn(rows,table),'only the three read-only tables are queried');let f=[];const q={
   select(){return q;},eq(k,v){f.push(x=>x[k]===v);return q;},async single(){const a=rows[table].find(x=>f.every(g=>g(x)));return {data:a||null,error:a?null:{message:'missing'}};}};return q;}};
 vm.runInNewContext(script,{console,Request,Response,Deno:{serve:f=>handler=f,env:{get:k=>k==='SUPABASE_URL'?'https://example.invalid':k==='SUPABASE_ANON_KEY'?'anon':(()=>{throw Error('admin forbidden')})()}},
  createClient:(url,key)=>{assert.equal(key,'anon');return client;}});
 const response=await handler(new Request('https://example.invalid/retain',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({asset_id:'asset-1'})}));
 return {code:response.status,data:await response.json(),queries};
}
(async()=>{
 for(const kind of ['photo','drawing'])for(const projectStatus of ['active','archived']){
  const r=await scenario({kind,projectStatus});assert.equal(r.code,200);assert.equal(r.data.retained,true);assert.equal(r.queries,3);
  assert.equal(r.data.reason,projectStatus==='archived'?'archived_project_retained':'active_project_'+kind);
 }
 for(const opts of [{badPc:true},{status:'uploaded'},{kind:'other'},{projectStatus:'unknown'}])assert.equal((await scenario(opts)).code,409);
 assert.equal((await scenario({foreign:true})).code,403);assert.equal((await scenario({auth:false})).code,401);
 assert.equal((await scenario({missing:true})).code,404);assert.equal((await scenario({projectMissing:true})).code,500);
 const deleted=await scenario({status:'storage_deleted'});assert.equal(deleted.data.already_deleted,true);assert(!deleted.data.retained);
 console.log('PASS retain-only shared media: active/archived photo and drawing, archive/reopen race cannot delete bytes, legacy receipt/ownership/status checks, no admin or storage mutations');
})().catch(e=>{console.error(e);process.exitCode=1;});

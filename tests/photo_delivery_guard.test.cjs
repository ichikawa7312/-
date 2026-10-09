'use strict';
// Execute the actual deployed Edge Function body with a synthetic Supabase DB.
// Never use a live account or mutate production Storage.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('supabase/functions/sentlog-delete-verified/index.ts','utf8');
const script=source.replace(/^import .*;\s*$/gm,'')
 .replace(/:\s*unknown\b/g,'')
 .replace(/:\s*\{[^{}]*\}(?=\s*\))/g,'')
 .replace(/:\s*string(?=\s*\))/g,'')
 .replace(/:\s*Request(?=\s*\))/g,'');
assert(!script.includes('device_id:string'),'TS annotations were not removed');
function makeQuery(table,rows,counters){
 let filters=[],type='select';
 const q={
  select(){if(type==='update')return Promise.resolve({data:[{id:'asset-1'}],error:null});return q;},
  update(){type='update';return q;},
  eq(k,v){filters.push(x=>x[k]===v);return q;},
  in(k,vs){filters.push(x=>vs.includes(x[k]));return q;},
  is(k,v){filters.push(x=>x[k]==null&&v==null);return q;},
  gte(k,v){filters.push(x=>x[k]>=v);return q;},
  async single(){const match=(rows[table]||[]).filter(x=>filters.every(f=>f(x)))[0]||null;
   return {data:match,error:match?null:{message:'not found'}};},
  then(yes,no){return Promise.resolve({data:(rows[table]||[]).filter(x=>filters.every(f=>f(x))),error:null}).then(yes,no);}
 };
 return q;
}
async function scenario({pending=[],devices=[],legacyReceipts=[],photo=true}={}){
 const now=Date.now();
 const asset={id:'asset-1',owner_id:'account-1',kind:photo?'photo':'drawing',status:'pc_verified',
  storage_path:'account-1/project/photo-redelivery.jpg',storage_deleted_at:null,
  sha256:'f'.repeat(64),byte_size:101,source_device_id:'iphone-original'};
 const rows={
  sentlog_assets:[asset],
  sentlog_pc_receipts:[{asset_id:asset.id,sha256:asset.sha256,byte_size:asset.byte_size}],
  sentlog_pdf_requests:pending.map(p=>({asset_id:asset.id,owner_id:'account-1',expected_sha256:asset.sha256,
    received_at:null,...p})),
  sentlog_devices:devices.map(d=>({owner_id:'account-1',active:true,
    last_seen_at:new Date(now).toISOString(),...d})),
  sentlog_asset_device_receipts:legacyReceipts.map(id=>({asset_id:asset.id,device_id:id,sha256:asset.sha256,
    byte_size:asset.byte_size}))
 };
 let handler=null,removed=0,updates=0;
 const browserClient={
  auth:{getUser:async()=>({data:{user:{id:'account-1'}},error:null})},
  from:table=>makeQuery(table,rows),
 };
 const adminClient={
  from:table=>{if(table==='sentlog_assets'){
   const q=makeQuery(table,rows);const old=q.update;
   q.update=function(...args){updates++;return old.call(this,...args);};return q;
  }return makeQuery(table,rows);},
  storage:{from:()=>({remove:async paths=>{removed++;return {error:null};}})}
 };
 const scope={
  console,Date,Set,Map,Promise,Request,Response,
  Deno:{serve:f=>{handler=f;},env:{get:k=>k==='SUPABASE_SERVICE_ROLE_KEY'?'service':k==='SUPABASE_ANON_KEY'?'anon':'https://example.invalid'}},
  createClient:(url,key)=>key==='service'?adminClient:browserClient
 };
 vm.runInNewContext(script,scope);
 assert.equal(typeof handler,'function');
 const request=new Request('https://example.invalid/sentlog-delete-verified',{method:'POST',
  headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({asset_id:'asset-1'})});
 const response=await handler(request);
 return {code:response.status,data:await response.json(),removed,updates};
}
(async()=>{
 const fresh=new Date().toISOString(),stale=new Date(Date.now()-3600000).toISOString();
 const online=await scenario({pending:[{device_id:'browser-1',requested_at:fresh}],
  devices:[{id:'browser-1',device_type:'browser'}]});
 assert.equal(online.code,409);assert.equal(online.data.error,'photo_delivery_pending');
 assert.equal(online.removed,0,'active browser request must prevent photo deletion');
 const ack=await scenario({pending:[],devices:[{id:'browser-1',device_type:'browser'}]});
 assert.equal(ack.code,200);assert.equal(ack.removed,1);
 const abandoned=await scenario({pending:[{device_id:'browser-1',requested_at:stale}],
  devices:[{id:'browser-1',device_type:'browser',last_seen_at:stale}]});
 assert.equal(abandoned.code,200,'stale abandoned InPrivate session may release temporary Storage after cutoff');
 const newRequest=await scenario({pending:[{device_id:'browser-1',requested_at:fresh}],
  devices:[{id:'browser-1',device_type:'browser',last_seen_at:stale}]});
 assert.equal(newRequest.code,409,'new request cannot be dropped because last-seen heartbeat lags');
 const other=await scenario({pending:[{device_id:'browser-1',requested_at:fresh}],
  devices:[{id:'browser-1',device_type:'browser',active:false}]});
 assert.equal(other.code,200,'removed/inactive device must not block cleanup');
 const ipad=await scenario({devices:[{id:'ipad-1',device_type:'ipad'}]});
 assert.equal(ipad.code,409);assert.equal(ipad.data.error,'device_delivery_pending');
 const pdf=await scenario({photo:false,pending:[{device_id:'ipad-1',requested_at:fresh}],
  devices:[{id:'ipad-1',device_type:'ipad'}]});
 assert.equal(pdf.code,409);assert.equal(pdf.data.error,'pdf_delivery_pending');
 console.log('PASS v1.42 delete-verified: active browser waits for ACK; stale request expires; inactive ignored; iPad/PDF existing guards preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});

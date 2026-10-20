'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto,createHash}=require('node:crypto');
const source=fs.readFileSync('sentlog/peer-photo-recovery.js','utf8');
async function scenario({missing=false,corrupt=false,stale=false,inactive=false,archived=false,hidden=false,failUpload=false,failFinish=false,many=false}={}){
 const original=new Blob(['verified-photo']),hash=createHash('sha256').update('verified-photo').digest('hex');
 const asset={id:'a',project_id:'project',mime_type:'image/jpeg',byte_size:original.size,sha256:hash,metadata:{drawing_id:'drawing',photo_id:'photo'}};
 const files=new Map(missing?[]:[['photo:drawing:photo',corrupt?new Blob(['corrupt-photo!']):original]]),before=[...files];
 const calls=[],writes=[],messages=[],current=new Date().toISOString(),old='2020-01-01T00:00:00.000Z';
 let pending=true,published=false;
 const items=many?Array.from({length:1100},(_,i)=>({asset_id:'0'+String(i).padStart(5,'0'),device_id:'peer',expected_sha256:hash,requested_at:current})):[];
 items.push({asset_id:'a',device_id:'peer',expected_sha256:hash,requested_at:stale?old:current});
 const element=()=>({style:{},setAttribute(){},append(){},set textContent(x){messages.push(x);}});
 const session={access_token:'synthetic',expires_at:9999999999,user:{id:'owner'}};
 const ctx={Blob,File,Response,AbortController,Map,Set,Date,crypto:webcrypto,console,
   location:{pathname:'/sentlog/'},navigator:{onLine:true},
   document:{hidden,getElementById:()=>null,querySelector:()=>element(),createElement:element,addEventListener(){}},
   localStorage:{getItem:k=>k==='sentlogCloudDeviceV1'?'donor':k==='sentlogCloudSessionV1'?JSON.stringify(session):null},
   setTimeout(){},clearTimeout(){},setInterval(){},addEventListener(){},
   SentlogRecords:{ready:true},sentlogAppReady:new Promise(()=>{}),sentlogManagementSession:async()=>{},
   indexedDB:{open(){const q={};queueMicrotask(()=>{q.result={close(){},transaction(){return {objectStore(){return {get(k){const r={};queueMicrotask(()=>{r.result=files.get(k);r.onsuccess()});return r;}}}}}};q.onsuccess()});return q;}},
   fetch:async(url,options={})=>{
     const u=new URL(url),q=u.searchParams,body=options.body&&typeof options.body==='string'?JSON.parse(options.body):null;
     let result=[];calls.push(u.pathname);
     if(u.pathname.endsWith('/sentlog_pdf_requests')){
       result=pending?items:[];
       if(q.has('or')){const after=q.get('or').match(/asset_id.gt.([^,]+)/)[1];result=result.filter(r=>r.asset_id>after);}
       result=result.slice(0,Math.min(1000,Number(q.get('limit')||1000)));
     }else if(u.pathname.endsWith('/sentlog_devices'))result=q.has('id')||inactive?[]:[{id:'peer',device_type:'ipad',last_seen_at:stale?old:current}];
     else if(u.pathname.endsWith('/sentlog_projects'))result=q.has('id')||archived?[]:[{id:'project'}];
     else if(u.pathname.endsWith('/sentlog_assets'))result=!published&&q.get('id')?.includes('a')?[asset]:[];
     else if(u.pathname.endsWith('/rpc/sentlog_device_photo_redelivery_v1')){
       if(body.p_action==='claim'){writes.push('claim');result={claimed:true,token:'token',storage_path:'owner/project/device-redelivery/a/token.jpg'};}
       else {writes.push('finish');if(failFinish)throw TypeError('Load failed');published=true;result={published:true};}
     }else if(u.pathname.startsWith('/storage/v1/object/')){
       writes.push('upload');assert.equal(options.headers['x-upsert'],'false');
       assert.equal(createHash('sha256').update(Buffer.from(await options.body.arrayBuffer())).digest('hex'),hash);
       if(failUpload)throw TypeError('Load failed');result={};
     }else throw Error('Unexpected '+url);
     return new Response(JSON.stringify(result),{status:200});
   }
 };
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
 await ctx.sentlogCheckPeerPhotos();
 assert.deepEqual([...files],before,'source photo is never rewritten or deleted');
 return {calls,writes,messages,published};
}
(async()=>{
 const ok=await scenario();assert.deepEqual(ok.writes,['claim','upload','finish']);assert(ok.published);
 for(const args of [{missing:true},{corrupt:true},{stale:true},{inactive:true},{archived:true},{hidden:true}]){
   const r=await scenario(args);assert.equal(r.writes.length,0,JSON.stringify(args));
 }
 const uploadFailure=await scenario({failUpload:true});assert.deepEqual(uploadFailure.writes,['claim','upload']);assert(!uploadFailure.published);
 const finishFailure=await scenario({failFinish:true});assert(!finishFailure.published);assert(finishFailure.messages.some(x=>x.includes('Load failed')));
 const many=await scenario({many:true});assert(many.published,'requests after first 1000 are included');
 const page=fs.readFileSync('sentlog/index.html','utf8');
 assert(page.includes("['peer-photo-recovery.js?v=187','sentlogCheckPeerPhotos']"));
 assert(page.includes('src="./peer-photo-recovery.js?v=187"'));
 assert(fs.readFileSync('sentlog/sw.js','utf8').includes("'peer-photo-recovery.js'"));
 console.log('PASS device photo relay: verified local bytes, missing/corrupt/stale/inactive/archive guards, hidden pause, upload/finish failure, 1100+ request paging, no local writes, versioned boot/cache');
})().catch(e=>{console.error(e);process.exitCode=1});

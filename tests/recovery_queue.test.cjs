'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync('sentlog/recovery-queue.js','utf8');
const ctx=vm.createContext({Date,Map,Set,encodeURIComponent});
vm.runInContext(src+'\nglobalThis.queue={sentlogRecoveryRows,sentlogRecoveryRequests,sentlogRecoveryDevices,sentlogLiveRecoveryRequests};',ctx);
const q=ctx.queue;
const now=Date.parse('2026-11-25T00:00:00Z'),cutoff=now-15*60000;
const fresh=new Date(now).toISOString(),stale=new Date(now-86400000).toISOString();
const devices=[{id:'live',last_seen_at:fresh},{id:'older',last_seen_at:stale},{id:'self',last_seen_at:fresh}];
const rows=[];
for(let i=0;i<1501;i++)rows.push({asset_id:'a'+String(i).padStart(5,'0'),device_id:'live',kind:'photo',status:'storage_deleted',expected_sha256:'a',requested_at:stale});
rows.push({asset_id:'a01500',device_id:'older',kind:'photo',status:'storage_deleted',expected_sha256:'b',requested_at:fresh});
rows.push({asset_id:'b00000',device_id:'older',kind:'photo',status:'storage_deleted',requested_at:stale});
rows.push({asset_id:'b00001',device_id:'inactive',kind:'photo',status:'storage_deleted',requested_at:fresh});
rows.push({asset_id:'b00002',device_id:'self',kind:'photo',status:'storage_deleted',requested_at:fresh});
rows.push({asset_id:'b00003',device_id:'live',kind:'photo',status:'uploaded',requested_at:fresh});
rows.push({asset_id:'c00000',device_id:'live',kind:'drawing',status:'pc_verified',requested_at:fresh});
const calls=[];
async function api(path){
 const u=new URL('https://fixture.invalid/'+path),p=u.searchParams;calls.push(path);
 if(u.pathname.endsWith('sentlog_devices'))return devices;
 assert.equal(p.get('order'),'asset_id.asc,device_id.asc');
 assert(p.get('select').includes('sentlog_assets!inner'));
 let v=rows.filter(r=>r.kind===p.get('sentlog_assets.kind')?.slice(3));
 if(p.has('sentlog_assets.status'))v=v.filter(r=>r.status===p.get('sentlog_assets.status').slice(3));
 if(p.has('device_id'))v=v.filter(r=>p.get('device_id').slice(4,-1).split(',').includes(r.device_id));
 if(p.has('requested_at'))v=v.filter(r=>r.requested_at>=p.get('requested_at').slice(4));
 if(p.has('or')){
  const m=p.get('or').match(/^\(asset_id\.gt\.([^,]+),and\(asset_id\.eq\.([^,]+),device_id\.gt\.([^)]+)\)\)$/);
  assert(m);assert.equal(m[1],m[2]);
  v=v.filter(r=>r.asset_id>m[1]||(r.asset_id===m[1]&&r.device_id>m[3]));
 }
 return v.sort((a,b)=>a.asset_id.localeCompare(b.asset_id)||a.device_id.localeCompare(b.device_id)).slice(0,Number(p.get('limit')));
}
(async()=>{
 const map=await q.sentlogRecoveryDevices(api);
 const eligible=await q.sentlogLiveRecoveryRequests(api,'photo',map,{self:'self',cutoff,missingOnly:true});
 assert.equal(eligible.length,1502,'all pages plus newly requested item from previously offline device');
 assert(eligible.some(r=>r.device_id==='older'&&r.asset_id==='a01500'));
 assert(eligible.every(r=>['older','live'].includes(r.device_id)&&r.status==='storage_deleted'));
 assert.equal(new Set(eligible.map(r=>r.asset_id+':'+r.device_id)).size,1502);
 assert(calls.filter(x=>x.startsWith('sentlog_pdf_requests')).every(x=>x.includes('device_id=in.')));
 const pdf=await q.sentlogRecoveryRequests(api,'drawing');
 assert.equal(pdf.length,1);assert.equal(pdf[0].kind,'drawing');
 const count=calls.length;
 assert.equal((await q.sentlogRecoveryRequests(api,'photo',{deviceIds:[]})).length,0);assert.equal(calls.length,count);
 await assert.rejects(q.sentlogRecoveryRows(async()=>[{id:'a'},{id:'a'}],'x','select=id',['id']),/一覧の続きを/);
 // The same asset can have multiple recipients across a page boundary.
 const multi=[{asset_id:'a',device_id:'1'},{asset_id:'a',device_id:'2'},{asset_id:'b',device_id:'1'}];
 let i=0;const pages=await q.sentlogRecoveryRows(async()=>[multi[i++]].filter(Boolean),'x','select=asset_id,device_id',['asset_id','device_id'],1);
 assert.equal(pages.length,3);
 console.log('PASS recovery inventory: 1500+ rows, composite paging, fresh/live recipient selection, no offline/self/uploaded photo resend, PDF kind isolation, duplicate cursor rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});

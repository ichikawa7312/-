'use strict';
// Test the exact final-built PC inventory; no real network or folder.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('sentlog-pc/index.html','utf8');
const start=code.indexOf('let pcPendingRows=new Map()'),end=code.indexOf('async function downloadAsset(a){',start);
assert(start>=0&&end>start);
const source=code.slice(start,end);
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const project=id(9999),owner=id(8888),device=id(7777);
const items=Array.from({length:401},(_,i)=>({id:id(i+1),project_id:project,kind:'photo',status:'uploaded',pcReceiptVerified:false,sha256:'a'.repeat(64),byte_size:100}));
function fixture(mode='normal',rows=items){
 const calls=[],elements=new Map();
 const $=key=>{if(!elements.has(key))elements.set(key,{textContent:''});return elements.get(key);};
 const context=vm.createContext({Map,Set,Date,Number,String,Array,JSON,Error,Promise,console,$,enc:encodeURIComponent,
  session:{user:{id:owner}},localStorage:{getItem:()=>device},
  rest:async(path,options={})=>{
   calls.push(path);
   if(path.endsWith('sentlog_archive_v1'))return [{id:project,status:'active'},{id:id(9998),status:'archived'},{id:id(9997),status:'active',retired:true}];
   if(path.endsWith('sentlog_pc_inventory_v1')){
    if(mode==='outage')throw Error('connection timeout');
    if(mode==='legacy')throw Error('Could not find the function public.sentlog_pc_inventory_v1 in the schema cache');
    const args=JSON.parse(options.body);assert.deepEqual(args.p_project_ids,[project]);
    let page=rows.filter(r=>!args.p_after||r.id>args.p_after).slice(0,args.p_limit);
    if(mode==='bad')page=[{...items[0],project_id:id(1)}];
    if(mode==='changed')context.session={user:{id:id(1111)}};
    return {schema:1,rows:page,retainedDrawings:234,retainedPhotos:5026,pendingBackups:rows.length,cloudMissing:3,cloudMissingBytes:10000,cloudMissingWithoutReceipt:0};
   }
   if(mode==='legacy'&&path.includes('sentlog_assets?'))return [];
   throw Error('Unexpected '+path);
  }});
 vm.runInContext(source,context);
 return {context,calls,elements};
}
(async()=>{
 const a=fixture();const rows=await a.context.pendingAssets();assert.equal(rows.length,401);
 assert.equal(a.calls.filter(p=>p.endsWith('sentlog_pc_inventory_v1')).length,3);
 assert.equal(a.calls.filter(p=>p.includes('sentlog_pc_receipts?')||p.includes('sentlog_assets?')).length,0);
 assert.equal(a.elements.get('pendingCount').textContent,'401');
 assert.match(a.elements.get('pendingDetail').textContent,/写真クラウド保持中（PC同期済み）：5026件/);
 assert.match(a.elements.get('pendingDetail').textContent,/クラウド補完待ち：3件/);
 const empty=fixture('normal',[]);assert.equal((await empty.context.pendingAssets()).length,0);assert.equal(empty.calls.length,2);
 const down=fixture('outage');await assert.rejects(down.context.pendingAssets(),/timeout/);assert.equal(down.calls.length,2);
 const bad=fixture('bad');await assert.rejects(bad.context.pendingAssets(),/一覧が一致/);
 const changed=fixture('changed');await assert.rejects(changed.context.pendingAssets(),/ログインまたは端末/);
 const old=fixture('legacy');assert.equal((await old.context.pendingAssets()).length,0);await old.context.pendingAssets();
 assert.equal(old.calls.filter(p=>p.endsWith('sentlog_pc_inventory_v1')).length,1);
 assert.match(old.elements.get('pendingDetail').textContent,/クラウド補完待ち：未確認/);
 // The active-PC loop may still call its legacy helper in older builds,
 // but this built loop must retain rather than issue a cloud removal.
 const sync=code.slice(code.indexOf('async function syncOnce(){'),code.indexOf('function start(){'));
 assert(sync.includes('await retainActiveMedia(a)'));assert(!sync.includes('await deleteVerified(a)'));
 assert(sync.includes("a.status==='uploaded'||!a.pcReceiptVerified"));
 console.log('PASS compact PC inventory: 401 pending rows, 5,026 retained photos excluded, empty queue 2 calls, strict fallback and scope checks, missing cloud count shown, active retention');
})().catch(e=>{console.error(e);process.exitCode=1;});

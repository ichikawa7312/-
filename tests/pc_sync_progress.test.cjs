'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('sentlog/pc-sync-progress.txt','utf8');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const asset=n=>({id:id(n),project_id:'active',kind:'photo',file_name:'photo-'+n+'.jpg',sha256:'a'.repeat(64),byte_size:123,status:'uploaded'});
function setup(initial,receipts=[],failureId=''){
 let rows=initial.map(a=>({...a}));const saved=new Set(receipts);const elements=new Map(),events=[],counts=[],queries=[];
 const $=key=>{if(!elements.has(key))elements.set(key,{textContent:''});return elements.get(key)};
 const ctx=vm.createContext({console,Map,Set,Date,Number,String,Error,Array,Promise,busy:false,$,enc:encodeURIComponent,log:m=>events.push(m),setSync:(t,c)=>events.push([t,c]),ensureSession:async()=>{},ensureDevice:async()=>{},permission:async()=>true,
 rest:async path=>{queries.push(path);if(path.includes('/rpc/'))return [{id:'active',status:'active'},{id:'archive',status:'archived'},{id:'retired',status:'active',retired:true}];
  if(path.includes('sentlog_assets?')){const after=decodeURIComponent(path.match(/&id=gt\.([^&]+)/)?.[1]||'');return rows.filter(a=>a.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,400)}
  if(path.includes('sentlog_pc_receipts?')){const ids=path.match(/in\.\((.*?)\)/)[1].split(',');return rows.filter(a=>ids.includes(a.id)&&saved.has(a.id)).map(a=>({asset_id:a.id,sha256:a.sha256,byte_size:a.byte_size}))}
  throw Error('Unexpected path '+path);},
 saveVerified:async a=>saved.add(a.id),
 deleteVerified:async a=>{if(a.id===failureId)throw Error('Failed to fetch');rows=rows.filter(r=>r.id!==a.id);counts.push($('pendingCount').textContent)}
 });
 vm.runInContext(source,ctx);return {ctx,elements,events,counts,queries,read:()=>rows};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
(async()=>{
 await test('pending list pages beyond 1000 rows',async()=>{const s=setup(Array.from({length:1007},(_,i)=>asset(i+1)));const rows=await s.ctx.pendingAssets();assert.equal(rows.length,1007);assert.equal(s.elements.get('pendingCount').textContent,'1007');assert.equal(s.queries.filter(q=>q.includes('sentlog_assets?')).length,3)});
 await test('PC-verified redelivery is separate from unsaved inventory',async()=>{const s=setup([asset(1),asset(2),asset(3)],[id(1),id(2)]);await s.ctx.pendingAssets();assert.match(s.elements.get('pendingDetail').textContent,/PC保存・照合待ち：1件/);assert.match(s.elements.get('pendingDetail').textContent,/PC保存記録あり（配信・整理待ち）：2件/)});
 await test('archived projects are excluded',async()=>{const s=setup([asset(1),{...asset(2),project_id:'archive'},{...asset(3),project_id:'retired'}]);const rows=await s.ctx.pendingAssets();assert.equal(rows.length,1)});
 await test('pending count changes after each confirmed cloud cleanup',async()=>{const s=setup([asset(1),asset(2),asset(3)]);await s.ctx.syncOnce();assert.deepEqual(s.counts,['3','2','1']);assert.equal(s.elements.get('pendingCount').textContent,'0');assert.equal(s.events.at(-1)[1],'ok')});
 await test('failed item remains pending and status is not success',async()=>{const s=setup([asset(1),asset(2)],[],id(1));await s.ctx.syncOnce();assert.equal(s.elements.get('pendingCount').textContent,'1');assert.equal(s.events.at(-1)[1],'warn');assert.match(s.events.at(-1)[0],/未完了/);assert.equal(s.read()[0].id,id(1))});
 await test('auth rejection stops the current batch without erasing inventory',async()=>{const s=setup([asset(1),asset(2)]);let checks=0;s.ctx.ensureSession=async()=>{if(++checks>1){const e=Error('re-login');e.code='REAUTH_REQUIRED';throw e}};await s.ctx.syncOnce();assert.equal(s.read().length,2);assert.equal(s.events.filter(Array.isArray).at(-1)[1],'err');assert.equal(s.ctx.busy,false)});
 await test('stopped PC registration blocks inventory and file operations',async()=>{const s=setup([asset(1)]);s.ctx.ensureDevice=async()=>{throw Error('device stopped')};await s.ctx.syncOnce();assert.equal(s.queries.length,0);assert.equal(s.read().length,1);assert.equal(s.events.filter(Array.isArray).at(-1)[1],'err')});
 const built='sentlog-pc/index.html';
 if(fs.existsSync(built))await test('built integration includes guard, lazy download, valid scripts',async()=>{
  const pc=fs.readFileSync(built,'utf8'),cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8'),index=fs.readFileSync('sentlog/index.html','utf8');
  assert.match(pc,/session-guard\.js\?v=189/);assert.match(index,/session-guard\.js\?v=189/);assert.match(cloud,/sessionGuard\.ensure/);assert.match(cloud,/async function readSyncResponse/);
  assert.match(pc,/if\(!ok\)\{const blob=await downloadAsset\(a\)/);
  assert.ok(!pc.includes('async function saveVerified(a){\n  const blob=await downloadAsset(a);'));
  for(const m of pc.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
  assert.match(cloud,/同期は完了していません/);
 });
 console.log(`${passed} PC progress scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1});

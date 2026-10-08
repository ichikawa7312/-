'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),C=require('../sentlog/archive-core.js');
const s=fs.readFileSync('sentlog/cloud-sync.js','utf8');
const code=s.slice(s.indexOf('async function pullRemoteProjects('),s.indexOf('\nfunction modalHtml()'));
async function run(manualProject=null,checking=false,fail=false){
  const controls=[{id:'active',client_key:'a',status:'active',checking},{id:'archived',client_key:'b',status:'archived'}];
  const projects=[{id:'a',drawings:[{id:'da'}]},{id:'b',drawings:[{id:'db'}]}];const events=[];
  const archive={refresh:async()=>{if(fail)throw Error('offline');},canSync:(cp,m)=>C.maySync(controls.find(c=>c.id===cp.id),m),includeLocal:(id,m)=>C.maySync(controls.find(c=>c.client_key===id),m)};
  const ctx=vm.createContext({archive,console,Set,JSON,Number,Date,session:{},syncing:false,navigator:{onLine:true},
    enc:encodeURIComponent,msg(){},syncStatus:{begin:()=>1,finish:(_,r)=>events.push(['status',r.level])},
    rest:async path=>path.includes('sentlog_projects?')?controls:[{revision:1,payload:{project:{}}}],
    workspace:()=>({projects}),getSyncMeta:()=>({revision:1}),
    pullProjectAssets:async cp=>{events.push(['download',cp.id]);return 0;},
    ensureSession:async()=>{},ensureDevice:async()=>'device',
    ensureCloudProject:async lp=>controls.find(c=>c.client_key===lp.id),
    upsertSnapshot:async cp=>{events.push(['snapshot',cp.id]);return {skipped:true};},
    collectDrawings:lp=>lp.drawings,collectPhotos:lp=>[{id:'photo-'+lp.id}],
    uploadDrawing:async cp=>{events.push(['uploadPDF',cp.id]);return {status:'exists'};},
    uploadPhoto:async cp=>{events.push(['uploadPhoto',cp.id]);return {status:'exists'};},
    window:{sentlogAppReady:Promise.resolve(),SentlogRecords:{settled:async()=>{},assertSafe(){}}}});
  vm.runInContext(code,ctx);await ctx.syncNow(manualProject?{manualProject}:{});return events;
}
(async()=>{
  let e=await run();assert(e.some(x=>x[0]==='download'&&x[1]==='active'));assert(!e.some(x=>x[1]==='archived'));
  console.log('PASS integrated cloud loop: archived projects excluded from automatic upload AND download');
  e=await run('archived');assert(e.some(x=>x[0]==='download'&&x[1]==='archived'));assert(!e.some(x=>x[1]==='active'));assert(!e.some(x=>x[0].startsWith('upload')||x[0]==='snapshot'));
  console.log('PASS integrated cloud loop: manual archived request only reads selected project, never publishes empty state');
  e=await run(null,true);assert(!e.some(x=>x[0]==='download'||x[0]==='snapshot'||x[0].startsWith('upload')));
  console.log('PASS integrated cloud loop: archive verification pauses transfers');
  e=await run(null,false,true);assert.deepEqual(e,[['status','error']]);
  console.log('PASS integrated cloud loop: unavailable archive controls fail closed before transfer');
  const pdf=fs.readFileSync('sentlog/pdf-recovery.js','utf8');
  assert(pdf.includes('allowed(a.project_id)&&a.metadata?.drawing_id'));
  assert(pdf.includes('if(!allowed(a.project_id)||!a.metadata?.drawing_id'));
  console.log('PASS PDF integration points: both sender and receiver share the lifecycle guard');
})().catch(e=>{console.error(e);process.exitCode=1;});

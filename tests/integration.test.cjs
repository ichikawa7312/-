'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),C=require('../sentlog/archive-core.js');
const s=fs.readFileSync('sentlog/cloud-sync.js','utf8');
const code=s.slice(s.indexOf('async function pullRemoteProjects('),s.indexOf('\nfunction modalHtml()'));
async function run(manualProject=null,checking=false,fail=false){
  if(s.includes('collaboration-sync-v1')){
    const {fixture}=require('./edit_sync_integration.test.cjs'),f=fixture();
    f.controls[0].checking=checking;f.controls[1].status='archived';f.failures.archive=fail;f.context.archive.ready=false;
    await f.api.syncNow(manualProject?{force:true,manualProject:'cloud-c'}:{force:true});
    const events=f.events.filter(e=>['download','snapshot','uploadPDF','uploadPhoto','status'].includes(e[0]))
      .map(e=>[e[0],e[1]==='cloud-a'?'active':e[1]==='cloud-c'?'archived':e[1],...e.slice(2)]);
    f.stop();return events;
  }

  const controls=[{id:'active',client_key:'a',status:'active',checking},{id:'archived',client_key:'b',status:'archived'}];
  const projects=[{id:'a',drawings:[{id:'da'}]},{id:'b',drawings:[{id:'db'}]}];const events=[];
  const archive={refresh:async()=>{if(fail)throw Error('offline');},canSync:(cp,m)=>C.maySync(controls.find(c=>c.id===cp.id),m),includeLocal:(id,m)=>C.maySync(controls.find(c=>c.client_key===id),m)};
  const ctx=vm.createContext({archive,editSync:{wake(){}},syncErrorNotBefore:0,knownCloudProjects:new Map(),console,Set,JSON,Number,Date,session:{},syncing:false,navigator:{onLine:true},
    enc:encodeURIComponent,msg(){},syncStatus:{begin:()=>1,finish:(_,r)=>events.push(['status',r.level])},
    rest:async path=>path.includes('sentlog_projects?')?controls:[{revision:1,payload:{project:{}}}],
    workspace:()=>({projects}),getSyncMeta:()=>({revision:1,base_snapshot:{project:{}}}),
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
async function pdfRound({pc=false,checking=false,archiveReady=true,registered=true}={}){
  const pdf=fs.readFileSync('sentlog/pdf-recovery.js','utf8');
  const start=pdf.indexOf('async function run(){'),end=pdf.indexOf('\nif(!IS_PC)await window.sentlogAppReady;',start);
  assert(start>=0&&end>start,'production PDF recovery entry point must be present');
  const controls=[{id:'active',status:'active',checking},{id:'archived',status:'archived'}],events=[];
  const assets=[['asset-active','active','drawing-active'],['asset-archived','archived','drawing-archived'],
    ['asset-foreign','foreign','drawing-foreign'],['asset-unmapped','active',null]].map(([id,project_id,drawing_id])=>({
      id,project_id,metadata:drawing_id?{drawing_id}:{},sha256:'a'.repeat(64),byte_size:4,status:'storage_deleted',storage_path:'synthetic/'+id}));
  const requests=assets.map(a=>({asset_id:a.id,device_id:'peer',expected_sha256:a.sha256,requested_at:new Date().toISOString()}));
  const api=async path=>{
    if(path.startsWith('sentlog_devices?id='))return registered?[{id:'self',active:true}]:[{id:'self',active:false}];
    if(path.startsWith('sentlog_devices?'))return [{id:'peer',active:true,last_seen_at:new Date().toISOString()}];
    if(path.startsWith('sentlog_assets?'))return assets;
    if(path.startsWith('sentlog_pdf_requests?'))return requests;
    if(path==='rpc/sentlog_archive_v1')return controls;
    throw Error('Unexpected PDF operation '+path);
  };
  const ctx=vm.createContext({IS_PC:pc,busy:false,navigator:{onLine:true},document:{hidden:false},console,Set,Map,Date,Blob,
    window:{SentlogRecords:{ready:true,deltaJournal:{listBindingStatesSync:()=>[],assertLegacyPdfReceive:async()=>true}},
      SentlogArchive:{ready:archiveReady,isAuto:id=>C.maySync(controls.find(c=>c.id===id),null)}},
    session:()=>({access_token:'synthetic',user:{id:'owner'}}),device:()=>'self',enc:encodeURIComponent,api,
    drawingIds:()=>new Set(['drawing-active','drawing-archived','drawing-foreign']),
    supply:async a=>{events.push(['supply',a.project_id]);return true;},
    localFile:async a=>{events.push(['read',a.project_id]);return new Blob(['pdf']);},matches:async()=>true,
    acknowledge:async a=>events.push(['ack',a.project_id]),status:()=>{},panels:()=>[]});
  vm.runInContext(fs.readFileSync('sentlog/recovery-throttle.js','utf8'),ctx);
  vm.runInContext(fs.readFileSync('sentlog/recovery-queue.js','utf8'),ctx);
  // This lifecycle fixture evaluates the real run() in isolation. Include its
  // actual storage-failure and handover helpers when present. Their transaction
  // races are exercised with real Records in the dedicated PDF guard fixtures.
  const storageHelperStart=pdf.indexOf('const PDF_STORAGE_FAILED_STATUS=');
  const helperStart=storageHelperStart>=0?storageHelperStart:pdf.indexOf('const PDF_HANDOVER_STATUS=');
  if(helperStart>=0){
    const helperEnd=pdf.indexOf('\nfunction session()',helperStart),fileKey=pdf.match(/^const fileKey=.*;$/m);
    assert(helperEnd>helperStart&&fileKey,'production PDF handover dependencies must be present');
    vm.runInContext(pdf.slice(helperStart,helperEnd)+'\n'+fileKey[0],ctx);
  }
  vm.runInContext('const deliveryGuard=createSentlogDeliveryGuard();const receiveGuard=createSentlogDeliveryGuard({maxPerCycle:8,cooldownMs:0});\n'+pdf.slice(start,end),ctx);
  await ctx.run();return events;
}
(async()=>{
  let e=await run();assert(e.some(x=>x[0]==='download'&&x[1]==='active'));assert(!e.some(x=>x[1]==='archived'));
  console.log('PASS integrated cloud loop: archived projects excluded from automatic upload AND download');
  e=await run('archived');assert(e.some(x=>x[0]==='download'&&x[1]==='archived'));assert(!e.some(x=>x[1]==='active'));assert(!e.some(x=>x[0].startsWith('upload')||x[0]==='snapshot'));
  console.log('PASS integrated cloud loop: manual archived request only reads selected project, never publishes empty state');
  e=await run(null,true);assert(!e.some(x=>x[0]==='download'||x[0]==='snapshot'||x[0].startsWith('upload')));
  console.log('PASS integrated cloud loop: archive verification pauses transfers');
  e=await run(null,false,true);assert(e.length&&e.every(x=>x[0]==='status'&&x[1]==='error'),'unavailable archive controls must stop before any transfer');
  console.log('PASS integrated cloud loop: unavailable archive controls fail closed before transfer');
  e=await pdfRound();assert.deepEqual(e,[['supply','active'],['read','active'],['ack','active']]);
  console.log('PASS actual PDF sender and receiver exclude archived, unknown and unmapped assets');
  assert.deepEqual(await pdfRound({checking:true}),[]);
  assert.deepEqual(await pdfRound({archiveReady:false}),[]);
  assert.deepEqual(await pdfRound({registered:false}),[]);
  console.log('PASS actual PDF recovery stops before file I/O during archive checking, unavailable controls or a stopped device');
  assert.deepEqual(await pdfRound({pc:true}),[['supply','active']]);assert.deepEqual(await pdfRound({pc:true,checking:true}),[]);
  console.log('PASS actual PC PDF sender uses server lifecycle controls and never reads archived or checking projects');
})().catch(e=>{console.error(e);process.exitCode=1;});

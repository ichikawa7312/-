'use strict';
// Run the real recovery poll, display-restoration entry point and editing guard.
// All file bytes, records and network responses are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');

async function fixture({source='image',visible=true}={}){
  const file=new File(['synthetic-background-bytes'],source==='pdf'?'drawing.pdf':'drawing.jpg',
    {type:source==='pdf'?'application/pdf':'image/jpeg'});
  const digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',await file.arrayBuffer())).toString('hex');
  const asset={id:'asset',project_id:'cloud-project',kind:'drawing',status:'uploaded',
    file_name:file.name,mime_type:file.type,byte_size:file.size,sha256:digest,
    metadata:{drawing_id:'drawing'},storage_path:'owner/project/drawing'};
  const project={id:'project',drawings:[{id:'drawing'}]};
  const local={sentlogCloudSessionV1:JSON.stringify({access_token:'synthetic',expires_at:9999999999,user:{id:'owner'}}),
    sentlogCloudDeviceV1:'device'};
  const files=new Map([['background:drawing',file]]),opens=[],requests=[],intervals=[];
  const context=vm.createContext({
    console,Blob,File,Response,AbortController,crypto:webcrypto,queueMicrotask,
    location:{pathname:'/sentlog/'},navigator:{onLine:true,userAgent:'Desktop test'},
    matchMedia:()=>({matches:false}),setTimeout:()=>0,clearTimeout(){},setInterval:(fn,ms)=>intervals.push({fn,ms}),
    addEventListener(){},document:{hidden:false,activeElement:null,querySelector:()=>null,
      getElementById:()=>null,addEventListener(){}},
    localStorage:{getItem:k=>local[k]||null},
    SentlogRecords:{ready:true,getItem:()=>JSON.stringify({projects:[project]})},
    SentlogArchive:{ready:true,isAuto:id=>id===asset.project_id},
    sentlogAppReady:Promise.resolve(),
    currentView:'editor',activeProjectId:'project',activeDrawingId:'drawing',
    empty:{style:{display:visible?'none':'grid'}},loading:{style:{display:'none'}},
    pdfDoc:source==='pdf'&&visible?{}:null,scale:2.75,tx:-140,ty:85,
    selected:'shape',drawing:null,panStart:null,labelDrag:null,activeTouches:new Map(),
    state:{sourceType:source,currentPage:1,shapes:[{id:'shape',type:'ひび割れ',photos:[{id:'photo'}]}]},
    $:()=>null,addPhotosToSelected:async()=>{},persist(){},
    openFile:async function(blob,save){
      opens.push({blob,save});context.loading.style.display='grid';
      try{
        if(context.waitForOpen)await context.waitForOpen;
        if(context.failOpen)throw Error('synthetic load failure');
        context.scale=.25;context.tx=10;context.ty=20;
        context.empty.style.display='none';
        if(source==='pdf')context.pdfDoc={};
      }finally{context.loading.style.display='none';}
    },
    indexedDB:{open(){
      const request={};
      queueMicrotask(()=>{
        request.result={close(){},transaction(){
          const transaction={objectStore:()=>({get(key){
            const result={};queueMicrotask(()=>{
              result.result=files.get(key);result.onsuccess();
              queueMicrotask(()=>transaction.oncomplete());
            });return result;
          }})};return transaction;
        }};request.onsuccess();
      });return request;
    }},
    fetch:async url=>{
      requests.push(String(url));let data;
      if(url.includes('/sentlog_devices?'))data=[{id:'device',active:true}];
      else if(url.includes('/sentlog_projects?'))data=[{id:asset.project_id}];
      else if(url.includes('/sentlog_assets?'))data=[asset];
      else if(url.includes('/sentlog_pdf_requests?'))data=[];
      else if(url.includes('/rpc/sentlog_ack_pdf'))data={received:true};
      else throw Error('Unexpected network request: '+url);
      return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
    }
  });
  context.window=context;
  vm.runInContext(fs.readFileSync('sentlog/phone-runtime.js','utf8'),context);
  vm.runInContext(fs.readFileSync('sentlog/sync-view.js','utf8'),context);
  await vm.runInContext('(async()=>{'+fs.readFileSync('sentlog/pdf-recovery.js','utf8')+'\n})()',context);
  return {context,file,opens,requests,intervals,poll:()=>context.sentlogCheckPdfRecovery()};
}

(async()=>{
  for(const source of ['image','pdf']){
    const f=await fixture({source});
    const original=JSON.stringify(f.context.state),selection=f.context.selected;
    const poll=f.intervals.find(x=>x.ms===10000);
    assert(poll,'the real ten-second recovery timer must remain enabled');
    for(let i=0;i<4;i++)await poll.fn();
    assert.equal(f.opens.length,0,'a displayed '+source+' must not reopen on recovery polls');
    assert.deepEqual([f.context.scale,f.context.tx,f.context.ty],[2.75,-140,85],
      'background checks must preserve zoom and pan');
    assert.equal(JSON.stringify(f.context.state),original,'annotations and attached photo references must be preserved');
    assert.equal(f.context.selected,selection,'selection must be preserved');
    assert.equal(f.context.loading.style.display,'none');
    assert(f.requests.some(x=>x.includes('/rpc/sentlog_ack_pdf')),'verified-file acknowledgement still runs');

    const missing=await fixture({source,visible:false});
    for(let i=0;i<3;i++)await missing.poll();
    assert.equal(missing.opens.length,1,'a missing '+source+' is restored once');
    assert.equal(missing.opens[0].save,false,'recovery must not replace the stored original');
    assert.equal(await missing.opens[0].blob.text(),await missing.file.text());
  }
  console.log('PASS recovery polling: visible JPEG/PDF retain zoom, pan, selection and photos; missing backgrounds restore once');

  for(const [name,block,unblock] of [
    ['manager view',c=>{c.currentView='drawings'},c=>{c.currentView='editor'}],
    ['another drawing',c=>{c.activeDrawingId='other'},c=>{c.activeDrawingId='drawing'}],
    ['existing load',c=>{c.loading.style.display='grid'},c=>{c.loading.style.display='none'}],
    ['drawing gesture',c=>{c.drawing={}},c=>{c.drawing=null}],
    ['pan gesture',c=>{c.panStart={}},c=>{c.panStart=null}],
    ['touch gesture',c=>{c.activeTouches.set(1,{})},c=>{c.activeTouches.clear()}],
    ['text draft',c=>{c.document.activeElement={matches:()=>true}},c=>{c.document.activeElement=null}],
    ['shape editing',c=>{c.SentlogShapeMove={isEditing:()=>true}},c=>{c.SentlogShapeMove=null}],
  ]){
    const f=await fixture({visible:false});block(f.context);await f.poll();
    assert.equal(f.opens.length,0,name+' must defer recovery');
    unblock(f.context);await f.poll();assert.equal(f.opens.length,1,name+' may recover after it finishes');
  }
  console.log('PASS restoration waits for the selected editor and idle input, gestures and loading');

  const concurrent=await fixture({visible:false});let release;
  concurrent.context.waitForOpen=new Promise(resolve=>{release=resolve});
  const first=concurrent.context.sentlogRestoreDrawingView('drawing',concurrent.file);
  await Promise.resolve();
  await concurrent.context.sentlogRestoreDrawingView('drawing',concurrent.file);
  assert.equal(concurrent.opens.length,1,'overlapping recovery callbacks cannot start another load');
  release();await first;
  const retry=await fixture({visible:false});retry.context.failOpen=true;
  await assert.rejects(retry.context.sentlogRestoreDrawingView('drawing',retry.file),/synthetic load failure/);
  retry.context.failOpen=false;await retry.context.sentlogRestoreDrawingView('drawing',retry.file);
  assert.equal(retry.opens.length,2,'a failed load must release the recovery latch for a later retry');
  console.log('PASS concurrent recovery is serialized and a failed load can retry');
})().catch(e=>{console.error(e);process.exitCode=1;});

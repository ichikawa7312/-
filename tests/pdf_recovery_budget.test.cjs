'use strict';
// Execute the actual production-built PDF recovery module, with synthetic HTTP
// and disposable IndexedDB. All receipt, SHA and durable-readback code is real.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBObjectStore}=require('fake-indexeddb');
const source=fs.readFileSync('sentlog/pdf-recovery.js','utf8');
assert(source.includes('const receiveGuard=createSentlogDeliveryGuard({maxPerCycle:8,cooldownMs:0});'),
  'Run this regression against the production-equivalent build');
const sha=async blob=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
async function open(factory){return new Promise((resolve,reject)=>{
  const q=factory.open('surveyFieldNoteDB',2);q.onupgradeneeded=()=>q.result.createObjectStore('files');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
});}
async function fixture(sizes,{missing=new Set(),corruptLocal=new Set(),corruptDownloads=new Set()}={}){
  const factory=new IDBFactory(),assets=[],blobs=new Map(),cached=new Map(),requests=[],receipts=[],warnings=[],reads=[],writes=[];
  let hashCalls=0,owner='synthetic-owner';
  for(let index=0;index<sizes.length;index++){
    const id=String(index).padStart(3,'0'),size=sizes[index];
    let blob=cached.get(size);if(!blob){blob=new Blob([new Uint8Array(size).fill(7)],{type:'application/pdf'});cached.set(size,blob);}
    const asset={id,project_id:'project',status:'uploaded',file_name:id+'.pdf',mime_type:'application/pdf',byte_size:size,
      sha256:await sha(blob),storage_path:'owner/project/'+id,metadata:{drawing_id:id}};assets.push(asset);blobs.set(id,blob);
  }
  const db=await open(factory);try{await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readwrite');
    for(const a of assets)if(!missing.has(a.id))tx.objectStore('files').put(corruptLocal.has(a.id)?
      new Blob([new Uint8Array(a.byte_size).fill(9)],{type:'application/pdf'}):blobs.get(a.id),'background:'+a.id);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  const recordGet=IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get=function(key){if(this.name==='files'&&String(key).startsWith('background:'))reads.push(String(key).slice(11));return recordGet.call(this,key);};
  const context={location:{pathname:'/sentlog/'},Blob,File,AbortController,Uint8Array,TextEncoder,ArrayBuffer,URL,Response,indexedDB:factory,
    crypto:{subtle:{digest:async(...args)=>{hashCalls++;return webcrypto.subtle.digest(...args);}}},
    console:{warn:(...args)=>warnings.push(args),log(){},error:(...args)=>warnings.push(args)},
    navigator:{onLine:true},document:{hidden:false,querySelector:()=>null,getElementById:()=>null,addEventListener(){}},
    localStorage:{getItem:key=>key==='sentlogCloudSessionV1'?JSON.stringify({access_token:'synthetic-token',user:{id:owner}}):key==='sentlogCloudDeviceV1'?'synthetic-device':null},
    setTimeout,clearTimeout,setInterval:()=>1,window:null,
    fetch:async url=>{
      const parsed=new URL(url),path=parsed.pathname;requests.push({path,owner});
      if(path.includes('/storage/')){
        const id=path.split('/').at(-1),asset=assets.find(a=>a.id===id);
        assert(asset,'unknown download');return new Response(corruptDownloads.has(id)?new Blob([new Uint8Array(asset.byte_size).fill(9)],{type:'application/pdf'}):blobs.get(id));
      }
      const value=path.endsWith('/sentlog_devices')?[{id:'synthetic-device',active:true}]:path.endsWith('/sentlog_assets')?assets:
        path.endsWith('/sentlog_pdf_requests')?[]:null;
      assert.notEqual(value,null,'unexpected network path '+path);return new Response(JSON.stringify(value));
    }};
  const startupTimers=new Set();context.setTimeout=(fn,ms,...args)=>{
    // Module startup registration is observed without launching an additional
    // background cycle during this explicitly controlled test.
    if(ms===2500){startupTimers.add(fn);return 0;}return setTimeout(fn,ms,...args);
  };
  context.window=context;context.addEventListener=()=>{};context.sentlogAppReady=Promise.resolve();
  context.SentlogArchive={ready:true,isAuto:()=>true};
  context.SentlogSyncTraffic={ack:async(kind,a,id,send,options)=>{receipts.push({id:a.id,owner,force:options.force});return {received:true};},forget:async()=>{}};
  context.SentlogRecords={ready:true,getItem:()=>JSON.stringify({projects:[{id:'project',drawings:assets.map(a=>({id:a.id}))}]}),
    deltaJournal:{listBindingStatesSync:()=>[],assertLegacyPdfReceive:async()=>true},
    openFilesDatabase:()=>open(factory),writeFile:async(key,blob)=>{
      writes.push(key);const db=await open(factory);try{await new Promise((resolve,reject)=>{
        const tx=db.transaction('files','readwrite');tx.objectStore('files').put(blob,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      });}finally{db.close();}
    }};
  vm.createContext(context);
  if(fs.existsSync('sentlog/blob-sha256.js'))vm.runInContext(fs.readFileSync('sentlog/blob-sha256.js','utf8'),context);
  await vm.runInContext('(async()=>{'+source+'})()',context);
  const run=async()=>{reads.length=0;await context.sentlogCheckPdfRecovery();return [...reads];};
  return {assets,blobs,reads,writes,receipts,warnings,requests,context,run,setOwner:value=>owner=value,get hashCalls(){return hashCalls;},
    close(){IDBObjectStore.prototype.get=recordGet;}};
}
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
  await test('ordinary and manually requested polls read at most eight PDFs and rotate across every drawing',async()=>{
    const f=await fixture(Array(20).fill(64));try{
      const seen=new Set();for(let cycle=0;cycle<3;cycle++){const read=await f.run();assert.equal(read.length,8);for(const id of read)seen.add(id);}
      assert.equal(seen.size,20);assert.equal(f.receipts.length,24);assert.equal(f.writes.length,0);
    }finally{f.close();}
  });
  await test('eight MiB PDFs stay within 32 MiB per background turn while later drawings make progress',async()=>{
    const f=await fixture(Array(9).fill(8*1024*1024));try{
      const seen=new Set();for(let cycle=0;cycle<3;cycle++){
        const read=await f.run();assert.equal(read.length,4);assert.equal(read.reduce((n,id)=>n+f.assets.find(a=>a.id===id).byte_size,0),32*1024*1024);
        for(const id of read)seen.add(id);
      }assert.equal(seen.size,9);
    }finally{f.close();}
  });
  await test('one oversized PDF gets its own turn without starving the following small drawings',async()=>{
    const f=await fixture([33*1024*1024,64,64]);try{
      assert.deepEqual(await f.run(),['000']);assert.deepEqual(await f.run(),['001','002']);assert.deepEqual(await f.run(),['000']);
    }finally{f.close();}
  });
  await test('unchanged PDFs are freshly read and verified before receipts on every selected turn',async()=>{
    const f=await fixture([64,64]);try{
      assert.equal((await f.run()).length,2);const afterFirst=f.hashCalls;assert.equal(afterFirst,2);
      assert.equal((await f.run()).length,2);assert.equal(f.hashCalls-afterFirst,2);assert.equal(f.receipts.length,4);
    }finally{f.close();}
  });
  await test('same-size local corruption stays intact and gets no receipt or automatic overwrite',async()=>{
    const f=await fixture([64],{corruptLocal:new Set(['000'])});try{
      assert.deepEqual(await f.run(),['000']);assert.equal(f.receipts.length,0);assert.equal(f.writes.length,0);
      assert(!f.requests.some(r=>r.path.includes('/storage/')));
    }finally{f.close();}
  });
  await test('a corrupt download gets no save or receipt and a correct download is read back before ACK',async()=>{
    const f=await fixture([64,64],{missing:new Set(['000','001']),corruptDownloads:new Set(['000'])});try{
      assert.deepEqual(await f.run(),['000','001','001']);assert.deepEqual(f.writes,['background:001']);
      assert.deepEqual(f.receipts.map(r=>r.id),['001']);assert.equal(f.receipts[0].force,true);assert(f.warnings.length>0);
    }finally{f.close();}
  });
  await test('explicitly opening a drawing outside the current batch immediately verifies that exact PDF',async()=>{
    const f=await fixture(Array(20).fill(64));try{
      assert.deepEqual(await f.run(),['000','001','002','003','004','005','006','007']);f.reads.length=0;
      assert.equal(await f.context.sentlogRequestDrawingRecovery('019'),true);assert.deepEqual(f.reads,['019']);
      assert.equal(f.writes.length,0);
    }finally{f.close();}
  });
  await test('a new account starts an independent fair cursor rather than inheriting another account\'s progress',async()=>{
    const f=await fixture(Array(12).fill(64));try{
      const first=await f.run();f.setOwner('another-owner');assert.deepEqual(await f.run(),first);
      assert(f.receipts.slice(8).every(receipt=>receipt.owner==='another-owner'));
    }finally{f.close();}
  });
  console.log('PDF recovery budget cases passed:',passed);
})().catch(error=>{console.error(error);process.exitCode=1;});

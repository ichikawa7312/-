'use strict';
// Real PC photo worker, synthetic REST and File System Access handles only.
// Every fetch is intercepted: no production account, Storage or PC folder is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const source=fs.readFileSync('sentlog/photo-recovery.js','utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project='11111111-1111-4111-8111-111111111111';
const assetId='22222222-2222-4222-8222-222222222222';
const token='33333333-3333-4333-8333-333333333333';
const pcId='44444444-4444-4444-8444-444444444444';
const el=()=>({style:{},children:[],setAttribute(){},append(...x){this.children.push(...x)},prepend(...x){this.children.unshift(...x)}});
function fixture(config={}){
  const bytes=Buffer.from('verified PC file 日本語 📷'),sha=hash(bytes),messages=[],calls=[],uploads=[],timers=new Map();
  let seq=0,published=false,claimed=false;
  const local={sentlogCloudSessionV1:JSON.stringify({user:{id:owner},access_token:'synthetic',expires_at:9999999999}),sentlogPcWebDeviceV1:pcId};
  const asset={id:assetId,project_id:project,status:'storage_deleted',kind:'photo',mime_type:'image/jpeg',file_name:'検証.jpg',byte_size:bytes.length,sha256:sha,metadata:{drawing_id:'drawing',photo_id:'photo'}};
  const file=new File([config.corrupt?Buffer.alloc(bytes.length,0):bytes],'検証.jpg',{type:''});
  const directory={name:'検証保管',queryPermission:async()=>config.denied?'denied':'granted',
    getDirectoryHandle:async()=>directory,
    getFileHandle:async()=>{if(config.missing)throw new DOMException('missing','NotFoundError');return {getFile:async()=>file};}};
  const receipt={pc_path:'検証保管/2026/検証.jpg',byte_size:bytes.length,sha256:sha};
  if(config.badReceipt)receipt.sha256='b'.repeat(64);
  if(config.badSize)receipt.byte_size++;
  if(config.traversal)receipt.pc_path='検証保管/../検証.jpg';
  if(config.otherRoot)receipt.pc_path='別の保管/2026/検証.jpg';
  const context={console,Blob,File,Response,Date,URL,DOMException,AbortController,crypto:webcrypto,
    navigator:{onLine:!config.offline},location:{pathname:'/sentlog-pc/'},
    document:{hidden:!!config.hidden,getElementById:()=>null,querySelector:()=>el(),createElement:el,addEventListener(){}},
    localStorage:{getItem:k=>local[k]||null},idbGet:async()=>config.noRoot?null:directory,
    ensureSession:async()=>{},log:m=>messages.push(m),addEventListener(){},
    setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},
    fetch:async(url,options={})=>{
      const u=new URL(url),body=options.body&&typeof options.body==='string'?JSON.parse(options.body):null;
      calls.push({path:u.pathname,body,authorization:options.headers?.Authorization});
      let result=[];
      if(u.pathname.endsWith('/sentlog_pdf_requests'))result=[{asset_id:assetId,device_id:'receiver',expected_sha256:sha,requested_at:new Date().toISOString()}];
      else if(u.pathname.endsWith('/sentlog_devices'))result=[{id:'receiver',last_seen_at:new Date().toISOString()}];
      else if(u.pathname.endsWith('/sentlog_assets'))result=u.searchParams.has('id')?[]:[{...asset,status:published?'uploaded':'storage_deleted'}];
      else if(u.pathname.endsWith('/sentlog_projects'))result=config.archived?[]:[{id:project}];
      else if(u.pathname.endsWith('/sentlog_pc_receipts'))result=[receipt];
      else if(u.pathname.endsWith('/rpc/sentlog_claim_photo_redelivery')){
        if(config.declined||claimed)return new Response(JSON.stringify({claimed:false}),{status:200});
        claimed=true;
        let parts=[owner,project,'redelivery',assetId,token+'.jpg'];
        if(config.wrongOwner)parts[0]='other-owner';
        if(config.wrongProject)parts[1]='other-project';
        if(config.wrongAsset)parts[3]='other-asset';
        if(config.wrongToken)parts[4]='other-token.jpg';
        if(config.extraPath)parts.push('extra');
        if(config.switchAccount)local.sentlogCloudSessionV1=JSON.stringify({user:{id:'other-owner'},access_token:'other-synthetic',expires_at:9999999999});
        if(config.switchDevice)local.sentlogPcWebDeviceV1='other-device';
        result={claimed:true,token,storage_path:parts.join('/')};
      }else if(u.pathname.includes('/storage/v1/object/')){
        uploads.push(options);
        assert.equal(options.headers['x-upsert'],'false');
        assert.equal(hash(Buffer.from(await options.body.arrayBuffer())),sha);
        if(config.hangUpload)return new Promise((resolve,reject)=>{
          if(options.signal)options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
        });
        if(config.uploadFails)return new Response(JSON.stringify({error:'upload unavailable'}),{status:503});
        result={};
      }else if(u.pathname.endsWith('/rpc/sentlog_finish_photo_redelivery')){
        if(config.finishFails)return new Response(JSON.stringify({error:'finish unavailable'}),{status:503});
        if(config.falseFinish)result={published:false};
        else if(config.wrongFinish)result={published:true,asset_id:'other-asset'};
        else {result={published:true,asset_id:assetId};published=true;}
      }else throw Error('Unmocked request: '+u.pathname);
      return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
    }};
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return {context,calls,uploads,messages,timers,file,sha,run:()=>context.sentlogCheckPhotoRecovery(),get published(){return published;}};
}
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}}
const finishes=f=>f.calls.filter(c=>c.path.endsWith('/rpc/sentlog_finish_photo_redelivery'));
(async()=>{
  await check('PC file is read, hashed, sent with registered MIME and original remains intact',async()=>{
    const f=fixture();await f.run();assert.equal(f.uploads.length,1);assert(f.published);
    assert.equal(f.uploads[0].headers['Content-Type'],'image/jpeg');
    assert.equal(hash(Buffer.from(await f.file.arrayBuffer())),f.sha);assert.equal(finishes(f).length,1);
    await f.run();assert.equal(f.uploads.length,1,'published files are not sent again');
  });
  for(const option of ['denied','missing','noRoot','badReceipt','badSize','corrupt','traversal','otherRoot','archived','offline','hidden','declined'])
    await check(option+': local source and receipts remain untouched, no upload',async()=>{const f=fixture({[option]:true});await f.run();assert.equal(f.uploads.length,0);assert.equal(finishes(f).length,0);});
  for(const option of ['wrongOwner','wrongProject','wrongAsset','wrongToken','extraPath','switchAccount','switchDevice'])
    await check(option+': unexpected destination or changed account/device stops before bytes leave',async()=>{const f=fixture({[option]:true});await f.run();assert.equal(f.uploads.length,0);assert.equal(finishes(f).length,0);});
  await check('upload failure does not publish a receipt',async()=>{const f=fixture({uploadFails:true});await f.run();assert.equal(finishes(f).length,0);assert(!f.published);});
  for(const option of ['finishFails','falseFinish','wrongFinish'])
    await check(option+': unconfirmed publication is never shown as successful redelivery',async()=>{const f=fixture({[option]:true});await f.run();assert(!f.messages.some(m=>m.includes('PC原本から再送しました')));assert(!f.published);});
  await check('double clicking starts only one PC transfer',async()=>{const f=fixture();await Promise.all([f.run(),f.run(),f.run()]);assert.equal(f.uploads.length,1);});
  await check('stalled upload has an abort deadline and releases the worker',async()=>{
    const f=fixture({hangUpload:true});const pending=f.run();
    const until=Date.now()+2000;
    while(!f.uploads.length&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
    assert.equal(f.uploads.length,1);
    const deadline=[...f.timers.values()].find(x=>x.ms===90000);
    assert(deadline,'upload must have a bounded deadline');deadline.fn();
    await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('worker stayed busy')),1000))]);
    assert.equal(finishes(f).length,0);assert(!f.published);
  });
  console.log(`PC PHOTO ADVERSARIAL RESULT: ${passed} passed, ${failed} failed (mock transport and folder; not physical PC verification).`);
  if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});

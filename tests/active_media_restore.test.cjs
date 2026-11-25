'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto').webcrypto;
const {create}=require('../sentlog/active-media-restore.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const scope={owner:id(9001),device:id(9201)},project=id(9101),token=id(9002);
const blob=new Blob(['verified shared media']);const corrupt=new Blob(['x'.repeat(blob.size)]);
(async()=>{
 const sha=Buffer.from(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
 const row=n=>({id:id(n),project_id:project,kind:n%2?'photo':'drawing',file_name:'file',mime_type:n%2?'image/jpeg':'application/dxf',sha256:sha,byte_size:blob.size,storage_path:'old/'+n,updated_at:'2026-01-01T00:00:00.000Z',pc_path:'Root/f'});
 function make(n,mode='ok'){
  const rows=Array.from({length:n},(_,i)=>row(i+1)),done=new Set(),staged=new Map(),states=[],calls={list:0,claim:0,upload:0,download:0,finish:0,localRead:0};let current={...scope},isOnline=true,service;
  const root={name:'Root',queryPermission:async()=>mode==='permission'?'denied':'granted',getFileHandle:async(name,opts)=>{assert.equal(opts,undefined);assert.equal(name,'f');return {getFile:async()=>{calls.localRead++;return mode==='localcorrupt'?corrupt:blob;}};}};
  const path=a=>scope.owner+'/'+project+'/active-restore/'+a.id+'/'+sha+'/'+('b'.repeat(64))+'/'+token+(a.mime_type==='image/jpeg'?'.jpg':'.dxf');
  const find=a=>rows.find(r=>r.id===a.p_asset_id);
  const opts={getScope:()=>current,ensure:async()=>{},getRoot:()=>root,subtle:crypto.subtle,online:()=>isOnline,wait:async()=>{},onState:s=>states.push(s),
   rpc:async(action,args)=>{calls[action]++;if(action==='list')return {schema:1,rows:rows.filter(a=>!done.has(a.id)&&(!args.p_after||a.id>args.p_after)).slice(0,16)};
    const a=find(args);assert.equal(args.p_sha256,sha);assert.equal(args.p_expected_path,a.storage_path);
    if(action==='claim'){if(mode==='leased')return {claimed:false,reason:'leased'};return {claimed:true,token,storage_path:mode==='wrongpath'?path(a).replace(scope.owner,id(44)):path(a),object_present:staged.has(path(a))};}
    assert.equal(action,'finish');assert.equal(args.p_token,token);assert(staged.has(path(a)));if(mode==='finishloss'&&!done.has(a.id)){done.add(a.id);throw Object.assign(Error('timeout'),{status:504});}done.add(a.id);return {published:true,asset_id:a.id};},
   upload:async(path,file,mime)=>{calls.upload++;assert.equal(file,blob);assert(!staged.has(path),'no overwrite or duplicate send');staged.set(path,file);if(mode==='offline'){isOnline=false;}if(mode==='scopechange'){current={...scope,owner:id(44)};}if(mode==='stop'){service.stop();}if(mode==='uploadloss'&&calls.upload===1)throw Object.assign(Error('timeout'),{status:504});},
   download:async(path)=>{calls.download++;return mode==='remotecorrupt'?corrupt:staged.get(path);}};
  service=create(opts);
  return {service,calls,states,done,staged,rows,setOnline:x=>{isOnline=x},setScope:x=>{current=x}};
 }
 const big=make(5028);assert.equal(await big.service.start(),true);assert.equal(big.done.size,5028);
 assert.equal(big.calls.upload,5028);assert.equal(big.calls.download,5028);assert.equal(big.calls.finish,5028);
 assert.equal(big.calls.list,Math.ceil(5028/16));const before=big.calls.upload;
 await big.service.start();assert.equal(big.calls.upload,before,'completed rows do not transfer again');
 const lost=make(1,'uploadloss');assert.equal(await lost.service.start(),false);assert.equal(lost.calls.finish,0);assert.equal(lost.staged.size,1);
 assert.equal(await lost.service.start(),true);assert.equal(lost.calls.upload,1,'reuse existing successful staged upload');assert.equal(lost.done.size,1);
 const reply=make(1,'finishloss');assert.equal(await reply.service.start(),false);assert.equal(reply.done.size,1);await reply.service.start();assert.equal(reply.calls.upload,1);
 for(const mode of ['localcorrupt','remotecorrupt','wrongpath','permission','leased','offline','scopechange','stop']){
  const f=make(1,mode);await f.service.start();assert.equal(f.done.size,0,mode);assert.equal(f.calls.finish,0,mode);
  if(['localcorrupt','wrongpath','permission','leased'].includes(mode))assert.equal(f.calls.upload,0,mode);
 }
 const off=make(1,'offline');await off.service.start();off.setOnline(true);await off.service.start();assert.equal(off.calls.upload,1);assert.equal(off.done.size,1);
 const stop=make(1,'stop');await stop.service.start();assert.equal(stop.states.at(-1).phase,'stopped');await stop.service.start();assert.equal(stop.done.size,1);
 const double=make(17);const results=await Promise.all([double.service.start(),double.service.start()]);assert.deepEqual(results,[true,false]);assert.equal(double.calls.upload,17);
 const missing=make(1);missing.rows[0].pc_path=null;await missing.service.start();assert.equal(missing.calls.upload,0);assert.equal(missing.states.at(-1).phase,'review');
 const badpath=make(1);badpath.rows[0].pc_path='Root/../f';await badpath.service.start();assert.equal(badpath.calls.upload,0);
 console.log('PASS active shared media restore worker: 5028 simulated files, bounded paging, zero repeated uploads, lost upload/finish response, offline/manual resume, cancellation, corrupt local/remote bytes, destination/scope/path protection, permission, competing lease, double-click');
})().catch(e=>{console.error(e);process.exitCode=1;});

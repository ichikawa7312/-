'use strict';
// Regression for actual failure: PC has an extensionless/unknown-MIME source image,
// the cloud no longer has the bytes, and a new registered device asks for it.
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
const C=require('../sentlog/archive-core.js');
class Dir{
 constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();}
 async queryPermission(){return 'granted';}
 async getDirectoryHandle(name){if(!this.dirs.has(name))throw Error('not found: '+name);return this.dirs.get(name);}
 async getFileHandle(name){if(!this.files.has(name))throw Error('not found: '+name);return {getFile:async()=>this.files.get(name)};}
 dir(name){const x=new Dir(name);this.dirs.set(name,x);return x;}
 file(name,blob){this.files.set(name,blob);return this;}
}
function element(tag){return {tag,children:[],style:{},textContent:'',setAttribute(){},append(...a){this.children.push(...a);},prepend(...a){this.children.unshift(...a);}};}
async function fixture({corrupt=false,unknownMime=false,staleRequest=false,recentHeartbeat=false,inactiveDevice=false}={}){
 const data=new Blob(['jpeg-data-test-photo-file']);const sha=await C.hash(data),root=new Dir('保管');
 const original=new File([corrupt?'wrong-photo':data],'image.jpg',{type:''});
 root.dir('2026').dir('テルモ愛鷹工場').dir('写真').dir('01.東側').dir('ひび割れ②').file('image.jpg',original);
 const a={id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',
   status:'storage_deleted',kind:'photo',file_name:'image.jpg',mime_type:unknownMime?'application/octet-stream':'image/jpeg',
   byte_size:data.size,sha256:sha,metadata:{drawing_id:'drawing-id',photo_id:'photo-id'}};
 const path='保管\\2026\\テルモ愛鷹工場\\写真\\01.東側\\ひび割れ②\\image.jpg';
 const receipt={pc_path:path,sha256:sha,byte_size:data.size};
 const old=new Date(Date.now()-5*24*3600*1000).toISOString(),current=new Date().toISOString();
 const desired=[{asset_id:a.id,device_id:'browser-test',expected_sha256:sha,requested_at:staleRequest?old:current}];
 const devices=[{id:'browser-test',active:!inactiveDevice,last_seen_at:recentHeartbeat?current:old}];
 const calls=[],posts=[],errors=[],main=element('main');
 const session={access_token:'mock-token',expires_at:9999999999,user:{id:'owner-id'}},local={
  sentlogCloudSessionV1:JSON.stringify(session),sentlogPcWebDeviceV1:'pc-id'
 };
 const context=vm.createContext({
   location:{pathname:'/sentlog-pc/'},console,Blob,File,Response,Date,AbortController,
   crypto:webcrypto,navigator:{onLine:true},
   document:{hidden:false,querySelector:()=>main,createElement:element,getElementById:()=>null,addEventListener:()=>{}},
   localStorage:{getItem:k=>local[k]||null},idbGet:async k=>k==='root'?root:null,
   log:t=>errors.push(t),setTimeout:()=>{},clearTimeout:()=>{},setInterval:()=>{},addEventListener:()=>{},
   fetch:async(url,options={})=>{
     const u=String(url),body=u.includes('/rest/v1/')&&options.body?JSON.parse(options.body):null;
     if(u.includes('/rest/v1/')){
       let result=[];
       if(u.includes('sentlog_pdf_requests'))result=desired;
       else if(u.includes('sentlog_devices'))result=devices.filter(d=>d.active);
       else if(u.includes('sentlog_assets'))result=[a];
       else if(u.includes('sentlog_projects'))result=[{id:a.project_id}];
       else if(u.includes('sentlog_pc_receipts'))result=[receipt];
       else if(u.includes('sentlog_claim_photo_redelivery')){
         calls.push('claim');result={claimed:true,token:'token-1',storage_path:'owner-id/project/redelivery/'+a.id+'/token-1.jpg'};
       }else if(u.includes('sentlog_finish_photo_redelivery')){calls.push('finish');result={published:true};}
       else throw Error('unexpected REST '+u);
       return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
     }
     if(u.includes('/storage/v1/object/')){
       if(options.method==='POST'){
         posts.push({headers:options.headers,bytes:options.body});
         if(options.headers['Content-Type']!=='image/jpeg')
           return new Response('InvalidMimeType',{status:400});
         return new Response('{}',{status:200});
       }
       throw Error('unexpected storage '+u);
     }
     throw Error('unexpected request '+u);
   }
 });
 context.window=context;vm.runInContext(fs.readFileSync('sentlog/photo-recovery.js','utf8'),context);
 await Promise.resolve();await Promise.resolve();
 await context.sentlogCheckPhotoRecovery();
 return {root,calls,posts,errors,sha,original};
}
(async()=>{
 const pcPage=fs.readFileSync('sentlog-pc/index.html','utf8');
 assert(pcPage.includes('photo-recovery.js?v=143'),'PC must load the fresh stale-request guard, not cached v1.41');
 assert(pcPage.includes('v1.43 · 写真再送ループ対策'),'PC must show latest loop-fix version');
 const success=await fixture();
 if(success.posts.length!==1)console.error('PHOTO DEBUG',{posts:success.posts.length,calls:success.calls,errors:success.errors});
 assert.equal(success.posts.length,1,'one photo must be uploaded');
 assert.equal(success.posts[0].headers['Content-Type'],'image/jpeg','MIME comes from archived asset metadata');
 assert.equal(await C.hash(success.posts[0].bytes),success.sha);
 assert.deepEqual(success.calls,['claim','finish']);
 assert.equal(await C.hash(success.original),success.sha,'PC original is retained unchanged');
 const corrupt=await fixture({corrupt:true});
 assert.equal(corrupt.posts.length,0,'corrupt PC file cannot be sent');
 assert.equal(corrupt.calls.includes('claim'),false,'cannot claim before validating PC photo');
 const invalid=await fixture({unknownMime:true});
 assert.equal(invalid.posts.length,0,'unsupported MIME must not upload');
 const abandoned=await fixture({staleRequest:true});
 assert.equal(abandoned.posts.length,0,'5-day-old abandoned InPrivate request must not upload');
 assert.equal(abandoned.calls.length,0,'stale requests must not claim a new temporary file');
 assert(abandoned.errors.some(e=>e.includes('古い端末の未受信依頼')),'stale request should show safe idle message');
 const reopened=await fixture({staleRequest:true,recentHeartbeat:true});
 assert.equal(reopened.posts.length,1,'reopened and recently active device may recover its old request');
 const recentlyRequested=await fixture();
 assert.equal(recentlyRequested.posts.length,1,'fresh request must proceed even with stale device heartbeat');
 const inactive=await fixture({inactiveDevice:true});
 assert.equal(inactive.posts.length,0,'stopped/removed device must not trigger uploads');
 assert.equal(inactive.calls.length,0);
 console.log('PASS photo redelivery PC: verified source, proper MIME, 5-day stale browser request ignored, recent active device allowed, stopped device ignored, corruption fails closed');
})().catch(e=>{console.error(e);process.exitCode=1;});

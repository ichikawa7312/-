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
async function fixture({corrupt=false,unknownMime=false}={}){
 const data=new Blob(['jpeg-data-test-photo-file']);const sha=await C.hash(data),root=new Dir('保管');
 const original=new File([corrupt?'wrong-photo':data],'image.jpg',{type:''});
 root.dir('2026').dir('テルモ愛鷹工場').dir('写真').dir('01.東側').dir('ひび割れ②').file('image.jpg',original);
 const a={id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',
   status:'storage_deleted',kind:'photo',file_name:'image.jpg',mime_type:unknownMime?'application/octet-stream':'image/jpeg',
   byte_size:data.size,sha256:sha,metadata:{drawing_id:'drawing-id',photo_id:'photo-id'}};
 const path='保管\\2026\\テルモ愛鷹工場\\写真\\01.東側\\ひび割れ②\\image.jpg';
 const receipt={pc_path:path,sha256:sha,byte_size:data.size};
 const desired=[{asset_id:a.id,expected_sha256:sha}],calls=[],posts=[],errors=[],main=element('main');
 const session={access_token:'mock-token',expires_at:9999999999,user:{id:'owner-id'}},local={
  sentlogCloudSessionV1:JSON.stringify(session),sentlogPcWebDeviceV1:'pc-id'
 };
 const context=vm.createContext({
   location:{pathname:'/sentlog-pc/'},console,Blob,File,Response,Date,
   crypto:webcrypto,navigator:{onLine:true},
   document:{hidden:false,querySelector:()=>main,createElement:element,getElementById:()=>null,addEventListener:()=>{}},
   localStorage:{getItem:k=>local[k]||null},idbGet:async k=>k==='root'?root:null,
   log:t=>errors.push(t),setTimeout:()=>{},setInterval:()=>{},addEventListener:()=>{},
   fetch:async(url,options={})=>{
     const u=String(url),body=u.includes('/rest/v1/')&&options.body?JSON.parse(options.body):null;
     if(u.includes('/rest/v1/')){
       let result=[];
       if(u.includes('sentlog_pdf_requests'))result=desired;
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
 console.log('PASS photo redelivery PC: missing cloud photo, verified original, JPEG MIME, no overwrite, corruption fails closed');
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const C=require('../sentlog/archive-core.js');
class Entry{
  constructor(name,blob=new Blob([])){this.name=name;this.blob=blob;}
  async getFile(){return new File([this.blob],this.name,{type:this.blob.type});}
}
class Dir{
  constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();this.granted=true;}
  async queryPermission(){return this.granted?'granted':'denied';}
  async getDirectoryHandle(name){if(!this.dirs.has(name))throw Error('Missing '+name);return this.dirs.get(name);}
  async getFileHandle(name){if(!this.files.has(name))throw Error('Missing '+name);return this.files.get(name);}
  dir(name){const next=new Dir(name);this.dirs.set(name,next);return next;}
  file(name,blob){this.files.set(name,new Entry(name,blob));}
}
function node(tag){return {tag,style:{},children:[],textContent:'',setAttribute(){},append(...c){this.children.push(...c);},prepend(...c){this.children.unshift(...c);}};}
async function fixture({restore=false,missing=false,denied=false}={}){
 const root=new Dir('保管');root.granted=!denied;
 const folder=root.dir('復旧用').dir('project-id').dir('job-id');
 const fileDir=folder.dir('files'),data=new Blob(['exact archive bytes'],{type:'application/pdf'});
 const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',key:'background:draw',kind:'drawing',file_name:'drawing.pdf',
   mime_type:'application/pdf',byte_size:data.size,sha256:await C.hash(data)};
 const job={id:'job-id',project_id:'project-id',revision:2,catalog_hash:'a'.repeat(64),
   payload:{project:{id:'local-id',name:'保存済み案件',drawings:[{id:'draw'}]},drawings:[{meta:{id:'draw'},state:{shapes:[]}}]},manifest:[file]};
 const pack=C.backupPack(job,{[file.key]:'files/'+file.id});
 folder.file('manifest.sentlog.json',new Blob([JSON.stringify(pack)]));
 if(!missing)fileDir.file(file.id,data);
 job.pc_receipt={path:'保管\\復旧用\\project-id\\job-id\\manifest.sentlog.json',
   package_sha256:await C.hash(await folder.files.get('manifest.sentlog.json').getFile())};
 const op={id:'op-id',owner_id:'owner-id',project_id:'project-id',job_id:'job-id',action:restore?'restore':'verify',
   expires_at:'2099-01-01T00:00:00Z'};
 const messages=[],calls=[],uploads=new Map(),elements=[],main=node('main');
 const context=vm.createContext({SentlogArchiveCore:C,Blob,File,crypto:webcrypto,console,Date,
   session:{user:{id:'owner-id'}},rootHandle:root,SUPABASE_URL:'https://example.invalid',BUCKET:'temp',navigator:{onLine:true},
   document:{hidden:false,createElement(tag){const e=node(tag);elements.push(e);return e;},querySelector(){return main;},addEventListener(){}},
   ensureSession:async()=>{},ensureDevice:async()=>'pc-device',
   authHeaders:(extra={})=>extra,
   rest:async(path,opts)=>{const data=JSON.parse(opts.body);calls.push(data);if(data.p_action==='pc_jobs')return [{operation:op,job}];
     if(data.p_action==='pc_cleanup')return [];return {ok:true};},
   fetch:async(url,opts={})=>{
     const u=String(url),method=opts.method||'GET';
     if(method==='POST'){uploads.set(u,new Blob([opts.body]));return new Response('{}',{status:200});}
     const uploadPath=u.replace('/object/authenticated/','/object/');
     if(uploads.has(uploadPath))return new Response(uploads.get(uploadPath),{status:200});
     return new Response('missing',{status:404});
   },
   setTimeout(){},setInterval(){},addEventListener(){},log:t=>messages.push(t)});
 context.window=context;
 vm.runInContext(fs.readFileSync('sentlog/archive-restore-pc.js','utf8'),context);
 const run=elements.find(e=>e.tag==='button').onclick;
 return {root,folder,fileDir,file,run,calls,messages,uploads,data};
}
(async()=>{
 const verify=await fixture();await verify.run();
 assert(verify.calls.some(x=>x.p_action==='pc_ready'));
 assert(!verify.calls.some(x=>x.p_action==='pc_error'));
 assert.equal(verify.uploads.size,0);
 assert(verify.fileDir.files.has(verify.file.id));
 console.log('PASS capacity PC: rereads complete bundle and rechecks all file hashes before authorizing local cleanup');
 const restore=await fixture({restore:true});await restore.run();
 assert(restore.calls.some(x=>x.p_action==='pc_ready'));
 assert.equal(restore.uploads.size,1);
 assert(restore.fileDir.files.has(restore.file.id));
 console.log('PASS capacity PC: transfers only archive originals to private temporary storage; PC source retained');
 const missing=await fixture({missing:true});await missing.run();
 assert(missing.calls.some(x=>x.p_action==='pc_error'));assert(!missing.calls.some(x=>x.p_action==='pc_ready'));
 console.log('PASS capacity PC: missing file denies cleanup and restore');
 const denied=await fixture({denied:true});await denied.run();
 assert(denied.calls.some(x=>x.p_action==='pc_error'));assert(!denied.calls.some(x=>x.p_action==='pc_ready'));
 console.log('PASS capacity PC: denied filesystem permission denies cleanup and restore');
})().catch(e=>{console.error(e);process.exitCode=1;});
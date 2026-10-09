'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const C=require('../sentlog/archive-core.js');
class Entry{
 constructor(name,blob){this.name=name;this.blob=blob;}
 // Real PC archive files have extensionless UUID names, so their MIME is empty.
 async getFile(){return new File([this.blob],this.name,{type:''});}
}
class Dir{
 constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();}
 async queryPermission(){return 'granted';}
 async getDirectoryHandle(name){if(!this.dirs.has(name))throw Error('Missing folder '+name);return this.dirs.get(name);}
 async getFileHandle(name){if(!this.files.has(name))throw Error('Missing file '+name);return this.files.get(name);}
 dir(name){const result=new Dir(name);this.dirs.set(name,result);return result;}
 file(name,blob){this.files.set(name,new Entry(name,blob));}
}
function element(tag){return {tag,style:{},children:[],textContent:'',setAttribute(){},append(...c){this.children.push(...c);},prepend(...c){this.children.unshift(...c);}};}
(async()=>{
 const sz=23*1024*1024+13,original=new Blob([new Uint8Array(sz).map((_,i)=>i%251)],{type:'application/pdf'});
 const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',key:'background:plan',kind:'drawing',
   file_name:'large.pdf',mime_type:'application/pdf',byte_size:sz,sha256:await C.hash(original)};
 const smallOriginal=new Blob(['%PDF-1.4\nminimal PDF bytes\n%%EOF'],{type:'application/pdf'});
 const smallFile={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',key:'background:small',kind:'drawing',
   file_name:'01.東側.pdf',mime_type:'application/pdf',byte_size:smallOriginal.size,sha256:await C.hash(smallOriginal)};
 const job={id:'job-x',project_id:'project-x',revision:2,catalog_hash:'b'.repeat(64),payload:{
   project:{id:'local-x',name:'大容量テスト',drawings:[{id:'plan'}]},
   drawings:[{meta:{id:'plan'},state:{shapes:[]}}]},manifest:[file,smallFile]};
 const root=new Dir('保管');const folder=root.dir('復旧用').dir('project-x').dir('job-x');
 const sourceFiles=folder.dir('files');sourceFiles.file(file.id,original);sourceFiles.file(smallFile.id,smallOriginal);
 const pack=C.backupPack(job,{[file.key]:'files/'+file.id,[smallFile.key]:'files/'+smallFile.id});
 folder.file('manifest.sentlog.json',new Blob([JSON.stringify(pack)]));
 job.pc_receipt={path:'保管\\復旧用\\project-x\\job-x\\manifest.sentlog.json',
   package_sha256:await C.hash(await folder.files.get('manifest.sentlog.json').getFile())};
 const op={id:'operation-x',owner_id:'owner-x',project_id:'project-x',job_id:'job-x',action:'restore',
   expires_at:'2099-12-01T00:00:00Z'};
 let cleanup=false;
 const uploads=new Map(),calls=[],elements=[],deleted=[],messages=[];
 const context=vm.createContext({
   SentlogArchiveCore:C,Blob,File,crypto:webcrypto,console,Date,
   session:{user:{id:'owner-x'}},rootHandle:root,SUPABASE_URL:'https://example.invalid',BUCKET:'temp',navigator:{onLine:true},
   document:{hidden:false,createElement(tag){const e=element(tag);elements.push(e);return e;},querySelector(){return element('main');},addEventListener(){}},
   ensureSession:async()=>{},ensureDevice:async()=>'pc-device',
   authHeaders:(extra={})=>extra,
   rest:async(path,opts)=>{const data=JSON.parse(opts.body);calls.push(data);
     if(data.p_action==='pc_jobs')return cleanup?[]:[{operation:op,job}];
     if(data.p_action==='pc_cleanup')return cleanup?[{id:op.id,owner_id:op.owner_id,action:'restore',manifest:job.manifest}]:[];
     return {ok:true};
   },
   fetch:async(url,options={})=>{
     const u=String(url),method=options.method||'GET';
     if(method==='POST'){
       // Mirror the private bucket's MIME allowlist. This rejects v1.39's
       // application/octet-stream regression, even though bytes/hash are fine.
       if(options.headers['Content-Type']!=='application/pdf')
         return new Response(JSON.stringify({error:'InvalidMimeType'}),{status:400,headers:{'Content-Type':'application/json'}});
       uploads.set(u.replace('/object/','/object/authenticated/'),new Blob([options.body]));
       return new Response('{}',{status:200});
     }
     if(method==='DELETE'){
       const x=JSON.parse(options.body).prefixes;deleted.push(...x);return new Response('{}',{status:200});
     }
     return uploads.has(u)?new Response(uploads.get(u),{status:200}):new Response('missing',{status:404});
   },
   setTimeout(){},setInterval(){},addEventListener(){},log:s=>messages.push(s)
 });
 context.window=context;
 vm.runInContext(fs.readFileSync('sentlog/archive-restore-pc.js','utf8'),context);
 const run=elements.find(e=>e.tag==='button').onclick;
 await run();
 const partCount=Math.ceil(sz/(4*1024*1024));
 assert.equal(uploads.size,partCount+1,'23MiB file uses chunks; extensionless small PDF is also uploaded');
 const reconstructed=new Blob([...uploads.entries()].filter(([u])=>u.includes(file.id+'.part')).sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v));
 assert.equal(reconstructed.size,sz);
 assert.equal(await C.hash(reconstructed),file.sha256);
 const restoredSmall=[...uploads.entries()].find(([u])=>u.endsWith('/'+smallFile.id))?.[1];
 assert(restoredSmall,'small PDF must also be uploaded with manifest MIME');
 assert.equal(await C.hash(restoredSmall),smallFile.sha256);
 assert(calls.some(c=>c.p_action==='pc_ready'));
 await run();
 assert.equal(uploads.size,partCount+1,'retries must reuse existing verified pieces and small file');
 cleanup=true;await run();
 assert.equal(deleted.length,partCount+1,'delete every temporary piece and small file');
 assert(deleted.every(s=>s.includes('operation-x')));
 assert(calls.some(c=>c.p_action==='pc_cleaned'));
 assert.equal(folder.files.has('manifest.sentlog.json'),true,'company PC original manifest preserved');
 assert.equal((await folder.dirs.get('files').files.get(file.id).getFile()).size,sz,'PC source preserved');
 console.log('PASS v1.40: extensionless PDF MIME from manifest, 23MiB file split into '+partCount+' verified pieces, idempotent retry and temp-only cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});

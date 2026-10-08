'use strict';
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const C=require('../sentlog/archive-core.js');
class Entry {
  constructor(name,blob=new Blob([])){this.name=name;this.blob=blob;}
  async getFile(){return new File([this.blob],this.name,{type:this.blob.type});}
  async createWritable(){let value;return {write:async data=>{value=data;},close:async()=>{this.blob=new Blob([value]);},abort:async()=>{}};}
}
class Dir {
  constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();this.granted=true;}
  async queryPermission(){return this.granted?'granted':'denied';}
  async getDirectoryHandle(name,{create=false}={}){if(!this.dirs.has(name)){if(!create)throw Error('Not found');this.dirs.set(name,new Dir(name));}return this.dirs.get(name);}
  async getFileHandle(name,{create=false}={}){if(!this.files.has(name)){if(!create)throw Error('Not found');this.files.set(name,new Entry(name));}return this.files.get(name);}
}
function element(tag){return {tag,children:[],textContent:'',setAttribute(){},append(...x){this.children.push(...x);},prepend(...x){this.children.unshift(...x);}};}
async function fixture({missing=false,permission=true}={}){
  const root=new Dir('保管');root.granted=permission;const source=await root.getDirectoryHandle('original',{create:true});
  const blob=new Blob(['original exact PDF bytes'],{type:'application/pdf'});if(!missing)source.files.set('drawing.pdf',new Entry('drawing.pdf',blob));
  const job={id:'job-test',project_id:'project-test',revision:1,catalog_hash:'a'.repeat(64),payload:{project:{id:'p',name:'試験',drawings:[{id:'d'}]},drawings:[{meta:{id:'d'},state:{shapes:[{id:'s',photos:[],memo:'重要な記録'}]}}]},manifest:[{id:'asset-test',key:'background:d',kind:'drawing',file_name:'drawing.pdf',byte_size:blob.size,sha256:await C.hash(blob),status:'storage_deleted',pc_path:'保管\\original\\drawing.pdf'}]};
  const calls=[],main=element('main'),elements=[];
  const context=vm.createContext({SentlogArchiveCore:C,Blob,File,crypto:webcrypto,AbortController,console,Date,
    session:{user:{id:'owner'}},rootHandle:root,SUPABASE_URL:'https://example.invalid',BUCKET:'test',navigator:{onLine:true},
    document:{hidden:false,createElement(tag){const e=element(tag);elements.push(e);return e;},querySelector(){return main;},addEventListener(){}},
    ensureSession:async()=>{},ensureDevice:async()=>'pc-test',authHeaders:()=>({}),
    rest:async(path,opts)=>{const body=JSON.parse(opts.body);calls.push(body);return body.p_action==='pc_jobs'?[job]:{};},
    indexedDB:{open(){const q={};queueMicrotask(()=>q.onerror());return q;}},
    fetch:async()=>{throw Error('No live network allowed');},setTimeout(){},setInterval(){},clearTimeout(){},addEventListener(){}});
  context.window=context;
  vm.runInContext(fs.readFileSync(require.resolve('../sentlog/archive-pc.js'),'utf8'),context);
  const run=elements.find(e=>e.tag==='button').onclick;
  return {root,source,job,run,calls};
}
(async()=>{
  const good=await fixture();await good.run();assert(good.calls.some(c=>c.p_action==='pc_complete'));assert(!good.calls.some(c=>c.p_action==='pc_error'));
  assert.equal((await good.source.files.get('drawing.pdf').getFile()).size,good.job.manifest[0].byte_size);
  const generation=good.root.dirs.get('復旧用').dirs.get('project-test').dirs.get('job-test');
  const pack=JSON.parse(await (await generation.files.get('manifest.sentlog.json').getFile()).text());assert(C.validatePack(pack,good.job));
  console.log('PASS PC: verified complete versioned backup; original file preserved');
  good.calls.length=0;good.source.files.clear();await good.run();assert(good.calls.some(c=>c.p_action==='pc_complete'));
  console.log('PASS PC: existing backup must be reread and verified, not blindly recreated');
  good.calls.length=0;generation.dirs.get('files').files.clear();await good.run();assert(good.calls.some(c=>c.p_action==='pc_error'));assert(!good.calls.some(c=>c.p_action==='pc_complete'));
  console.log('PASS PC: removal of the actual copy invalidates the next checkpoint');
  const bad=await fixture({missing:true});await bad.run();assert(bad.calls.some(c=>c.p_action==='pc_error'));assert(!bad.calls.some(c=>c.p_action==='pc_complete'));
  console.log('PASS PC: missing source does not produce a completed-backup receipt');
  const denied=await fixture({permission:false});await denied.run();assert(denied.calls.some(c=>c.p_action==='pc_error'));assert(!denied.calls.some(c=>c.p_action==='pc_complete'));
  console.log('PASS PC: denied folder permission blocks archiving');
})().catch(e=>{console.error(e);process.exitCode=1;});

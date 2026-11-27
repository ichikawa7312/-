'use strict';
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const C=require('../sentlog/archive-core.js');
class Entry {
  constructor(name,blob=new Blob([])){this.name=name;this.blob=blob;this.writes=0;this.aborts=0;this.opens=[];this.reads=0;}
  async getFile(){this.reads++;if(this.beforeRead)await this.beforeRead(this.reads);return new File([this.blob],this.name,{type:this.blob.type});}
  async createWritable(options){this.opens.push(options);if(this.beforeOpen)await this.beforeOpen();let value;return {write:async data=>{this.writes++;if(this.writeError)throw this.writeError;value=data;},close:async()=>{this.blob=new Blob([value]);},abort:async()=>{this.aborts++;}};}
}
class Dir {
  constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();this.granted=true;}
  async queryPermission(){return this.granted?'granted':'denied';}
  async getDirectoryHandle(name,{create=false}={}){if(!this.dirs.has(name)){if(!create)throw Object.assign(Error('Not found'),{name:'NotFoundError'});this.dirs.set(name,new Dir(name));}return this.dirs.get(name);}
  async getFileHandle(name,{create=false}={}){if(!this.files.has(name)){if(!create)throw Object.assign(Error('Not found'),{name:'NotFoundError'});this.files.set(name,new Entry(name));}return this.files.get(name);}
}
function element(tag){return {tag,children:[],textContent:'',setAttribute(){},append(...x){this.children.push(...x);},prepend(...x){this.children.unshift(...x);}};}
function serialLocks(){let tail=Promise.resolve();return {calls:[],active:0,request(name,options,fn){this.calls.push({name,options});const result=tail.then(async()=>{this.active++;try{return await fn();}finally{this.active--;}});tail=result.catch(()=>{});return result;}};}
async function fixture({missing=false,permission=true,root:sharedRoot=null,locks=serialLocks()}={}){
  const root=sharedRoot||new Dir('保管');root.granted=permission;const source=await root.getDirectoryHandle('original',{create:true});
  const blob=new Blob(['original exact PDF bytes'],{type:'application/pdf'});if(!missing)source.files.set('drawing.pdf',new Entry('drawing.pdf',blob));
  const job={id:'job-test',project_id:'project-test',revision:1,catalog_hash:'a'.repeat(64),payload:{project:{id:'p',name:'試験',drawings:[{id:'d'}]},drawings:[{meta:{id:'d'},state:{shapes:[{id:'s',photos:[],memo:'重要な記録'}]}}]},manifest:[{id:'asset-test',key:'background:d',kind:'drawing',file_name:'drawing.pdf',byte_size:blob.size,sha256:await C.hash(blob),status:'storage_deleted',pc_path:'保管\\original\\drawing.pdf'}]};
  const calls=[],rpcLockStates=[],main=element('main'),elements=[];
  const context=vm.createContext({SentlogArchiveCore:C,Blob,File,crypto:webcrypto,AbortController,console,Date,
    session:{user:{id:'owner'}},rootHandle:root,SUPABASE_URL:'https://example.invalid',BUCKET:'test',navigator:{onLine:true,locks},
    document:{hidden:false,createElement(tag){const e=element(tag);elements.push(e);return e;},querySelector(){return main;},addEventListener(){}},
    ensureSession:async()=>{},ensureDevice:async()=>'pc-test',authHeaders:()=>({}),
    rest:async(path,opts)=>{const body=JSON.parse(opts.body);calls.push(body);rpcLockStates.push({action:body.p_action,active:locks?.active});return body.p_action==='pc_jobs'?[job]:{};},
    indexedDB:{open(){const q={};queueMicrotask(()=>q.onerror());return q;}},
    fetch:async()=>{throw Error('No live network allowed');},setTimeout(){},setInterval(){},clearTimeout(){},addEventListener(){}});
  context.window=context;
  vm.runInContext(fs.readFileSync(require.resolve('../sentlog/archive-pc.js'),'utf8'),context);
  const run=elements.find(e=>e.tag==='button').onclick;
  return {root,source,job,run,calls,locks,rpcLockStates};
}
async function destination(f){const recovery=await f.root.getDirectoryHandle('復旧用',{create:true}),project=await recovery.getDirectoryHandle(f.job.project_id,{create:true}),generation=await project.getDirectoryHandle(f.job.id,{create:true}),files=await generation.getDirectoryHandle('files',{create:true});return {generation,files};}
function rejected(f){assert(f.calls.some(c=>c.p_action==='pc_error'));assert(!f.calls.some(c=>c.p_action==='pc_complete'));}
async function preserved(entry,hash){assert.equal(await C.hash(await entry.getFile()),hash);assert.equal(entry.writes,0);assert.equal(entry.opens.length,0);}
const pcHtml=fs.readFileSync(require('node:path').join(__dirname,'../sentlog-pc/index.html'),'utf8');
assert.match(pcHtml,/a\.kind==='drawing'&&a\.status==='pc_verified'/);
assert.match(pcHtml,/if\(j\.retained\)\{log\('PC同期済み・クラウド保持:/);
console.log('PASS PC sync: retained active drawings stay out of pending queue without cloud deletion');
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

  const occupied=await fixture(),occupiedDestination=await destination(occupied);
  const different=new Entry('asset-test',new Blob(['unrelated existing backup bytes']));occupiedDestination.files.files.set('asset-test',different);
  const differentHash=await C.hash(await different.getFile());await occupied.run();
  assert.equal(await C.hash(await different.getFile()),differentHash,'a different nonempty archive file must never be overwritten');
  rejected(occupied);await preserved(different,differentHash);assert.equal(occupied.source.files.get('drawing.pdf').reads,0);
  console.log('PASS PC: a nonempty conflicting archive file is preserved without loading a replacement or claiming completion');

  const manifestConflict=await fixture(),manifestDestination=await destination(manifestConflict);
  const foreignManifest=new Entry('manifest.sentlog.json',new Blob(['{"existing":"other backup"}']));manifestDestination.generation.files.set(foreignManifest.name,foreignManifest);
  const manifestHash=await C.hash(await foreignManifest.getFile());await manifestConflict.run();rejected(manifestConflict);await preserved(foreignManifest,manifestHash);
  assert.equal(manifestDestination.files.files.size,0,'reject an occupied manifest before creating backup file placeholders');
  console.log('PASS PC: a nonempty conflicting manifest is preserved before any file replacement is attempted');

  const empty=await fixture(),emptyDestination=await destination(empty),placeholder=new Entry('asset-test'),manifestPlaceholder=new Entry('manifest.sentlog.json');
  emptyDestination.files.files.set(placeholder.name,placeholder);emptyDestination.generation.files.set(manifestPlaceholder.name,manifestPlaceholder);
  await empty.run();assert(empty.calls.some(c=>c.p_action==='pc_complete'));assert.equal(placeholder.writes,1);assert.equal(manifestPlaceholder.writes,1);
  assert(placeholder.opens.every(x=>x?.mode==='exclusive'));assert(manifestPlaceholder.opens.every(x=>x?.mode==='exclusive'));
  const completedHash=await C.hash(await placeholder.getFile()),completedManifestHash=await C.hash(await manifestPlaceholder.getFile());
  empty.calls.length=0;empty.source.files.clear();await empty.run();assert(empty.calls.some(c=>c.p_action==='pc_complete'));
  assert.equal(await C.hash(await placeholder.getFile()),completedHash);assert.equal(await C.hash(await manifestPlaceholder.getFile()),completedManifestHash);assert.equal(placeholder.writes,1);assert.equal(manifestPlaceholder.writes,1);
  assert(empty.rpcLockStates.filter(x=>x.action==='pc_complete').every(x=>x.active===0),'server acknowledgement must not retain the filesystem lock');
  console.log('PASS PC: empty interrupted placeholders resume, then exact complete files and manifest are reused without writes');

  const partial=await fixture(),partialDestination=await destination(partial),truncated=new Entry('asset-test',new Blob(['original exact']));partialDestination.files.files.set(truncated.name,truncated);
  const truncatedHash=await C.hash(await truncated.getFile());await partial.run();rejected(partial);await preserved(truncated,truncatedHash);
  console.log('PASS PC: a nonempty partial file is not assumed to belong to an interrupted operation');

  const raced=await fixture(),raceDestination=await destination(raced),raceFile=new Entry('asset-test');raceDestination.files.files.set(raceFile.name,raceFile);
  const racedBytes=new Blob(['a file placed while the verified source was being read']),racedHash=await C.hash(racedBytes);
  raced.source.files.get('drawing.pdf').beforeRead=async()=>{raceFile.blob=racedBytes;};
  await raced.run();rejected(raced);await preserved(raceFile,racedHash);
  console.log('PASS PC: a path filled while the source is awaited is rechecked and preserved');

  const manifestRace=await fixture(),manifestRaceDestination=await destination(manifestRace),lateManifest=new Entry('manifest.sentlog.json');manifestRaceDestination.generation.files.set(lateManifest.name,lateManifest);
  const lateBytes=new Blob(['{"existing":"late manifest"}']),lateHash=await C.hash(lateBytes);
  manifestRace.source.files.get('drawing.pdf').beforeRead=async()=>{lateManifest.blob=lateBytes;};
  await manifestRace.run();rejected(manifestRace);await preserved(lateManifest,lateHash);
  console.log('PASS PC: a manifest placed during file copying is preserved and no completion is reported');

  const interrupted=await fixture(),interruptedDestination=await destination(interrupted),failedWrite=new Entry('asset-test');failedWrite.writeError=Error('synthetic disk write failure');interruptedDestination.files.files.set(failedWrite.name,failedWrite);
  await interrupted.run();rejected(interrupted);assert.equal(failedWrite.aborts,1);assert.equal((await failedWrite.getFile()).size,0);assert.equal(interrupted.source.files.get('drawing.pdf').writes,0);
  failedWrite.writeError=null;interrupted.calls.length=0;await interrupted.run();assert(interrupted.calls.some(c=>c.p_action==='pc_complete'));
  console.log('PASS PC: a failed write is aborted without changing the source; an empty placeholder can retry');

  const concurrent=await fixture(),second=await fixture({root:concurrent.root,locks:concurrent.locks});await Promise.all([concurrent.run(),second.run()]);
  assert(concurrent.calls.some(c=>c.p_action==='pc_complete'));assert(second.calls.some(c=>c.p_action==='pc_complete'));
  const concurrentDestination=await destination(concurrent);assert.equal(concurrentDestination.files.files.get('asset-test').writes,1);assert.equal(concurrentDestination.generation.files.get('manifest.sentlog.json').writes,1);
  assert.equal(concurrent.locks.calls.length,2);assert(concurrent.locks.calls.every(x=>x.name==='sentlog-pc-safe-backup-v2'&&x.options?.mode==='exclusive'));
  console.log('PASS PC: two archive workers serialize and reuse one verified copy under the existing PC backup lock');

  const noLock=await fixture({locks:null}),noLockDestination=await destination(noLock);await noLock.run();rejected(noLock);assert.equal(noLockDestination.files.files.size,0);assert.equal(noLockDestination.generation.files.size,0);
  console.log('PASS PC: unavailable exclusive coordination blocks writes and completion');

  const opening=await fixture(),openingDestination=await destination(opening),openingFile=new Entry('asset-test');openingDestination.files.files.set(openingFile.name,openingFile);
  const openingBytes=new Blob(['different bytes committed just before exclusive acquisition']),openingHash=await C.hash(openingBytes);openingFile.beforeOpen=async()=>{openingFile.blob=openingBytes;};
  await opening.run();assert.equal(await C.hash(await openingFile.getFile()),openingHash,'the file must be rechecked after exclusive writer acquisition');rejected(opening);
  assert.equal(openingFile.writes,0);assert.equal(openingFile.aborts,1);assert.equal(openingFile.opens.length,1);
  console.log('PASS PC: a collision at exclusive writer acquisition aborts without writing or closing');

  const openingManifest=await fixture(),openingManifestDestination=await destination(openingManifest),openingManifestFile=new Entry('manifest.sentlog.json');openingManifestDestination.generation.files.set(openingManifestFile.name,openingManifestFile);
  const openingManifestBytes=new Blob(['{"existing":"manifest changed before writer acquisition"}']),openingManifestHash=await C.hash(openingManifestBytes);openingManifestFile.beforeOpen=async()=>{openingManifestFile.blob=openingManifestBytes;};
  await openingManifest.run();rejected(openingManifest);assert.equal(await C.hash(await openingManifestFile.getFile()),openingManifestHash);assert.equal(openingManifestFile.writes,0);assert.equal(openingManifestFile.aborts,1);
  console.log('PASS PC: a manifest collision at exclusive writer acquisition is preserved without completion');

  const openingExact=await fixture(),openingExactDestination=await destination(openingExact),openingExactFile=new Entry('asset-test');openingExactDestination.files.files.set(openingExactFile.name,openingExactFile);
  openingExactFile.beforeOpen=async()=>{openingExactFile.blob=openingExact.source.files.get('drawing.pdf').blob;};
  await openingExact.run();assert(openingExact.calls.some(c=>c.p_action==='pc_complete'));assert.equal(await C.hash(await openingExactFile.getFile()),openingExact.job.manifest[0].sha256);assert.equal(openingExactFile.writes,0);assert.equal(openingExactFile.aborts,1);
  console.log('PASS PC: an exact copy committed before exclusive acquisition is reused after aborting the unused writer');
})().catch(e=>{console.error(e);process.exitCode=1;});

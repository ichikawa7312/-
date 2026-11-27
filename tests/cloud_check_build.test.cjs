'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),built=path.resolve(process.env.SENTLOG_BUILT_ROOT||root);
const page=fs.readFileSync(path.join(root,'sentlog/cloud-check.html'),'utf8');
const source=fs.readFileSync(path.join(root,'sentlog/cloud-check.js'),'utf8');
const auth=fs.readFileSync(path.join(root,'sentlog/session-guard.js'));
const before='box.append(title,message,retry,storageCheck,storageRestore);';
const after="/* sentlog-cloud-check-v1 */const cloudCheck=document.createElement('a');cloudCheck.href='./cloud-check.html?v=20261127-cloud-check-1';cloudCheck.textContent='アカウントとクラウドの保存状況を確認';cloudCheck.style.cssText=storageCheck.style.cssText;box.append(title,message,retry,storageCheck,storageRestore,cloudCheck);";
const actual=fs.readFileSync(path.join(built,'sentlog/index.html'),'utf8');
const original=actual.includes(after)?actual.replace(after,before):actual;
assert.equal(original.split(before).length-1,1,'A complete protected-startup build is required; use SENTLOG_BUILT_ROOT');
assert(!original.includes('sentlog-cloud-check-v1'));
const worker=fs.readFileSync(path.join(built,'sentlog/sw.js'),'utf8');
const names=['cloud-check.html','cloud-check.js','cloud-check-auth.js'];
for(const name of names)assert(!worker.includes(name),'Independent resource entered the app cache');
assert.equal(fs.readFileSync(path.join(root,'sentlog/cloud-check-auth.js')).compare(auth),0,'Auth helper must be an exact copy of the shared guard');
const expectedScripts=['./cloud-check-auth.js?v=20261127-cloud-check-1','./cloud-check.js?v=20261127-cloud-check-1'];
assert.deepEqual([...page.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(m=>m[1]),expectedScripts);
assert.equal([...page.matchAll(/<script\b/g)].length,2,'No inline bootstrap or additional app module');
const csp=/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1];
for(const rule of ["default-src 'none'","script-src 'self'","worker-src 'none'","frame-src 'none'","base-uri 'none'","form-action 'none'","connect-src https://wiulvaqixphuobdielyy.supabase.co"])assert(csp.includes(rule),rule);
assert(!csp.includes('unsafe-eval'));assert(!/<form[^>]+action=/.test(page));
assert(/<form id="cloudCheckLoginForm" method="post">/.test(page),'A failed script must never put passwords in a form query string');
assert(/type="submit" id="cloudCheckLogin" disabled/.test(page),'Login starts disabled until the controlled submit handler is ready');
for(const name of ['record-store.js','cloud-sync.js','archive-pc.js','pdf-recovery.js','photo-recovery.js','sync-traffic.js','session-guard.js'])assert(!page.includes(name),'Forbidden page import '+name);
for(const syntax of ['indexedDB.','caches.','serviceWorker.','ensureDevice(','Realtime','localStorage.clear('])assert(!source.includes(syntax),'Unexpected side-effect API '+syntax);
assert(/type="checkbox"/.test(page));assert(!/id="cloudCheckRemember"[^>]*checked/.test(page));
const existing=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
const config=require('../sentlog/cloud-check.js').config;
assert(existing.includes(config.baseUrl),'Must use the existing normal auth project');
const publicKey=/const KEY='([^']+)'/.exec(source)[1];assert(existing.includes(publicKey));assert(publicKey.startsWith('sb_publishable_'));
async function stopped(html){
  const nodes=[],events={init:0,fetch:0,storageWrites:0};
  const context={window:{SentlogRecords:{cutoffResumeVersion:1,storageLifecycleVersion:1,startupProtectionVersion:1,getFileWriteCapabilities:()=>({fileWriteDedupVersion:1}),init(){events.init++;throw Error('SYNTHETIC_PRESERVED_STARTUP_FAILURE');}}},
    fetch(){events.fetch++;throw Error('No application fetch is allowed after protected startup fails');},
    localStorage:{setItem(){events.storageWrites++;},removeItem(){events.storageWrites++;}},
    document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
  vm.createContext(context);await vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1],context);
  assert.deepEqual(events,{init:1,fetch:0,storageWrites:0});assert(nodes.some(n=>n.textContent==='SYNTHETIC_PRESERVED_STARTUP_FAILURE'));
  return nodes;
}
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sentlog-cloud-check-build-'));
  try{
    fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'sentlog'));
    fs.copyFileSync(path.join(root,'scripts/build_cloud_check.py'),path.join(dir,'scripts/build_cloud_check.py'));
    fs.writeFileSync(path.join(dir,'sentlog/index.html'),original);fs.writeFileSync(path.join(dir,'sentlog/sw.js'),worker);fs.writeFileSync(path.join(dir,'sentlog/session-guard.js'),auth);
    for(const name of names)fs.copyFileSync(path.join(root,'sentlog',name),path.join(dir,'sentlog',name));
    const old=await stopped(original);assert.equal(old.filter(n=>n.textContent==='アカウントとクラウドの保存状況を確認').length,0,'Old protected screen has no account-check entry');
    const build=spawnSync(process.env.PYTHON||'python3',['scripts/build_cloud_check.py'],{cwd:dir,encoding:'utf8'});assert.equal(build.status,0,build.stderr);
    const updated=fs.readFileSync(path.join(dir,'sentlog/index.html'),'utf8');assert.equal(updated,original.replace(before,after),'Only the protected-error link changes');
    assert.equal(fs.readFileSync(path.join(dir,'sentlog/sw.js'),'utf8'),worker);assert.equal(fs.readFileSync(path.join(dir,'sentlog/cloud-check-auth.js')).compare(auth),0);
    const next=await stopped(updated),links=next.filter(n=>n.tag==='a'&&n.textContent==='アカウントとクラウドの保存状況を確認');assert.equal(links.length,1);assert.equal(links[0].href,'./cloud-check.html?v=20261127-cloud-check-1');assert.equal(links[0].target,undefined);assert.equal(links[0].onclick,undefined);
    for(const label of ['保存領域の確認','バックアップから復旧'])assert.equal(next.filter(n=>n.textContent===label).length,1,'Existing recovery entry retained');
    const hash=createHash('sha256').update(updated).digest('hex');const again=spawnSync(process.env.PYTHON||'python3',['scripts/build_cloud_check.py'],{cwd:dir,encoding:'utf8'});assert.notEqual(again.status,0,'Repeated build must reject a nonfresh input');assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir,'sentlog/index.html'))).digest('hex'),hash);
    console.log('PASS old screen lacks account entry; new screen adds one link with the same failed init and zero app fetch/write');
    console.log('PASS exact auth copy, existing public config, default memory login, CSP and uncached resource boundary');
    console.log('PASS builder changes only the error link/auth copy and rejects a repeated integration');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

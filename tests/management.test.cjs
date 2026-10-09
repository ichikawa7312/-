'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const C=require('../sentlog/archive-core.js');
const retired={id:'retired',status:'archived',retired:true};
assert.equal(C.maySync(retired,null),false);assert.equal(C.maySync(retired,'retired'),false);
console.log('PASS retired projects excluded from automatic and manual sync');
async function registration(path,end,active=true,networkError=false){
  const source=fs.readFileSync(path,'utf8');
  const code=source.slice(source.indexOf('async function ensureDevice(){'),source.indexOf(end,source.indexOf('async function ensureDevice(){')));
  const events=[],writes=[];
  const ctx=vm.createContext({Date,Array,String,JSON,navigator:{platform:'test'},DEVICE_KEY:'key',enc:encodeURIComponent,
    localStorage:{getItem:()=> 'existing-registration',setItem:(k,v)=>writes.push([k,v])},ensureSession:async()=>{},deviceName:()=> 'test',deviceType:()=> 'browser',
    rest:async(path,opts={})=>{events.push([path,opts.method||'GET']);if(networkError)throw Error('synthetic offline');if(path.includes('register_device'))throw Error('Must not silently create another registration');return [{id:'existing-registration',active}];}});
  vm.runInContext(code,ctx);
  if(!active||networkError)await assert.rejects(ctx.ensureDevice(),networkError?/offline/:/停止中/);
  else assert.equal(await ctx.ensureDevice(),'existing-registration');
  assert.equal(writes.length,0);assert(!events.some(([p])=>p.includes('register_device')));
  if(!active||networkError)assert(!events.some(([,m])=>m!=='GET'));
}
(async()=>{
  for(const [p,end] of [['sentlog/cloud-sync.js','\nfunction openDB()'],['sentlog-pc/index.html','\nfunction openIDB()']]){
    await registration(p,end,false);await registration(p,end,true,true);await registration(p,end,true);
    console.log('PASS '+p+': stopped registration and network failures never re-register; active identity preserved');
  }
  const pdf=fs.readFileSync('sentlog/pdf-recovery.js','utf8');
  assert(pdf.indexOf('registration[0].active!==true')<pdf.indexOf("const assets=await api('sentlog_assets?"));
  assert(pdf.includes("c.status==='active'&&!c.checking"));
  console.log('PASS PDF recovery checks registration before files and excludes archived/retired projects');
  const app=fs.readFileSync('sentlog/index.html','utf8');assert(app.includes('management.js?v=136'));assert(app.includes('v1.35 archive'));
  console.log('PASS v1.36 loader includes management code and preflight');
  const mg=fs.readFileSync('sentlog/management.js','utf8');
  assert(mg.includes("'sentlog_device_registration_v1'"));
  assert(mg.includes("if(!row.active)"));
  assert(mg.includes("rows=result.filter(r=>!removed.has(r.id))"));
  assert(!mg.includes('deleteDBFiles'));
  console.log('PASS only stopped registrations offer removal, hidden registrations filtered and file deletion unchanged');
})().catch(e=>{console.error(e);process.exitCode=1;});

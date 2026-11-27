'use strict';
// Run after the final release builder. Exercise its actual inline REST helper,
// including session-refresh waiting; transport and directories are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');
const htmlPath=process.env.SENTLOG_PC_ARCHIVE_HTML||path.join(__dirname,'../sentlog-pc/index.html');
const html=fs.readFileSync(htmlPath,'utf8'),start=html.indexOf('async function rest('),end=html.indexOf('\nasync function login(',start);
assert(start>=0&&end>start,'Actual PC REST integration is absent');
const restSource=html.slice(start,end);
const fixturePath=path.join(__dirname,'pc.test.cjs'),fixtureText=fs.readFileSync(fixturePath,'utf8'),boundary='const pcHtml=';
assert.equal(fixtureText.split(boundary).length-1,1);
const {fixture,Dir,C}=new Function('require','__dirname',fixtureText.split(boundary)[0]+'\nreturn {fixture,Dir,C};')(createRequire(fixturePath),__dirname);
function actualRest(context){vm.runInContext(restSource,context);}
(async()=>{
  const requests=[],payload={ok:'synthetic'};
  const context=vm.createContext({SUPABASE_URL:'https://example.invalid',ensureSession:async()=>{},
    authHeaders:headers=>({apikey:'synthetic-public',Authorization:'Bearer synthetic-token',...headers}),
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,text:async()=>JSON.stringify(payload)};}});
  actualRest(context);
  const options={method:'POST',body:'{"synthetic":"unchanged body"}',headers:{'X-Synthetic':'retained'}};
  assert.equal(JSON.stringify(await context.rest('/rest/v1/synthetic',options)),JSON.stringify(payload));
  assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{url:'https://example.invalid/rest/v1/synthetic',options:{method:'POST',body:options.body,headers:{apikey:'synthetic-public',Authorization:'Bearer synthetic-token','Content-Type':'application/json','X-Synthetic':'retained'}}}]);
  console.log('PASS PC REST: omitted validator preserves authentication, headers, body and response handling');

  requests.length=0;const original={},replacement={};let selected=original,release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  context.ensureSession=()=>new Promise(resolve=>{release=resolve;entered();});
  const pending=context.rest('/rest/v1/rpc/sentlog_archive_v1',options,()=>{if(selected!==original)throw Object.assign(Error('Synthetic root changed'),{code:'PC_ARCHIVE_ROOT_CHANGED'});});
  const result=pending.then(value=>({value}),error=>({error}));
  await waiting;selected=replacement;release();const outcome=await result;
  assert.equal(outcome.error?.code,'PC_ARCHIVE_ROOT_CHANGED','The actual helper must recheck after awaiting authentication');
  assert.equal(requests.length,0,'A stale archive request must never reach fetch');
  console.log('PASS PC REST: root validation after awaited authentication prevents the actual fetch');

  const f=await fixture(),nextRoot=new Dir('認証待機中に切替');actualRest(f.context);let sessionCalls=0;
  f.context.ensureSession=async()=>{if(++sessionCalls===3)f.context.rootHandle=nextRoot;};
  f.context.fetch=async(url,options)=>{
    assert.equal(url,'https://example.invalid/rest/v1/rpc/sentlog_archive_v1');
    assert.deepEqual(Object.keys(options).sort(),['body','headers','method']);
    const body=JSON.parse(options.body);f.calls.push(body);
    return {ok:true,text:async()=>JSON.stringify(body.p_action==='pc_jobs'?[f.job]:{})};
  };
  await f.run();
  assert.equal(f.calls.filter(c=>c.p_action==='pc_complete').length,0);
  assert.equal(f.calls.filter(c=>c.p_action==='pc_error').length,1);
  assert(f.calls.some(c=>c.p_action==='pc_error'&&/保存先.*変更/.test(c.p_data.reason)));
  assert.equal(sessionCalls,4);assert.equal(nextRoot.dirs.size,0);assert.equal(nextRoot.files.size,0);
  const generation=f.root.dirs.get('復旧用').dirs.get(f.job.project_id).dirs.get(f.job.id);
  assert.equal(await C.hash(await generation.dirs.get('files').files.get('asset-test').getFile()),f.job.manifest[0].sha256);
  assert(C.validatePack(JSON.parse(await generation.files.get('manifest.sentlog.json').blob.text()),f.job));
  assert.equal(f.source.files.get('drawing.pdf').writes,0);
  console.log('PASS PC archive: real REST session wait cannot acknowledge a changed root; the verified original-root copy remains');

  const sent=await fixture(),afterSendRoot=new Dir('送信後に切替');actualRest(sent.context);
  sent.context.fetch=async(url,options)=>{
    assert.equal(url,'https://example.invalid/rest/v1/rpc/sentlog_archive_v1');
    const body=JSON.parse(options.body);sent.calls.push(body);
    return {ok:true,text:async()=>{
      if(body.p_action==='pc_complete')sent.context.rootHandle=afterSendRoot;
      return JSON.stringify(body.p_action==='pc_jobs'?[sent.job]:{});
    }};
  };
  await sent.run();
  const acknowledged=sent.calls.filter(c=>c.p_action==='pc_complete');
  assert.equal(acknowledged.length,1);assert.equal(sent.calls.filter(c=>c.p_action==='pc_error').length,0,'A successfully acknowledged original-root receipt must not become an error after a later selection');
  assert.equal(acknowledged[0].p_data.path.split('\\')[0],sent.root.name);
  const savedGeneration=sent.root.dirs.get('復旧用').dirs.get(sent.job.project_id).dirs.get(sent.job.id);
  assert.equal(await C.hash(await savedGeneration.files.get('manifest.sentlog.json').getFile()),acknowledged[0].p_data.package_sha256);
  assert.equal(await C.hash(await savedGeneration.dirs.get('files').files.get('asset-test').getFile()),sent.job.manifest[0].sha256);
  assert.equal(afterSendRoot.dirs.size,0);assert.equal(afterSendRoot.files.size,0);
  const message=sent.context.document.querySelector('main').children[0].children[2].textContent;
  assert(message.includes('保存先：'+sent.root.name));assert(!message.includes(afterSendRoot.name));
  console.log('PASS PC archive: a root change after dispatch preserves the successful fixed-root acknowledgement and names its real destination');
})().catch(error=>{console.error(error);process.exitCode=1;});

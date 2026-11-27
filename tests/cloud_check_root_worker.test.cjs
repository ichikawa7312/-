'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('sw.js','utf8'),scope='https://example.test/-/';
function worker(){
 const handlers=new Map(),calls={fetch:0,open:0,put:0,match:0},response={clone:()=>({copied:true})};
 const context={URL,Set,location:{origin:'https://example.test'},self:{registration:{scope},addEventListener:(name,fn)=>handlers.set(name,fn)},
  fetch:async()=>{calls.fetch++;return response;},caches:{open:async()=>{calls.open++;return {put:async()=>{calls.put++;}};},match:async()=>{calls.match++;return null;}}};
 vm.createContext(context);vm.runInContext(source,context);
 return {calls,async request(path,method='GET'){
  let reply=null,intercepts=0;handlers.get('fetch')({request:{url:new URL(path,scope).href,method},respondWith(p){intercepts++;reply=p;}});
  if(reply)await reply;await new Promise(resolve=>setImmediate(resolve));return intercepts;
 }};
}
(async()=>{
 let cases=0;
 for(const name of ['cloud-check.html','cloud-check.js','cloud-check-auth.js'])for(const query of ['','?v=20261127-cloud-check-1','?v=another']){
  const f=worker();assert.equal(await f.request('sentlog/'+name+query),0);
  assert.deepEqual(f.calls,{fetch:0,open:0,put:0,match:0});cases++;
 }
 for(const path of ['index.html','app.css?v=test','sentlog/index.html','sentlog/cloud-check.js.extra','other/cloud-check.html','/other/sentlog/cloud-check.js']){
  const f=worker();assert.equal(await f.request(path),1,path);
  assert.deepEqual(f.calls,{fetch:1,open:1,put:1,match:0});cases++;
 }
 for(const [path,method]of [['sentlog/cloud-check.html','POST'],['https://external.invalid/file','GET']]){
  const f=worker();assert.equal(await f.request(path,method),0);assert.deepEqual(f.calls,{fetch:0,open:0,put:0,match:0});cases++;
 }
 console.log('PASS root worker: '+cases+' exact path/method/scope cases, cloud-check bypasses cache and other app fetch behavior is retained');
})().catch(error=>{console.error(error);process.exitCode=1;});

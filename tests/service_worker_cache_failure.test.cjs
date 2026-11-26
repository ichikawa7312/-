'use strict';
// Execute the real fetch handler with synthetic requests/responses only.
// This does not activate a worker or touch a browser's production caches.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('sentlog/sw.js','utf8');
const origin='https://example.invalid',scope=origin+'/sentlog/',path=scope+'record-store.js';
function fixture({networkError,networkStatus=200,openError,putError,cached=null}={}){
  const handlers={},calls={fetch:[],open:[],put:[],match:[]};
  const response=new Response('synthetic current release',{status:networkStatus});
  const cache={async put(key,value){calls.put.push({key,value});if(putError)throw putError;},async match(key){calls.match.push(key);return cached;}};
  const context={URL,Error,self:{registration:{scope},addEventListener:(event,handler)=>handlers[event]=handler},
    caches:{async open(name){calls.open.push(name);if(openError)throw openError;return cache;}},
    async fetch(request,options){calls.fetch.push({request,options});if(networkError)throw networkError;return response;}};
  vm.createContext(context);vm.runInContext(code,context);
  function request(url=path+'?v=synthetic-current',method='GET'){
    let pending;handlers.fetch({request:{url,method},respondWith(value){pending=value;}});return pending;
  }
  return {request,calls,response};
}
const cases=[];function test(name,fn){cases.push([name,fn]);}
test('a successful network response survives a cache write quota failure without returning stale code',async()=>{
  const f=fixture({putError:new DOMException('synthetic cache quota','QuotaExceededError'),cached:new Response('synthetic previous release')});
  const response=await f.request();assert.equal(response,f.response);assert.equal(await response.text(),'synthetic current release');
  assert.equal(f.calls.put.length,1);assert.equal(f.calls.put[0].key,path);assert.equal(f.calls.match.length,0);
});
test('a successful network response survives failure to open CacheStorage',async()=>{
  const f=fixture({openError:new DOMException('synthetic cache open quota','QuotaExceededError')});
  const response=await f.request();assert.equal(response,f.response);assert.equal(await response.text(),'synthetic current release');
  assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.put.length,0);assert.equal(f.calls.match.length,0);
});
test('a network failure still returns the exact existing offline response using its canonical URL',async()=>{
  const cached=new Response('synthetic offline release'),f=fixture({networkError:Error('synthetic offline'),cached});
  assert.equal(await f.request(),cached);assert.deepEqual(f.calls.match,[path]);assert.equal(f.calls.put.length,0);
});
test('a failed network request without a cached response keeps its original failure',async()=>{
  const networkError=Error('synthetic network unavailable'),f=fixture({networkError});
  await assert.rejects(f.request(),error=>error===networkError);assert.deepEqual(f.calls.match,[path]);
});
test('network and cache-open failures cannot be reported as a successful response',async()=>{
  const networkError=Error('synthetic network unavailable'),f=fixture({networkError,openError:Error('synthetic cache unavailable')});
  await assert.rejects(f.request(),error=>error===networkError);assert.equal(f.calls.fetch.length,1);
});
test('an HTTP failure retains offline fallback and never replaces the valid cached resource',async()=>{
  const cached=new Response('synthetic offline release'),f=fixture({networkStatus:503,cached});
  assert.equal(await f.request(),cached);assert.equal(f.calls.put.length,0);assert.deepEqual(f.calls.match,[path]);
});
test('successful fetches still update their canonical static cache without consuming the returned body',async()=>{
  const f=fixture(),response=await f.request();assert.equal(response,f.response);
  assert.equal(f.calls.put.length,1);assert.equal(f.calls.put[0].key,path);assert.notEqual(f.calls.put[0].value,response);
  assert.equal(await f.calls.put[0].value.text(),'synthetic current release');assert.equal(await response.text(),'synthetic current release');
  assert.equal(f.calls.fetch[0].options.cache,'no-store');
});
test('user APIs, external requests and non-GET operations remain outside the worker',async()=>{
  const f=fixture();assert.equal(f.request(origin+'/api/private'),undefined);assert.equal(f.request('https://other.invalid/sentlog/record-store.js'),undefined);
  assert.equal(f.request(path,'POST'),undefined);assert.equal(f.calls.fetch.length,0);assert.equal(f.calls.open.length,0);
});
(async()=>{for(const [name,run]of cases){await run();console.log('PASS '+name);}console.log(cases.length+' service worker cache failure cases passed');})()
  .catch(error=>{console.error(error);process.exitCode=1;});

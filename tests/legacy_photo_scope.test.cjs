'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync('sentlog/photo-recovery.js','utf8');
const start=text.indexOf(' async function assetList(projectIds){'),end=text.indexOf(' async function localPhoto(',start);
assert(start>=0&&end>start);
const receiveStart=text.indexOf(' async function receive(id){'),receiveEnd=text.indexOf(' async function provide(',receiveStart);
assert(receiveStart>=0&&receiveEnd>receiveStart);
const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8'),scopeExport='window.sentlogCaptureAssetReceiveScope=captureAssetReceiveScope;';
const scopeStart=cloud.indexOf('function captureAssetReceiveScope('),scopeEnd=cloud.indexOf(scopeExport,scopeStart)+scopeExport.length;
assert(scopeStart>=0&&scopeEnd>scopeStart,'the built receiver must expose its authenticated scope capture');
const entries=new Map([['sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic',user:{id:'inventory-owner'}})],['sentlogCloudDeviceV1','phone']]);
const storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
const calls=[],ws={projects:[{id:'delta-local',drawings:[{id:'d1'}]},{id:'legacy-local',drawings:[{id:'d2'}]}]};
const state={shapes:[{photos:[{id:'p1'}]}]},delta=new Set(['delta-local','delta-cloud']);
const ctx=vm.createContext({Map,Set,Array,JSON,Error,localStorage:storage,DEVICE_KEY:'sentlogCloudDeviceV1',enc:encodeURIComponent,photoKey:(d,p)=>d+':'+p,IS_PC:false,show(){},
 window:{sentlogDeltaOwnsProject:id=>delta.has(id),SentlogRecords:{getItem:key=>key==='surveyFieldNoteWorkspaceV1'?JSON.stringify(ws):JSON.stringify(state)}},
 api:async path=>{calls.push(path);if(path.startsWith('sentlog_projects?'))return [{id:'delta-cloud'},{id:'legacy-cloud'}];
  assert(path.includes('project_id=in.'+encodeURIComponent('(legacy-cloud)')));if(path.includes('&id=gt.'))return [];
  return [{id:'a1',project_id:'legacy-cloud',metadata:{}}];}});
// This fixture isolates inventory filtering but still uses the actual capture
// and SessionGuard. Authentication requests are never allowed by the fixture.
vm.runInContext(fs.readFileSync('sentlog/session-guard.js','utf8'),ctx);
ctx.sessionGuard=ctx.window.SentlogSessionGuard.create({key:'sentlogCloudSessionV1',storage,
 fetcher:async()=>{throw Error('Unexpected authentication request in inventory fixture');}});
vm.runInContext(cloud.slice(scopeStart,scopeEnd),ctx);
vm.runInContext(text.slice(start,end)+'\n'+text.slice(receiveStart,receiveEnd),ctx);
(async()=>{
 const keys=await vm.runInContext('currentPhotoKeys().keys',ctx);assert.deepEqual([...keys],['d2:p1']);
 await ctx.receive('phone');assert.equal(calls.filter(x=>x.startsWith('sentlog_assets?')).length,2);
 assert(calls.filter(x=>x.startsWith('sentlog_assets?')).every(x=>!x.includes('delta-cloud')));
 delta.add('legacy-local');calls.length=0;await ctx.receive('phone');assert.equal(calls.length,0,'all delta-owned projects make no old photo inventory calls');
 console.log('PASS legacy photo scope: only legacy project photos scanned, delta-owned projects do not repeat full photo inventory, cursor continues to empty');
})().catch(e=>{console.error(e);process.exitCode=1;});

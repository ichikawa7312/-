'use strict';
// Native writer and fake IndexedDB; no live records, device, or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const code=fs.readFileSync('sentlog/record-store.js','utf8');
const DB='surveyFieldNoteDB', WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const factory=new IDBFactory(),storage=new Map();
const localStorage={get length(){return storage.size;},key:i=>[...storage.keys()][i]||null,
 getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
async function app(userAgent){
 const ctx={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{userAgent,maxTouchPoints:userAgent.includes('iPhone')?5:0},
 console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,setTimeout,clearTimeout};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
 await ctx.SentlogRecords.init();return ctx.SentlogRecords;
}
async function disk(key){
 const request=factory.open(DB,2),db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(key);
  q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close()}
}
async function main(){
 const desktop=await app('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
 assert.equal(desktop.lazyStartup,false);
 const ws={projects:[{id:'project-a',name:'案件A',drawings:[{id:'a-1'},{id:'a-2'}]},
  {id:'project-b',name:'案件B',drawings:Array.from({length:96},(_,i)=>({id:'b-'+i}))}]};
 const drawings=ws.projects.flatMap(p=>p.drawings),original=new Blob(['synthetic retained original PDF bytes'],{type:'application/pdf'});
 desktop.batch([[WS,JSON.stringify(ws)],...drawings.map(d=>[DRAW+d.id,JSON.stringify({shapes:[{id:'item-'+d.id,memo:'未送信・保存済み',photos:[]}],text:'X'.repeat(30000)})])]);
 await desktop.settled();await desktop.writeFile('background:a-1',original);
 const expected=await disk('__sentlog_record__:'+DRAW+'b-11');
 const mobile=await app('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
 assert.equal(mobile.lazyStartup,true);assert.equal(mobile.lazyStartupVersion,1);
 assert.equal(mobile.getItem(WS),JSON.stringify(ws));
 assert.equal(mobile.keys().filter(k=>k.startsWith(DRAW)).length,98);
 for(const key of [DRAW+'a-1',DRAW+'b-11']){
  assert.throws(()=>mobile.getItem(key),e=>e.code==='RECORD_NOT_LOADED');
  assert.throws(()=>mobile.batch([[key,JSON.stringify({shapes:[]})]]),e=>e.code==='RECORD_NOT_LOADED');
 }
 assert.equal(await disk('__sentlog_record__:'+DRAW+'b-11'),expected,'cold record not overwritten');
 await mobile.ensureDrawingLoaded('a-1');assert(mobile.getItem(DRAW+'a-1').includes('未送信・保存済み'));
 assert.throws(()=>mobile.getItem(DRAW+'a-2'),e=>e.code==='RECORD_NOT_LOADED');
 await mobile.ensureProjectLoaded('project-a');assert(mobile.getItem(DRAW+'a-2').includes('未送信・保存済み'));
 assert.throws(()=>mobile.getItem(DRAW+'b-11'),e=>e.code==='RECORD_NOT_LOADED');
 mobile.pinDrawing('a-1');assert.equal(mobile.evictProject('project-a'),false,'active editor records never evicted');
 const raw=JSON.parse(mobile.getItem(DRAW+'a-1'));raw.shapes[0].memo='端末で追記した記録';
 mobile.setItem(DRAW+'a-1',JSON.stringify(raw));await mobile.settled();
 assert.equal(JSON.parse(await disk('__sentlog_record__:'+DRAW+'a-1')).shapes[0].memo,'端末で追記した記録');
 mobile.unpinDrawing('a-1');assert.equal(mobile.evictProject('project-a'),true);
 assert.throws(()=>mobile.getItem(DRAW+'a-1'),e=>e.code==='RECORD_NOT_LOADED');
 await mobile.ensureProjectLoaded('project-a');assert.equal(JSON.parse(mobile.getItem(DRAW+'a-1')).shapes[0].memo,'端末で追記した記録');
 await mobile.ensureAllLoaded();assert.equal(mobile.keys().filter(k=>k.startsWith(DRAW)).length,98);
 assert.equal(mobile.getItem(DRAW+'b-11'),expected,'all-project backup explicitly loads remaining records');
 const actual=await disk('background:a-1');
 const hash=async b=>createHash('sha256').update(Buffer.from(await b.arrayBuffer())).digest('hex');
 assert.equal(await hash(actual),await hash(original),'PDF bytes unchanged');
 console.log('PASS iPhone: cold records and keys, guarded write, targeted hydrate, pin, evict, reopened edit, full-backup and original bytes');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
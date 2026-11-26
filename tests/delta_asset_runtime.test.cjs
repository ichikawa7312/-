'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const fake=require('fake-indexeddb'),A=require('../sentlog/delta-sync-assets.js'),T=require('../sentlog/delta-sync-asset-transport.js');
const R=require('../sentlog/delta-sync-asset-runtime.js'),D=require('../sentlog/delta-sync-core.js'),C=require('../sentlog/record-collaboration.js');
const {File}=require('node:buffer');
class Dir{
 constructor(name){this.name=name;this.dirs=new Map();this.files=new Map();}
 async queryPermission(){return 'granted';}
 async getDirectoryHandle(name){if(!this.dirs.has(name))throw Error('synthetic directory missing');return this.dirs.get(name);}
 async getFileHandle(name){if(!this.files.has(name))throw Error('synthetic file missing');return {getFile:async()=>this.files.get(name)};}
 dir(name){const directory=new Dir(name);this.dirs.set(name,directory);return directory;}
}
function element(){return {style:{},children:[],setAttribute(){},append(...a){this.children.push(...a);},prepend(...a){this.children.unshift(...a);}};}
async function pcSupply(f){
 const root=new Dir('synthetic-archive'),leaf=root.dir('project').dir('photos');
 const original=new File([f.bytes],'photo-without-MIME',{type:''});leaf.files.set(original.name,original);
 f.server.pcReceipts.set(f.base.id,{asset_id:f.base.id,pc_path:root.name+'/project/photos/'+original.name,sha256:f.base.sha256,byte_size:f.bytes.size});
 const local={sentlogCloudSessionV1:JSON.stringify({access_token:'synthetic-pc-token',expires_at:9999999999,user:{id:f.scope.ownerId}}),
  sentlogPcWebDeviceV1:'30000000-0000-4000-8000-000000000001'};
 const main=element(),logs=[];
 const context=vm.createContext({location:{pathname:'/sentlog-pc/'},console,Blob,File,Response,Date,AbortController,crypto:webcrypto,
  navigator:{onLine:true},document:{hidden:false,querySelector:()=>main,createElement:element,getElementById:()=>null,addEventListener(){}},
  localStorage:{getItem:key=>local[key]??null},idbGet:async key=>key==='root'?root:null,log:text=>logs.push(text),
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,addEventListener(){},fetch:f.server.fetch});
 context.window=context;vm.runInContext(fs.readFileSync('sentlog/photo-recovery.js','utf8'),context);
 await Promise.resolve();await Promise.resolve();await context.sentlogCheckPhotoRecovery();
 assert.equal(f.server.rows[0].status,'uploaded',JSON.stringify(logs));
 assert.equal(original.type,'','PC File MIME can be empty; registered shared MIME controls upload');
 await A.verifyBlob(original,f.ref());assert.equal(leaf.files.get(original.name),original,'PC original must remain in place');
}
async function actualFiles(){
 const indexedDB=new fake.IDBFactory(),entries=new Map(),storage={get length(){return entries.size;},key:i=>[...entries.keys()][i],
  getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)};
 const root={};const context=vm.createContext({window:root,indexedDB,IDBKeyRange:fake.IDBKeyRange,Blob,AbortController,console,
  navigator:{},localStorage:storage,queueMicrotask,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync('sentlog/record-store.js','utf8'),context);await root.SentlogRecords.init();
 const records=root.SentlogRecords,owners=new Map();
 return {
  assertExclusive:key=>{const state=records.writerState(key,{ownerToken:owners.get(key)});return state.exclusive&&!state.foreignPending&&!state.failed&&state.journaled;},
  getCapabilities:()=>records.getFileWriteCapabilities(),write:(key,blob,options)=>records.writeFile(key,blob,{...options,ownerToken:owners.get(key)}),
  async withLock(key,fn){const token={};assert(!owners.has(key),'fixture file lock must not overlap');owners.set(key,token);
   try{return await fn();}finally{if(owners.get(key)===token)owners.delete(key);}},
  async read(key){
   const db=await records.openFilesDatabase();
   try{return await new Promise((resolve,reject)=>{const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(key);let value;
    q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
 };
}
require('./delta_asset_runtime_cases.js').run({A,T,R,D,C,indexedDB:fake.indexedDB,IDBObjectStore:fake.IDBObjectStore,
 pcSupply,actualFiles,onPass:name=>console.log('PASS',name),onMeasure:detail=>console.log('MEASURE',JSON.stringify(detail))}).then(results=>console.log('PASS shared photo runtime:',results.length,
 'cases including actual PC photo recovery and actual guarded record-store; synthetic accounts and bytes only'))
 .catch(e=>{console.error(e.stack||e);if(e.cause)console.error(e.cause.stack||e.cause);process.exitCode=1;});

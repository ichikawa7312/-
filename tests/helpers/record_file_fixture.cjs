'use strict';
// Actual writer, synthetic data and disposable FakeIndexedDB only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const ROOT=path.resolve(__dirname,'../..'),WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const STORES=['files','sentlog_delta_control_v1','sentlog_delta_journal_v1'];
async function fixture({factory=new IDBFactory(),local=new Map(),seed={},source=process.env.SENTLOG_RECORD_SOURCE||path.join(ROOT,'sentlog/record-store.js')}={}){
  if(!(await factory.databases()).length)for(const [key,value]of Object.entries(seed))local.set(key,String(value));
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,File,queueMicrotask,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,AbortController};
  context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(source,'utf8'),context,{filename:source});
  const records=context.SentlogRecords;await records.init();
  async function disk(){const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORES,'readonly'),out={};
    for(const name of STORES){const rows=out[name]=new Map(),q=tx.objectStore(name).openCursor();q.onsuccess=()=>{const c=q.result;if(c){rows.set(c.key,c.value);c.continue();}};}
    tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error||Error('Synthetic readonly proof aborted'));
  });}finally{db.close();}}
  async function read(key){return (await disk()).files.get(key);}
  async function state(key){return (await records.readFileStates([key]))[0];}
  return {context,records,factory,local,disk,read,state};
}
async function observe(fn){const originals={},requests=[];for(const name of ['put','add','delete','clear']){
  originals[name]=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){requests.push({method:name,store:this.name,key:name==='delete'?args[0]:args[1]??null});return originals[name].apply(this,args);};
}try{await fn(requests);return requests;}finally{for(const [name,value]of Object.entries(originals))IDBObjectStore.prototype[name]=value;}}
async function digest(value){return Buffer.from(await webcrypto.subtle.digest('SHA-256',await value.arrayBuffer())).toString('hex');}
module.exports={fixture,observe,digest,ROOT,WS,DRAW,STORES,IDBObjectStore};

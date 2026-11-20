'use strict';
const fake=require('fake-indexeddb');
globalThis.window=globalThis;globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;globalThis.IDBObjectStore=fake.IDBObjectStore;
const entries=new Map();globalThis.localStorage={get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)};
if(!globalThis.navigator)globalThis.navigator={};
require('../sentlog/record-store.js');
require('./record_file_guard_cases.js')().then(cases=>{for(const name of cases)console.log('PASS',name);console.log('PASS actual record-store guarded files:',cases.length,'cases');})
 .catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const fake=require('fake-indexeddb');
globalThis.indexedDB=new fake.IDBFactory();
globalThis.IDBObjectStore=fake.IDBObjectStore;
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:require('node:crypto').webcrypto});
globalThis.SentlogRecordCollaboration=require('../sentlog/record-collaboration.js');
globalThis.SentlogDeltaSyncCore=require('../sentlog/delta-sync-core.js');
globalThis.SentlogDeltaIndexedDB=require('../sentlog/delta-sync-indexeddb.js');
require('./delta_seed_cases.js')('node').then(cases=>{
  for(const name of cases)console.log('PASS',name);
  console.log('PASS atomic baseline seed:',cases.length,'cases');
}).catch(error=>{console.error(error);process.exitCode=1;});

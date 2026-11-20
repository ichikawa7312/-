'use strict';
const fake=require('fake-indexeddb');
globalThis.indexedDB=new fake.IDBFactory();
globalThis.IDBObjectStore=fake.IDBObjectStore;
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:require('node:crypto').webcrypto});
globalThis.SentlogDeltaIndexedDB=require('../sentlog/delta-sync-indexeddb.js');
globalThis.SentlogDeltaMigration=require('../sentlog/delta-sync-migration.js');
globalThis.SentlogDeltaLegacySource=require('../sentlog/delta-sync-legacy-source.js');
require('./delta_migration_cases.js')('node').then(cases=>{
  for(const name of cases)console.log('PASS',name);
  console.log('PASS non-destructive migration staging:',cases.length,'cases; no activation or source writes');
}).catch(e=>{console.error(e);process.exitCode=1;});

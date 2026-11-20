'use strict';
const fake=require('fake-indexeddb');
globalThis.indexedDB=new fake.IDBFactory();
globalThis.IDBDatabase=fake.IDBDatabase;
globalThis.IDBObjectStore=fake.IDBObjectStore;
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:require('node:crypto').webcrypto});
globalThis.SentlogRecordCollaboration=require('../sentlog/record-collaboration.js');
globalThis.SentlogDeltaSyncCore=require('../sentlog/delta-sync-core.js');
globalThis.SentlogDeltaIndexedDB=require('../sentlog/delta-sync-indexeddb.js');
globalThis.SentlogDeltaLegacySource=require('../sentlog/delta-sync-legacy-source.js');
globalThis.SentlogDeltaMigration=require('../sentlog/delta-sync-migration.js');
globalThis.SentlogDeltaReconcile=require('../sentlog/delta-sync-reconcile.js');
globalThis.SentlogDeltaBootstrap=require('../sentlog/delta-sync-bootstrap.js');
require('./delta_bootstrap_cases.js')('node').then(cases=>{
 for(const name of cases)console.log('PASS',name);
 console.log('PASS bootstrap:',cases.length,'shared integration cases; disposable DBs, no cloud activation or delivery claims');
}).catch(error=>{console.error(error.stack||error);if(error.cause)console.error(error.cause);process.exitCode=1;});

'use strict';
const {webcrypto}=require('node:crypto');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const {indexedDB,IDBObjectStore}=require('fake-indexeddb');
const API=require('../sentlog/delta-sync-assets.js');
const CORE=require('../sentlog/delta-sync-core.js');
require('./delta_assets_cases.js').run({API,CORE,indexedDB,IDBObjectStore,onPass:name=>console.log('PASS',name)})
  .then(results=>console.log('PASS delta photo delivery:',results.length,'synthetic cases; no live account or PC files used'))
  .catch(error=>{console.error(error.stack||error);process.exitCode=1;});

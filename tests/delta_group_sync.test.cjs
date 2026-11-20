'use strict';
const fake=require('fake-indexeddb');
globalThis.indexedDB=new fake.IDBFactory();
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:require('node:crypto').webcrypto});
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),S=require('../sentlog/delta-sync-indexeddb.js');
require('./delta_group_cases.js')({C,D,S,onPass:name=>console.log('PASS',name)}).then(results=>console.log('PASS atomic delta groups:',results.length,'cases'))
  .catch(error=>{console.error(error);process.exitCode=1;});

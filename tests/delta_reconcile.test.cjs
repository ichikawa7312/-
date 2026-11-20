'use strict';
const {webcrypto}=require('node:crypto');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const C=require('../sentlog/record-collaboration.js');
const D=require('../sentlog/delta-sync-core.js');
const API=require('../sentlog/delta-sync-reconcile.js');
require('./delta_reconcile_cases.js').run({API,C,D,onPass:name=>console.log('PASS',name)})
  .then(rows=>console.log('PASS baseline reconciliation:',rows.length,'synthetic cases; no live account or writes'))
  .catch(error=>{console.error(error.stack||error);if(error.cause)console.error(error.cause);process.exitCode=1;});

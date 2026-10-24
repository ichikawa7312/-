'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('sentlog/cloud-sync.js','utf8');
const start=source.indexOf('function normalizePdfHash');
const end=source.indexOf('function expectedDrawingRevision');
assert.ok(start>=0&&end>start,'PDF revision guard helpers must be installed');
const api=vm.runInNewContext(source.slice(start,end)+';({normalizePdfHash,latestPdfRevisionFromState,resolvePdfVersion})');

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const latest=api.latestPdfRevisionFromState({pageReplacements:{
  '2':{updatedAt:1000,pdfHash:A,pdfSize:6892202,restored:false},
  '5':{updatedAt:2000,pdfHash:B,pdfSize:7125326,restored:false}
}});
assert.equal(latest.page,5);
assert.equal(latest.pdfHash,B);
assert.equal(latest.pdfSize,7125326);

assert.equal(api.resolvePdfVersion(latest,B,A,true,false,0),'local-authoritative');
assert.equal(api.resolvePdfVersion(latest,A,B,true,false,0),'block');
assert.equal(api.resolvePdfVersion(latest,A,B,true,true,0),'take-remote');
assert.equal(api.resolvePdfVersion(latest,C,A,true,true,0),'conflict');
assert.equal(api.resolvePdfVersion(latest,'',B,false,false,0),'take-remote');

const legacy={updatedAt:200000,pdfHash:'',pdfSize:0};
assert.equal(api.resolvePdfVersion(legacy,A,B,true,false,190000),'local-authoritative');
assert.equal(api.resolvePdfVersion(legacy,A,B,true,false,100000),'block');
assert.equal(api.resolvePdfVersion(legacy,A,B,true,true,100000),'take-remote');

assert.match(source,/drawingUploadBlocks\.add\(drawingId\)/);
assert.match(source,/drawingUploadBlocks\.has\(item\.drawingId\)/);
assert.match(source,/status:'blocked-stale'/);
assert.match(source,/PDF更新待ち/);

const replacement=fs.readFileSync('sentlog/page-replacement.js','utf8');
assert.match(replacement,/pdfHash/);
assert.match(replacement,/pdfSize/);
assert.match(replacement,/mergedHash,merged\.size/);
console.log('PASS PDF revision guard blocks stale device uploads and preserves the newest page-replaced PDF');

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'sentlog/shape-dimensions.js'),'utf8');
const part=fs.readFileSync(path.join(root,'sentlog/part09.txt'),'utf8');
const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');

for(const marker of [
  "version:'v1.76'",
  'DIM_TOL_M',
  'reconcileManualDimensions',
  'reconcileWarningMessage',
  "return {text:(warning?'⚠ ':'')+formatLengthM(manual)",
  'setManualEdgeValue(s,index,targetM)',
  '手入力寸法を優先します。',
  '手入力寸法を解除（自動寸法へ）'
]) assert.ok(source.includes(marker),marker);

assert.ok(!source.includes('syncManualFromScale(s);'),'scaled edits must not pin unrelated edges');
assert.match(part,/reconcileManualDimensions\?\.\(state\.currentPage\)/);
assert.match(part,/reconcileWarningMessage\?\.\(reconciliation\)/);
assert.match(index,/shape-dimensions\.js\?v=176/);
assert.match(index,/phone-runtime\.js\?v=176/);
assert.match(sw,/sentlog-pwa-v187/);
console.log('PASS manual dimension priority');

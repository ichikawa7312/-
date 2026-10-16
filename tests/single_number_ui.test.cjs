'use strict';
// Final built sources only; no network, credentials or production data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const read=p=>fs.readFileSync(p,'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const parts=Array.from({length:9},(_,i)=>read('sentlog/part0'+(i+1)+'.txt'));
const html=parts.join('');
assert.equal((html.match(/id="typeNo"/g)||[]).length,1);
assert.ok(html.includes('<div id="damageNumberField" data-number-ui="type-only-v156"><label for="typeNo">変状No.</label>'));
assert.ok(!html.includes('id="globalNo"'));
assert.ok(!html.includes('全体No.'));
assert.ok(!html.includes('案件全体の通しNo.'));
assert.ok(html.includes('同じPDF内ではページをまたいで採番します。'));
for(const name of fs.readdirSync('sentlog').filter(p=>/\.(js|txt)$/.test(p))){
 const s=read('sentlog/'+name);
 assert.ok(!/(?:\$|getElementById)\(\s*['"]globalNo['"]\s*\)/.test(s),name+': deleted input must never be accessed');
}
// Hash the v1.55 baseline sections to prove numbering and photo ownership were
// not edited when removing their unrelated UI. Stored compatibility fields stay.
const numbering=parts[8].slice(parts[8].indexOf('function rebuildNumberingState(){'),parts[8].indexOf('function shapeAnchorPoint(s){'));
assert.equal(sha(numbering),'7e829b478d913a04321b319a9879ea3b373adcc5df0f5bb2472580ce1a9bd530');
assert.equal(sha(read('sentlog/part06.txt')),'b9ead633058149a8d06251e16423df2ff70bb9721ccbee74f71dea9864e028cf');
assert.equal(sha(read('sentlog/sync.js')),'017fa1aa7311ee6dce33c8c29a97ba1ffb458badbec7af9086108b2afa53a070');
assert.ok(numbering.includes('s.globalNo=i+1;'));
assert.ok(numbering.includes('s.typeNo=seenByType[type];'));
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
new vm.Script(read('sentlog/inspector-interaction.js'));
const loader=read('sentlog/index.html');
for(const token of ['type-only-v156','type-only-history-v156','type-only-selection-v156','type-only-inspector-v156',"'v1.56'",'inspector-interaction.js?v=156'])assert.ok(loader.includes(token));
assert.ok(read('sentlog/sw.js').includes("const CACHE='sentlog-pwa-v167'"));
assert.ok(!read('tests/instant_damage_type.test.cjs').includes("'lineWidth','globalNo','applyBtn'"));
console.log('PASS v1.56: one accessible full-width number, no deleted-input accesses, valid final scripts, unchanged numbering/photos/sync bytes, versioned loader and cache');

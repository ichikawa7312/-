'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const catalog=require('../sentlog/damage-catalog.js');
const styles=require('../sentlog/damage-styles.js');
const all=Object.values(styles.names).flat();
assert.equal(all.length,83);assert.equal(new Set(all).size,83);
assert.equal(Object.keys(styles.groups).length,6);
for(const e of catalog.entries)assert.ok(all.includes(e.name),'Unmapped: '+e.name);
assert.equal(styles.resolve('浮き').pattern,'rise');assert.equal(styles.resolve('うき').pattern,'rise');
assert.equal(styles.resolve('剥離').pattern,'fall');assert.equal(styles.resolve('ひびわれ').key,'crack');
assert.equal(styles.resolve('漏水').key,'water');assert.equal(styles.resolve('白華').key,'water');
assert.equal(styles.resolve('腐食').key,'corrosion');assert.equal(styles.resolve('移動').key,'movement');
assert.equal(styles.resolve('変形・欠損').key,'other');
const p={id:'test',damageNamesV1:[{id:'c1',name:'補修材の再剥離',displayGroup:'loss'},{id:'c2',name:'再漏水A',displayGroup:'__proto__'},{id:'c3',name:'未分類'}]};
const before=JSON.stringify(p);
assert.equal(styles.resolve('補修材の再剥離',p).key,'loss');
assert.equal(styles.resolve('補修材の再剥離',{}).key,'other');
assert.equal(styles.resolve('再漏水A',p).key,'other','Do not classify by substrings');
assert.equal(styles.resolve('未分類',p).key,'other');
assert.equal(styles.resolve('__proto__').key,'other');
assert.equal(styles.resolve('漏水',p).key,'water');assert.equal(JSON.stringify(p),before);
for(const name of all){
 for(const mode of ['hatch','color','mono','original']){
  const s=styles.styleFor(name,p,mode);assert.ok(styles.groups[s.key]);
  if(mode==='mono')assert.equal(s.color,'#333333');
  assert.equal(s.hatched,mode==='hatch'||mode==='mono');
 }
}
for(const z of [.05,.25,.5,1,2,8])assert.equal(12/styles.zoom(z)*z,12);
assert.equal(styles.zoom(NaN),1);
const source=fs.readFileSync('sentlog/damage-styles.js','utf8');new vm.Script(source);
assert.ok(!/\bfetch\s*\(/.test(source));assert.ok(!/innerHTML\s*=/.test(source));
assert.ok(!/\b(?:persist|addShape|assignNumbers|rebuildNumberingState)\s*\(/.test(source));
assert.ok(!/state\.[a-zA-Z]+\s*=/.test(source),'Must not assign annotation state');
assert.ok(source.includes("e.style.pointerEvents!=='none'"));
const loader=fs.readFileSync('sentlog/index.html','utf8'),worker=fs.readFileSync('sentlog/sw.js','utf8');
assert.ok(loader.includes('damage-styles.js?v=153'));assert.ok(loader.includes('damage-catalog.js?v=153'));
assert.ok(worker.includes("'damage-styles.js'"));assert.ok(worker.includes('sentlog-pwa-v164'));
assert.ok(fs.readFileSync('sentlog/damage-catalog.js','utf8').includes('newNameGroup'));
console.log('PASS v1.53: 83 names explicitly mapped to 6 families; float/peel variants; aliases; neutral unknowns; per-project custom groups; immutable records; four modes; offline cache');

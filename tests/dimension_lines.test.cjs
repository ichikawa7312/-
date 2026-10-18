'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const d=require(path.join(root,'sentlog/dimension-lines.js'));

assert.equal(d.isDimension({kind:'dimension',recordKind:'dimension-line',points:[{x:0,y:0},{x:1,y:0}]}),true);
assert.equal(d.isDimension({kind:'line',points:[{x:0,y:0},{x:1,y:0}]}),false);
const g=d.dimensionGeometry({x:10,y:20},{x:110,y:20},25,8,4);
assert.equal(g.d1.x,10);assert.equal(g.d1.y,45);assert.equal(g.d2.x,110);assert.equal(g.d2.y,45);
assert.equal(Math.round(g.angle),0);assert.equal(g.arrow1.length,3);assert.equal(g.arrow2.length,3);
assert.equal(d.formatMetresFromMm(1250),'1.250 m');
assert.equal(d.formatMetresFromMm(50),'0.050 m');
assert.equal(d.editBehavior(false),'manual-label','unscaled drawings must only edit displayed text');
assert.equal(d.editBehavior(true),'scaled-length','scaled drawings may resize from a real dimension');
let r=d.resizedEnd({x:0,y:0},{x:10,y:0},2000,3,{width:100,height:100});
assert.deepEqual(r.end,{x:15,y:0});
r=d.resizedEnd({x:5,y:5},{x:15,y:15},1000,2,{width:100,height:100});
assert.equal(r.end.x,25);assert.equal(r.end.y,25,'resize keeps the original direction');
assert.equal(d.resizedEnd({x:0,y:0},{x:10,y:0},2000,30,{width:100,height:100}).error,'outside');
assert.equal(d.resizedEnd({x:0,y:0},{x:10,y:0},2000,0).error,'invalid');

const source=fs.readFileSync(path.join(root,'sentlog/dimension-lines.js'),'utf8');
for(const marker of ["recordKind:'dimension-line'",'lineLengthMm','pushHistory','manualText','SentlogDimensionLines'])assert.ok(source.includes(marker),marker);
const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/dimension-lines\.js\?v=173/);assert.match(index,/SentlogDimensionLines/);assert.match(index,/phone-runtime\.js\?v=173/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');assert.match(sw,/dimension-lines\.js/);assert.match(sw,/sentlog-pwa-v184/);
const sync=fs.readFileSync(path.join(root,'sentlog/sync-view.js'),'utf8');assert.match(sync,/SentlogDimensionLines\?\.isEditing/);
console.log('PASS dimension lines: independent records, CAD geometry, manual unscaled labels, scale-only length resize, sync/cache integration');

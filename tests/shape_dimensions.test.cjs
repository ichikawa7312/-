'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const d=require(path.join(root,'sentlog/shape-dimensions.js'));

assert.deepEqual(d.rectCorners({x:10,y:20,w:30,h:40}),[
 {x:10,y:20},{x:40,y:20},{x:40,y:60},{x:10,y:60}
]);
assert.deepEqual(d.rectCorners({x:40,y:60,w:-30,h:-40}),[
 {x:10,y:20},{x:40,y:20},{x:40,y:60},{x:10,y:60}
]);
const edges=d.orderedEdges([{x:0,y:0},{x:10,y:0},{x:10,y:5},{x:0,y:5}],true);
assert.equal(edges.length,4);
assert.equal(edges[0].index,0);assert.deepEqual(edges[0].a,{x:0,y:0});assert.deepEqual(edges[0].b,{x:10,y:0});
assert.equal(edges[3].index,3);assert.deepEqual(edges[3].a,{x:0,y:5});assert.deepEqual(edges[3].b,{x:0,y:0},
 'last polygon edge must close back to the stored first vertex');
let p=d.edgeLabelPlacement({x:0,y:0},{x:10,y:0},{x:5,y:5},12);
assert.equal(p.angle,0);assert.ok(p.y<0,'top edge label goes away from centre');
p=d.edgeLabelPlacement({x:10,y:0},{x:10,y:10},{x:5,y:5},12);
assert.equal(p.angle,90);assert.ok(p.x>10,'right edge label goes away from centre');
assert.equal(d.formatLengthMm(800),'0.800 m');
assert.equal(d.formatAreaMm2(620000),'0.620 m²');
assert.equal(d.representativeFromMeasurements('rect',{widthMm:800,heightMm:450}),'0.800 × 0.450 m');
assert.equal(d.representativeFromMeasurements('polygon',{areaMm2:620000}),'A=0.620 m²');
assert.equal(d.representativeFromMeasurements('freehand-area',{areaMm2:125000}),'A=0.125 m²');
assert.equal(d.representativeFromMeasurements('line',{lengthMm:1350}),'L=1.350 m');

const source=fs.readFileSync(path.join(root,'sentlog/shape-dimensions.js'),'utf8');
for(const marker of ["s.kind==='rect'","s.kind==='polygon'","SentlogCrackWidth?.isConcreteCrack","data.shapeSummaryId","sentlog-shape-edge-dimension"])
 assert.ok(source.includes(marker),marker);
const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/shape-dimensions\.js\?v=174/);assert.match(index,/SentlogShapeDimensions/);assert.match(index,/phone-runtime\.js\?v=174/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/shape-dimensions\.js/);assert.match(sw,/sentlog-pwa-v185/);
console.log('PASS shape dimensions: rectangle two-side labels, polygon ordered closed edges, parallel/outward text, summaries, crack-width separation');

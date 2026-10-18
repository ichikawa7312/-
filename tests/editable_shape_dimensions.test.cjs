'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const d=require(path.join(root,'sentlog/shape-dimensions.js'));

assert.equal(d.manualEdgeM({edgeDimensionsM:{0:.8}},0),.8);
assert.equal(d.manualEdgeM({edgeDimensionsM:{}},0),null);
assert.equal(d.formatLengthM(.8),'0.800 m');

let r=d.rectResizeGeometry({x:10,y:20,w:100,h:50},0,1.5,{width:500,height:500});
assert.deepEqual(r.geometry,{x:10,y:20,w:150,h:50});
r=d.rectResizeGeometry({x:10,y:20,w:100,h:50},1,.5,{width:500,height:500});
assert.deepEqual(r.geometry,{x:10,y:20,w:100,h:25});
assert.equal(d.rectResizeGeometry({x:450,y:20,w:40,h:50},0,2,{width:500,height:500}).error,'outside');

const aligned=(a,b)=>Math.abs(a.x-b.x)<1e-7||Math.abs(a.y-b.y)<1e-7||Math.abs(Math.abs(a.x-b.x)-Math.abs(a.y-b.y))<1e-7;
const rect=[{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50}];
r=d.resizePolygonEdge(rect,0,1.5,{width:500,height:500},aligned,null);
assert.ok(!r.error,r);assert.deepEqual(r.points,[{x:0,y:0},{x:150,y:0},{x:150,y:50},{x:0,y:50}]);
assert.ok(r.points.every((p,i,a)=>aligned(p,a[(i+1)%a.length])));
r=d.resizePolygonEdge(rect,3,2,{width:500,height:500},aligned,null);
assert.ok(!r.error,r);assert.equal(Math.hypot(r.points[0].x-r.points[3].x,r.points[0].y-r.points[3].y),100);
assert.ok(r.points.every((p,i,a)=>aligned(p,a[(i+1)%a.length])));

const source=fs.readFileSync(path.join(root,'sentlog/shape-dimensions.js'),'utf8');
for(const marker of ['edgeDimensionsM','縮尺未設定：寸法値だけを記録','applyScaledPolygon','applyScaledRect','shapeDimensionHitId'])
 assert.ok(source.includes(marker),marker);
const sync=fs.readFileSync(path.join(root,'sentlog/sync-view.js'),'utf8');
assert.match(sync,/SentlogShapeDimensions\?\.isEditing/);
const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/shape-dimensions\.js\?v=175/);assert.match(index,/phone-runtime\.js\?v=175/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');assert.match(sw,/sentlog-pwa-v186/);
console.log('PASS editable shape dimensions: unscaled stored values, rect resizing, closed polygon chain resizing, sync/cache integration');

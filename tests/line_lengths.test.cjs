'use strict';
const assert=require('node:assert/strict');
const {isLine,manualMetres,resizePath}=require('../sentlog/line-lengths.js');
const length=(p,sx=1,sy=1)=>p.slice(1).reduce((n,b,i)=>n+Math.hypot((b.x-p[i].x)*sx,(b.y-p[i].y)*sy),0);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
for(const kind of ['line','freehand-line'])assert.ok(isLine({kind,points:[{x:0,y:0},{x:10,y:0}]}));
for(const recordKind of ['drawing-memo','field-record','dimension-line'])assert.ok(!isLine({kind:'line',recordKind,points:[{},{}]}));
assert.equal(manualMetres({lineLengthM:1.2}),1.2);
for(const value of [null,0,-1,Infinity,NaN,10001])assert.equal(manualMetres({lineLengthM:value}),null);
for(const points of [
 [{x:100,y:100},{x:200,y:100}],
 [{x:100,y:100,p:.2},{x:130,y:140,p:.8},{x:160,y:100,p:.4},{x:190,y:140,p:.1}],
 [{x:100,y:100},{x:100,y:100},{x:150,y:150},{x:100,y:100}]
]){
 const before=JSON.stringify(points),actual=length(points,2,3),target=actual/1000*1.4;
 const r=resizePath(points,actual,target,{width:1000,height:700});
 assert.ok(!r.error);near(length(r.points,2,3),target*1000);
 assert.deepEqual(r.points[0],points[0]);assert.equal(r.points.length,points.length);
 for(let i=0;i<points.length;i++){
  near(r.points[i].x-points[0].x,(points[i].x-points[0].x)*1.4);
  near(r.points[i].y-points[0].y,(points[i].y-points[0].y)*1.4);
  assert.equal(r.points[i].p,points[i].p);
 }
 assert.equal(JSON.stringify(points),before,'input geometry must not be mutated');
}
const curve=[{x:10,y:10},{x:13,y:14},{x:16,y:10}];
near(length(curve),10);near(resizePath(curve,10,.02).points[2].x,22);
assert.equal(resizePath([{x:900,y:100},{x:950,y:100}],50,1,{width:1000,height:700}).error,'outside');
for(const [pts,mm,m] of [[curve,0,1],[curve,NaN,1],[curve,10,Infinity],[curve,10,0],[curve,10,-1],[curve,10,10001],[[{x:NaN,y:0},{x:1,y:0}],1,1]])
 assert.equal(resizePath(pts,mm,m).error,'invalid');
console.log('PASS straight/freehand length geometry: path sum, fixed start, all bends, anisotropic scale, metadata, bounds and invalid input');

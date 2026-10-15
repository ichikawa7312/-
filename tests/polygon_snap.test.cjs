'use strict';
// Real octilinear polygon functions from the app, tested with synthetic points.
// No access to the company PC, stored projects, images or cloud.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('sentlog/part09.txt','utf8');
const start=src.indexOf('// Octilinear ("CAD-style") polygon geometry.');
const end=src.indexOf('// Keep each live contact until its own up/cancel event.',start);
assert(start>0&&end>start,'actual polygon snap implementation found');
const helper=src.slice(start,end);
const previewStart=src.indexOf('function renderPreview(){'),previewEnd=src.indexOf("\n\n$('newProjectBtn').onclick=",previewStart);
assert(previewStart>0&&previewEnd>previewStart,'actual polygon renderPreview found');
const children=[];
const svg={appendChild(item){children.push(item)}};
const makeEl=(tag,attrs)=>({tag,attrs,style:{},dataset:{},setAttribute(k,v){this.attrs[k]=v}});
const saved=[];
const ctx={
 console,Math,Number,Array,JSON,scale:1,drawing:null,render:()=>{children.length=0},
 renderPreview:()=>{},svg,makeEl,$:()=>({value:'0.8'}),
 addShape:s=>saved.push(JSON.parse(JSON.stringify(s)))
};
vm.createContext(ctx);
vm.runInContext(helper,ctx);
const point=(x,y)=>({x,y});
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const eq=(a,b,epsilon=1e-6)=>assert(dist(a,b)<epsilon,JSON.stringify({a,b}));
const shapeIsSnapped=points=>points.every((p,i)=>ctx.polygonAligned(p,points[(i+1)%points.length]));
const from=point(100,200);
for(const [dx,dy] of [[91,3],[80,51],[0,103],[-73,95],[-110,7],[-64,-81],[4,-100],[90,-66]]){
 const raw=point(from.x+dx,from.y+dy),p=ctx.snapPolygonPoint(from,raw);
 assert(ctx.polygonAligned(from,p),'all eight compass directions must snap');
 assert(dist(from,p)>15,'point should not collapse on its anchor');
}
const samples=[[100,20],[100,60],[100,250],[15,100],[-90,30],[-15,-150],[-100,-89],[1,-45]];
for(const [dx,dy] of samples){
 const p=ctx.snapPolygonPoint(point(0,0),point(dx,dy));
 assert(ctx.polygonAligned(point(0,0),p));
 assert(dist(p,point(dx,dy))<=dist(point(0,0),point(dx,dy)),'snap must project towards finger');
}
for(const scale of [.05,.25,1,4,8]){
 ctx.scale=scale;
 const end=ctx.snapPolygonPoint(point(100,100),point(170,120));
 eq(end,point(170,100)); // Snap uses PDF world coordinates, not display zoom.
}
const rectangle=[point(0,0),point(120,0),point(120,80),point(0,80)];
assert.deepEqual(ctx.polygonClosingRoute(rectangle),[],'90° closing side needs no new corner');
const diagonal=[point(0,0),point(100,0),point(100,100)];
assert.deepEqual(ctx.polygonClosingRoute(diagonal),[],'45° closing side needs no new corner');
const awkward=[point(0,0),point(120,0),point(120,100),point(70,100)];
const close=ctx.polygonClosingRoute(awkward);
assert(close&&close.length===1,'non-octilinear closing edge gets exactly one auto bend');
const closed=[...awkward,...close];
assert(shapeIsSnapped(closed),'every edge including auto-close must stay 0, 45 or 90 degrees');
assert(ctx.polygonSimple(closed),'automatic bend must avoid creating a self-intersecting polygon');
assert.equal(ctx.polygonClosingRoute([point(0,0),point(50,0),point(20,0)]),null,
 'a collinear zero-area polygon cannot be saved');
const invalid=[point(0,0),point(100,0),point(100,100),point(0,100),point(100,50)];
assert.equal(ctx.polygonClosingRoute(invalid),null,'self-intersecting draft cannot be closed');
// Pointer preview shows only projected target, without committing any geometry.
ctx.drawing={kind:'polygon',points:[point(100,100)]};
const before=JSON.stringify(ctx.drawing.points);
let hover=ctx.polygonPreviewAt(point(200,116));
eq(hover.points[1],point(200,100));
assert.equal(hover.closing,false);
assert.equal(JSON.stringify(ctx.drawing.points),before,'preview never writes to the shape');
ctx.renderPreview=vm.runInContext('('+src.slice(previewStart,previewEnd)+')',ctx);
vm.runInContext('polygonDraftCursor=polygonPreviewAt({x:200,y:116})',ctx);
ctx.renderPreview();
assert(children.some(x=>x.tag==='polyline'&&x.attrs.stroke==='#2563eb'&&x.attrs['stroke-dasharray']),
 'blue dashed snapped guide must appear');
assert(children.some(x=>x.tag==='circle'&&x.attrs.fill==='#2563eb'),'projected endpoint dot visible');
const previous=JSON.stringify(ctx.drawing.points);
assert.equal(JSON.stringify(ctx.drawing.points),previous,'render preview is read only');
// Adding 4 vertices and touching close should save one area with all angles snapped.
ctx.drawing=null;ctx.renderPreview=()=>{};
ctx.commitPolygonVertex(point(200,180));
ctx.commitPolygonVertex(point(360,215));
ctx.commitPolygonVertex(point(385,360));
ctx.commitPolygonVertex(point(245,350));
assert.equal(saved.length,0,'unfinished draft never saves');
assert.equal(ctx.drawing.points.length,4);
assert(shapeIsSnapped([...ctx.drawing.points,point(200,180)])===false,'unclosed final edge may need auto bend');
const closingHover=ctx.polygonPreviewAt(point(202,185));
assert.equal(closingHover.closing,true);
assert.equal(closingHover.valid,true);
assert(closingHover.points.length>=2);
for(let i=1;i<closingHover.points.length;i++)
 assert(ctx.polygonAligned(closingHover.points[i-1],closingHover.points[i]));
ctx.commitPolygonVertex(point(202,185));
assert.equal(saved.length,1,'one saved polygon when tapping near first vertex');
assert.equal(ctx.drawing,null,'draft cleared after commit');
assert.equal(saved[0].kind,'polygon');
assert(shapeIsSnapped(saved[0].points),'saved polygon edges and closure all valid');
assert(ctx.polygonSimple(saved[0].points),'saved polygon not self-intersecting');
assert.equal(saved[0].points.length,5,'one automatic corner on closing if necessary');
assert(src.includes("if(e.pointerType==='touch'||e.pointerType==='pen')"),'finger/Pencil press-slide-release supported');
assert(src.includes("if(!cancelled&&tool==='polygon')commitPolygonVertex(point(e))"),
 'finger/Pencil commit occurs on lift, not before preview');
assert(src.includes("if(tool==='freehand-line'||tool==='freehand-area')drawing.points.push(p)"),
 'unconstrained freehand drawing preserved');
console.log('PASS octilinear polygon: eight angle directions, projection, auto 0/45/90 closure, no self intersections, live blue guide, touch/Pencil release, unmodified freehand');

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const Core=require('../sentlog/auto-trace-core.js');
const ui=fs.readFileSync(path.join(root,'sentlog/auto-trace.js'),'utf8');
const html=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
function photo(w,h,base=102){
 const data=new Uint8ClampedArray(w*h*4);
 for(let i=0;i<w*h;i++){const k=i*4;data[k]=base;data[k+1]=base;data[k+2]=base;data[k+3]=255;}
 function dot(x,y,r=2,value=249){for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
  const nx=Math.round(x+dx),ny=Math.round(y+dy);if(nx<1||ny<1||nx>=w-1||ny>=h-1)continue;
  const k=(ny*w+nx)*4;data[k]=value;data[k+1]=value;data[k+2]=Math.max(0,value-2);
 }}
 function line(x0,y0,x1,y1,r=2){const steps=Math.ceil(Math.hypot(x1-x0,y1-y0)*2);for(let j=0;j<=steps;j++){const t=j/steps;dot(x0+(x1-x0)*t,y0+(y1-y0)*t,r);}}
 return {width:w,height:h,data,dot,line};
}
const image=photo(270,175);
for(let y=12;y<155;y++)image.dot(22+7*Math.sin(y/16),y);
image.line(119,28,220,28);image.line(220,28,220,143);image.line(220,143,119,143);image.line(119,143,119,28);
image.line(135,119,197,53);
const out=Core.analyze(image);
assert.ok(out.candidates.some(x=>x.kind==='line'),'chalk crack should be a line');
assert.ok(out.candidates.some(x=>x.kind==='area'),'enclosed hatched area should be an area');
assert.ok(out.candidates.filter(x=>x.kind==='area').some(x=>Math.abs(Core.signedArea(x.points))>8000));
assert.ok(out.candidates.filter(x=>x.kind==='line').every(x=>x.points.every(p=>p.x<110)),'internal hatch must not become another crack');
assert.equal(Core.analyze(photo(100,70)).candidates.length,0,'uniform background must not create candidates');

const illuminated=photo(280,180,110);
for(let y=0;y<180;y++)for(let x=150;x<280;x++){
 const k=(y*280+x)*4;
 illuminated.data[k]=illuminated.data[k+1]=illuminated.data[k+2]=240;
}
for(let y=12;y<165;y++)illuminated.dot(36+13*Math.sin(y/17),y);
const filtered=Core.analyze(illuminated,{sensitivity:'standard'});
assert.equal(filtered.candidates.filter(c=>c.kind==='line').length,1,'A bright concrete/shadow boundary must not be treated as chalk');
assert.ok(filtered.candidates.some(c=>c.kind==='line'&&c.points.every(p=>p.x<80)),'The chalk curve should be traced');
const roi=Core.analyze(illuminated,{sensitivity:'standard',region:{x0:0,y0:0,x1:115,y1:180}});
assert.ok(roi.candidates.length>=1,'The limited detection region should keep the chalk inside it');
assert.ok(roi.candidates.every(c=>c.points.every(p=>p.x<=115)),'No detection may extend beyond the selected region');
const low=photo(140,130,158);
for(let y=15;y<120;y++)low.dot(42+12*Math.sin(y/13),y,2,180);
assert.equal(Core.analyze(low,{sensitivity:'standard'}).candidates.length,0,'Normal sensitivity should suppress weak whitening');
assert.ok(Core.analyze(low,{sensitivity:'wide'}).candidates.some(c=>c.kind==='line'),'Wide sensitivity should allow faint chalk');
assert.ok(Core.settingsFor({sensitivity:'strict'}).minBrightness>Core.settingsFor({sensitivity:'standard'}).minBrightness);
assert.ok(Core.settingsFor({sensitivity:'wide'}).contrast<Core.settingsFor({sensitivity:'standard'}).contrast);
assert.deepEqual(Core.normalizeRegion({x0:50,y0:70,x1:5,y1:10},100,80),{x0:5,y0:10,x1:50,y1:70});

assert.equal(Core.pathLength([{x:0,y:0},{x:3,y:4}]),5);
assert.ok(Core.pointInPolygon({x:3,y:3},[{x:0,y:0},{x:8,y:0},{x:8,y:8},{x:0,y:8}]));
assert.ok(!Core.pointInPolygon({x:10,y:3},[{x:0,y:0},{x:8,y:0},{x:8,y:8},{x:0,y:8}]));
for(const token of ["capture','environment'","photoRatio()","pushHistory(ctx.page)","shape.lineLengthM=","assignNumbers(shape);state.shapes.push(shape)","savePhotoBlob(photoId,photo,ctx.drawingId)"]){
 assert.ok(ui.includes(token),'missing integration: '+token);
}
assert.ok(!ui.includes("recordKind:'auto"),'no parallel record type');
assert.equal((html.match(/auto-trace-core\.js\?v=221/g)||[]).length,1);
assert.equal((html.match(/auto-trace\.js\?v=221/g)||[]).length,1);
assert.ok(sw.includes("'auto-trace-core.js','auto-trace.js'"));
assert.ok(ui.includes('sl-trace-candidates-panel')&&ui.includes('sl-trace-settings'));
assert.ok(ui.includes('function reanalyze()')&&ui.includes("session.mode='region'"));
console.log('PASS auto-trace: line/hatched area/blank image and standard record integration');

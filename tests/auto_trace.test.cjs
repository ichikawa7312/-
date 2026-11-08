'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const Core=require('../sentlog/auto-trace-core.js');
const ui=fs.readFileSync(path.join(root,'sentlog/auto-trace.js'),'utf8');
const album=fs.readFileSync(path.join(root,'sentlog/auto-trace-album.js'),'utf8');
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
for(const token of ["capture','environment'","photoRatio()","pushHistory(ctx.page)","shape.lineLengthM=","assignNumbers(shape);state.shapes.push(shape)","root.SentlogAutoTraceAlbum.capture(file"]){
 assert.ok(ui.includes(token),'missing integration: '+token);
}
assert.ok(!ui.includes("recordKind:'auto"),'no parallel record type');
assert.equal((html.match(/auto-trace-core\.js\?v=231/g)||[]).length,1);
assert.equal((html.match(/auto-trace\.js\?v=231/g)||[]).length,1);
assert.equal((html.match(/auto-trace-album\.js\?v=231/g)||[]).length,1);
assert.ok(sw.includes("'auto-trace-core.js','auto-trace-album.js','auto-trace.js'"));
assert.ok(album.includes('state.autoTracePhotos')&&album.includes('root.SentlogOriginalPhotos')&&album.includes('savePhotoBlob(photoId,shared,drawingId)'));
assert.ok(!ui.includes('ctx.attach&&ctx.sourcePhoto')&&!ui.includes('撮影写真も各変状に添付'));
assert.ok(ui.includes('sourceAutoTracePhotoId:ctx.sourceMeta?.id'));
assert.ok(album.includes("'自動描写'")&&album.includes('renderDrawings=function()'));
assert.ok(album.includes("card.querySelector('.drawing-group-actions')")&&album.includes("'[data-ledger-button]'"),'Album action must appear beside photo ledger, rename and delete on the group card');
assert.ok(album.includes('filter(g=>groupId==null||g.id===groupId)'),'Opening one drawing No. must not expose photographs from other groups');
assert.ok(!album.includes("manager-card sl-album-folder"),'Separate full-size folder card must be removed');
assert.ok(album.includes('addGroupButtons()'),'Album actions need to be installed after drawing list rendering');
assert.ok(album.includes("'.sl-album-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))"),'Desktop group actions must use two equal columns');
assert.ok(album.includes(".sl-album-actions [data-ledger-button]{order:1}")&&album.includes(".sl-album-actions .delete{order:4}"),'Ledger and auto-trace above rename and delete');
assert.ok(!album.includes("'.sl-album-actions{display:grid!important"),'Manual sort mode must still hide group actions');
assert.ok(album.includes("min-height:44px!important"),'Card actions must remain finger-sized');

assert.ok(album.includes('selectedShape()')&&album.includes('shape.photos.push('));
assert.ok(ui.includes('sl-trace-candidates-panel')&&ui.includes('sl-trace-settings'));
assert.ok(ui.includes('function reanalyze()')&&ui.includes("session.mode='region'"));
const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
const pc=fs.readFileSync(path.join(root,'sentlog-pc/index.html'),'utf8');
const recovery=fs.readFileSync(path.join(root,'sentlog/photo-recovery.js'),'utf8');
const merger=fs.readFileSync(path.join(root,'sentlog/sync-merge.js'),'utf8');
assert.ok(cloud.includes('st.autoTracePhotos||[]')&&cloud.includes("photo_album:item.album"),'Standalone source photos must be uploaded as normal verified photo assets');
assert.ok(pc.includes("a.metadata?.photo_album==='auto-trace'")&&pc.includes("subdir(d,'自動描写')"),'Verified PC copy belongs in separate evidence folder');
assert.ok(recovery.includes('state.autoTracePhotos||[]'),'Verified remote originals must be available for redelivery');
assert.ok(merger.includes('st.autoTracePhotos=entities('),'Concurrent device additions must merge by photo ID');
// This test runs AFTER the final photo-album builder applies the guarded merge hook.
const M=require('../sentlog/sync-merge.js');
const identical=(a)=>JSON.parse(JSON.stringify(a));
const drawing={id:'d',name:'側面',sourceType:null,fileName:'',updatedAt:1};
const mk=photos=>({
 project:{id:'p',name:'現場',updatedAt:1,drawings:[identical(drawing)]},
 drawings:[{meta:identical(drawing),state:{
   sourceType:null,fileName:'',pageSettings:{},pageRotations:{},shapes:[],
   autoTracePhotos:photos
 }}]
});
const x=mk([{id:'trace-ipad',name:'ipad.jpg',createdAt:1}]);
const y=mk([{id:'trace-iphone',name:'iphone.jpg',createdAt:2}]);
const merged=M.merge(x,y,{preserve:true});
assert.ok(merged.ok,'Independent photo captures should merge by ID: '+JSON.stringify(merged.conflicts));
assert.deepEqual(merged.payload.drawings[0].state.autoTracePhotos.map(p=>p.id),['trace-iphone','trace-ipad']);
assert.equal(merged.payload.drawings[0].state.shapes.length,0);
const conflict=mk([{id:'trace-ipad',name:'conflict.jpg',createdAt:1}]);
assert.equal(M.merge(x,conflict,{preserve:true}).ok,false,'Conflicting metadata for one photo must not be overwritten');
assert.ok(M.merge(x,y,{base:mk([])}).ok);
console.log('PASS auto-trace: offline source album, separated ledger, verified cloud/PC, merge and recovery');

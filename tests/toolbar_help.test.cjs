'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync('sentlog/toolbar-icons.js','utf8');
const helper=text.match(/function tooltipPosition\(r,size,v,kind\)\{[\s\S]+?(?=\n  \/\/ END TOOLTIP POSITION)/)[0];
const place=vm.runInNewContext(helper+';tooltipPosition');
function check(r,size,v,kind){
 const p=place(r,size,v,kind);if(!p)return p;
 assert.ok(p.left>=v.left+8-.01&&p.top>=v.top+8-.01);
 assert.ok(p.left+p.width<=v.left+v.width-8+.01&&p.top+p.height<=v.top+v.height-8+.01);
 assert.ok(p.left+p.width<=r.left||p.left>=r.right||p.top+p.height<=r.top||p.top>=r.bottom,'Tooltip overlaps its owner');
 return p;
}
for(const width of [320,360,390,820,1280,1600]){
 const v={left:0,top:0,width,height:844},size={width:Math.min(360,width-16),height:48};
 for(const left of [8,55,width-52]){
  const r={left,right:left+44,top:64,bottom:108};
  assert.equal(check(r,size,v,'hold').placement,'above');
  assert.equal(check(r,size,v,'hover').placement,'below');
 }
}
// Nonzero visualViewport offsets and short-height fallback remain inside the visible area.
for(const width of [160,240,390,820])for(const height of [100,160,390,844]){
 const v={left:23,top:41,width,height};
 for(const dx of [8,60,width-52])for(const dy of [8,40,height-52]){
  const r={left:v.left+dx,right:v.left+dx+44,top:v.top+dy,bottom:v.top+dy+44};
  for(const h of [48,68,120])for(const kind of ['hold','hover','focus'])check(r,{width:Math.min(360,width-16),height:h},v,kind);
 }
}
const side=check({left:8,right:52,top:10,bottom:54},{width:360,height:68},{left:0,top:0,width:820,height:390},'hold');
assert.equal(side.placement,'right');
const clipped=check({left:8,right:52,top:30,bottom:74},{width:280,height:120},{left:0,top:0,width:320,height:130},'hold');
assert.ok(clipped.height<120);
for(const marker of ["tip.dataset.input=kind","dismissPointers","dismissClickUntil","tipKind==='hold'","overflow:auto","visualViewport?.addEventListener('scroll'"])assert.ok(text.includes(marker));
console.log('PASS v1.52: above-first hold, mouse below, visual viewport offsets, edge/fallback/clipped containment and owner nonoverlap');

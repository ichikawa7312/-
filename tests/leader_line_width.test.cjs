'use strict';
// Check the actual renderer, without changing files or requiring user data.
// The extreme-fine damage stroke is 0.8px; leaders must remain 0.6px at all zoom levels.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('sentlog/part09.txt','utf8');
const start=source.indexOf('function render(){');
const end=source.indexOf('\nfunction selectShape(',start);
assert(start>=0&&end>start,'renderer not found');
const renderCode=source.slice(start,end);
const originalMarkerCode=source.slice(source.indexOf('function drawLeaderMarker('),source.indexOf('\nfunction syncLeaderMarkerUI('));
assert(originalMarkerCode.includes("'stroke-width':Math.max(1,1.2/Math.max(scale,.001))"),'marker outline must remain unchanged');
const shape={id:'crack-1',kind:'line',points:[{x:10,y:12},{x:45,y:55}],strokeWidth:0.8,autoLabel:'ひび割れ①',photos:[]};
const svg={
  children:[],
  set innerHTML(value){this.children=[]},
  appendChild(node){this.children.push(node)}
};
const makeEl=(tag,attrs)=>({tag,attrs,style:{},dataset:{},textContent:''});
const ctx={
  svg,makeEl,tool:'line',selected:null,
  state:{shapes:[shape]},currentShapes:()=>[shape],
  visualStroke:s=>Number(s.strokeWidth)/Math.max(ctx.scale,.001),
  hitStroke:()=>18/Math.max(ctx.scale,.001),
  shouldDrawLeader:()=>true,
  leaderAnchorPoint:()=>({x:12,y:16}),
  getLabelPos:()=>({x:52,y:66}),
  labelMetrics:()=>({fontSize:16,width:90,height:24}),
  drawLeaderMarker:()=>makeEl('circle',{cx:12,cy:16,r:3.5}),
  setSelectionControls:()=>{}
};
vm.createContext(ctx);
vm.runInContext(renderCode,ctx);
for(const zoom of [0.05,0.5,1,2,4,8]){
  ctx.scale=zoom;
  for(const selected of [null,shape.id]){
    ctx.selected=selected;ctx.render();
    const lead=svg.children.filter(n=>n.tag==='line');
    const damage=svg.children.filter(n=>n.tag==='polyline');
    const texts=svg.children.filter(n=>n.tag==='text');
    const markers=svg.children.filter(n=>n.tag==='circle');
    assert.equal(lead.length,1);
    assert.equal(damage.length,1);
    assert.equal(texts.length,1);
    assert.equal(markers.length,1);
    const visualLeader=lead[0].attrs['stroke-width']*zoom;
    const visualDamage=damage[0].attrs['stroke-width']*zoom;
    assert(Math.abs(visualLeader-0.6)<1e-8,'leader must stay 0.6px');
    assert(Math.abs(visualDamage-0.8)<1e-8,'extra-fine damage line must stay 0.8px');
    assert(visualLeader<visualDamage,'leader must be thinner than extreme-fine damage');
    assert.equal(lead[0].attrs.x1,12);
    assert.equal(lead[0].attrs.y1,16);
    assert.equal(lead[0].attrs.x2,52);
    assert.equal(lead[0].attrs.y2,66);
    assert.equal(lead[0].attrs.stroke,selected?'#2563eb':'#374151');
    assert.equal(texts[0].textContent,'ひび割れ①');
    assert.equal(lead[0].style.pointerEvents,'none');
  }
}
// Photo badges should sit 4 visual pixels beyond the actual label glyphs,
// not beyond the wider, padded click target. The symbol, count and line are unchanged.
ctx.makeEl=(tag,attrs)=>{
  const item=makeEl(tag,attrs);
  if(tag==='text' && attrs['text-anchor']==='middle')
    item.getComputedTextLength=()=>[...item.textContent].length*16;
  return item;
};
for(const zoom of [0.25,0.5,1,2,4]){
  ctx.scale=zoom;
  for(const selected of [null,shape.id]){
    ctx.selected=selected;
    for(const [label,count] of [['腐食①',1],['ひび割れ①',3],['漏水①',12]]){
      shape.autoLabel=label;
      shape.photos=Array.from({length:count},(_,i)=>({id:'photo-'+i}));
      ctx.render();
      const texts=svg.children.filter(n=>n.tag==='text');
      const badge=texts.find(n=>n.textContent.startsWith('📷'));
      const name=texts.find(n=>n.textContent===label);
      assert.equal(texts.length,2,'one label and one photo badge, no duplicates');
      assert(badge && name,'photo badge and damage label should both render');
      assert.equal(badge.textContent,'📷'+count);
      assert.equal(name.attrs['font-size'],16,'label size unchanged');
      assert.equal(badge.attrs['font-size'],Math.max(12,13/zoom),'photo badge size unchanged');
      assert.equal(name.attrs['dominant-baseline'],'middle','label must use middle baseline');
      assert.equal(badge.attrs['dominant-baseline'],'middle','photo badge must use same middle baseline');
      assert.equal(badge.attrs.y,name.attrs.y,'photo badge and damage label must share the exact vertical anchor');
      assert.equal(badge.attrs['stroke-width'],3,'photo badge text outline unchanged');
      const labelRight=name.attrs.x+name.getComputedTextLength()/2;
      const visualGap=(badge.attrs.x-labelRight)*zoom;
      assert(Math.abs(visualGap-4)<1e-8,
        'label/badge must have a 4px visual gap regardless of zoom and text length');
      assert.equal(svg.children.filter(n=>n.tag==='line').length,1,'leader remains present');
      assert.equal(svg.children.filter(n=>n.tag==='circle').length,1,'leader tip remains present');
    }
  }
}
shape.photos=[];
ctx.render();
assert.equal(svg.children.filter(n=>n.tag==='text').length,1,'no badge without photos');
// Older browsers and synthetic rendering without SVG text measurement fail safely
// to the existing label size estimate rather than hiding photos.
ctx.makeEl=makeEl;
shape.photos=[{id:'p1'}];
ctx.scale=1;ctx.render();
const fallbackBadge=svg.children.find(n=>n.tag==='text' && n.textContent==='📷1');
assert(fallbackBadge);
assert.equal(fallbackBadge.attrs.x,52+(90-16)/2+4);
shape.photos=[];
shape.autoLabel='ひび割れ①';

console.log('PASS label leader width: 0.6px (vs 0.8px damage) at six zoom levels, selected/unselected; all positions, marker and label unchanged');
console.log('PASS photo badge alignment: same centered y and SVG dominant-baseline as label at 5 zoom levels and 3 label lengths');
console.log('PASS photo badge spacing: 4px beyond measured label, 5 zoom levels, no photo case, all sizes and drawing controls unchanged');

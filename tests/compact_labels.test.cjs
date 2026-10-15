'use strict';
// Test the actual label settings script in isolation; no cloud or user files.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('sentlog/label-settings.js','utf8');
const editor=fs.readFileSync('sentlog/part09.txt','utf8');
assert(editor.includes("'font-size':m.fontSize*0.85"),'photo icon must follow name font size');
function element(id=''){
 const children=[];
 return {id,children,dataset:{},style:{},textContent:'',className:'',
  appendChild(n){children.push(n)},before(n){children.push(n)},
  setAttribute(){},getAttribute(k){return this[k]||'0'},
  classList:{toggle(){},contains(){return false}},
 };
}
const sidebar=element('sidebar'),marker=element('marker'),svg=element('svg');
svg.querySelectorAll=()=>[];
const buttons=[];
const ctx={
 console,Math,Number,Object,document:{getElementById:id=>id==='sidebar'?sidebar:id==='sentlogLabelSize'?null:id==='leaderMarkerSelect'?{parentElement:marker}:null,createElement:tag=>{const e=element(tag);if(tag==='button')buttons.push(e);return e}},
 state:{labelSize:'normal',shapes:[]},activeDrawingId:'test-drawing',currentView:'projects',
 scale:1,labelFontSize:()=>Math.max(16,18/ctx.scale),bindLabelTarget:()=>{},render:()=>{},
 svg,matchMedia:()=>({matches:false}),navigator:{maxTouchPoints:1},persist:()=>{},
 showError:()=>{},window:null
};
ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
const levels=[.05,.1,.25,.5,1,2,4,8];
const sizes={};
for(const preset of ['small','normal','large']){
 ctx.state.labelSize=preset;sizes[preset]=[];
 for(const z of levels){
  ctx.scale=z;
  const px=ctx.labelFontSize()*z;
  assert(px>=7.9&&px<=18,'text visible but not oversized');
  sizes[preset].push(px);
 }
}
for(let i=0;i<levels.length;i++){
 assert(sizes.small[i]<sizes.normal[i]&&sizes.normal[i]<sizes.large[i],'presets remain ordered');
}
assert(Math.max(...sizes.normal)-Math.min(...sizes.normal)<4.1,'zoom cannot cause extreme change');
assert(sizes.normal[6]<15,'at 4x zoom text remains compact');
assert(sizes.normal[0]<=11,'fit-to-page text stays small');
const legacyAt4=Math.max(16,18/4)*.8*4;
assert(sizes.normal[6]<legacyAt4/3,'removes formerly huge zoom text');
assert(!code.includes("legacyFontSize()*factor()"),'old large zoom scaling removed');
assert(code.includes("text.setAttribute('stroke-width',String((photo?1.6:2.2)/z))"),'fine screen-pixel halo');
console.log('PASS compact labels: 0.05–8x zoom; fit-to-page and zoomed both restrained; all 3 presets; camera matches label; halo restrained');

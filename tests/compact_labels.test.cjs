'use strict';
// Test the actual label settings script in isolation; no cloud or user files.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('sentlog/label-settings.js','utf8');
const editor=fs.readFileSync('sentlog/part09.txt','utf8');
assert(editor.includes("'font-size':m.fontSize*0.85"),'photo icon must follow name font size');
function element(id=''){
 const children=[];
 return {id,children,dataset:{},style:{},textContent:'',className:'',
  appendChild(n){children.push(n)},append(...args){children.push(...args)},before(n){children.push(n)},
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
const levels=[.05,.1,.25,.375,.5,.75,1,2,4,8];
const sizes={};
const approx=(a,b,msg)=>assert(Math.abs(a-b)<1e-9,msg+' actual='+a+' expected='+b);
for(const preset of ['small','normal','large']){
 ctx.state.labelSize=preset;sizes[preset]=[];
 for(const z of levels){
  ctx.scale=z;
  const px=ctx.labelFontSize()*z;
  assert(px>=6.7&&px<=18,'even the smaller preset should remain bounded');
  sizes[preset].push(px);
 }
 for(let i=1;i<levels.length;i++){
  assert(sizes[preset][i]>=sizes[preset][i-1]-1e-9,'font size must never grow on zooming OUT');
 }
}
for(let i=0;i<levels.length;i++){
 assert(sizes.small[i]<sizes.normal[i]&&sizes.normal[i]<sizes.large[i],'presets remain ordered');
}
const get=(preset,z)=>sizes[preset][levels.indexOf(z)];
for(const [zoom,screenPx] of [[.25,8.5],[.5,9.5],[1,12],[2,12.65]]){
 approx(get('normal',zoom),screenPx,'standard size at zoom '+zoom);
 approx(get('small',zoom),screenPx*.8,'small size at zoom '+zoom);
 approx(get('large',zoom),screenPx*1.2,'large size at zoom '+zoom);
}
// At >100% retain precisely the existing v1.46 font sizes.
for(const z of [1,2,4,8])approx(get('normal',z),Math.min(14.5,12+.65*Math.log2(z)),'100%+ remains unchanged');
approx(get('normal',.05),8.5,'extreme whole-page view remains usable');
assert(get('normal',.25)<=.8*(12+.65*Math.log2(.25)),'25% lettering should shrink by about 20%');
assert(get('normal',.5)<(12+.65*Math.log2(.5)),'50% should be noticeably smaller');
assert(get('normal',.75)<get('normal',1),'transition back to 100% must be smooth');
// The SVG text is smaller, but the actual label-grab target stays >=44px
// wide and high on iPad/iPhone across zoom and all size presets.
ctx.state.shapes=[{id:'damage-1',autoLabel:'ひび割れ①',kind:'line'}];
for(const z of levels){
 ctx.scale=z;
 for(const preset of ['small','normal','large']){
  ctx.state.labelSize=preset;
  const attrs={x:'90',y:'110',width:'8',height:'7'};
  const hit={dataset:{},getAttribute:k=>attrs[k],setAttribute:(k,v)=>{attrs[k]=String(v)}};
  ctx.bindLabelTarget(hit,'damage-1');
  assert.equal(hit.dataset.labelTarget,'true','damage name remains draggable');
  assert(Number(attrs.width)*z>=44-1e-7,'touch hit width must stay >=44px');
  assert(Number(attrs.height)*z>=44-1e-7,'touch hit height must stay >=44px');
 }
}
ctx.state.labelSize='not-yet-set';ctx.scale=1;
approx(ctx.labelFontSize()*ctx.scale,12,'old drawings without a valid label setting default to standard');
assert(editor.includes("'font-size':m.fontSize*0.85"),'camera size remains proportional to the name');
assert(code.includes("text.setAttribute('stroke-width',String((photo?1.6:2.2)/z))"),'fine screen-pixel halo unchanged');
console.log('PASS overview labels: 25% 8.5px, 50% 9.5px, 100% 12px, 200% 12.65px; 0.05–8x zoom and 3 presets; >=44px draggable hit targets; 100%+ unchanged');

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('../sentlog/drawing-export-core.js');
const renderer=fs.readFileSync('sentlog/drawing-export-renderer.js','utf8');
const start=renderer.indexOf('async function trimmedOverlay(canvas){'),end=renderer.indexOf("let fontData='';",start);
assert(start>=0&&end>start);
class Canvas{
 constructor(w=1,h=1,data=null){this.width=w;this.height=h;this.data=data||new Uint8ClampedArray(w*h*4);}
 getContext(){const c=this;return {
  getImageData(x,y,w,h){const d=new Uint8ClampedArray(w*h*4);for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)for(let k=0;k<4;k++)d[(yy*w+xx)*4+k]=c.data[((yy+y)*c.width+xx+x)*4+k];return {data:d,width:w,height:h};},
  putImageData(img){c.data=img.data.slice();}
 };}
}
const scope={document:{createElement:()=>new Canvas()},makeBlob:async c=>({width:c.width,height:c.height,data:c.data.slice()}),Error};
vm.createContext(scope);vm.runInContext(renderer.slice(start,end)+';this.trim=trimmedOverlay;',scope);
(async()=>{
 for(const pixels of [[],[[0,0,1]],[[19,11,255]],[[8,5,1],[10,7,150]],[[0,0,255],[19,11,1]]]){
  const c=new Canvas(20,12);for(const [x,y,a] of pixels)c.data.set([12,37,98,a],(y*20+x)*4);
  const out=await scope.trim(c);const restored=new Uint8ClampedArray(c.data.length);
  if(out.overlay){const b=out.overlayBounds||{x:0,y:0,width:20,height:12};for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)for(let k=0;k<4;k++)restored[((y+b.y)*20+x+b.x)*4+k]=out.overlay.data[(y*b.width+x)*4+k];}
  assert.deepEqual(restored,c.data,'every pixel with nonzero alpha survives exact integer crop');
  assert.equal(out.overlay===null,pixels.length===0);
 }
 const position=async info=>{const images=[];const page={drawImage:(image,box)=>images.push(box),drawPage(){}};
  const doc={addPage:()=>page,embedPng:async()=>({}),flush:async()=>{}};
  await C.addPage(doc,null,{paper:{width:600,height:400},background:new Blob(['bg']),...info},{});return images;};
 let images=await position({overlay:null});assert.equal(images.length,1,'blank layer has no image');
 images=await position({overlay:new Blob(['ink']),pixels:{width:1200,height:800},overlayBounds:{x:100,y:200,width:300,height:100}});
 assert.deepEqual(images[1],{x:50,y:250,width:150,height:50},'PNG top-left maps correctly to PDF bottom-left');
 await assert.rejects(position({overlay:new Blob(['ink']),pixels:{width:1200,height:800},overlayBounds:{x:1199,y:200,width:300,height:100}}),/位置/);
 const baseline=process.env.SENTLOG_EXPORT_BASELINE_DIR;
 if(baseline){
  const old=require(path.join(baseline,'sentlog/drawing-export-core.js'));
  for(const dimensions of [[1800,1272,842,595],[5000,3500,2384,1684],[600,800,595,842]])assert.deepEqual(C.pixels(...dimensions),old.pixels(...dimensions),'annotation resolution unchanged');
  for(const file of ['cloud-sync.js','sync-traffic.js','photo-recovery.js','peer-photo-recovery.js','pdf-recovery.js','record-store.js','pdf-quality.js'])
   assert.equal(fs.readFileSync('sentlog/'+file,'utf8'),fs.readFileSync(path.join(baseline,'sentlog',file),'utf8'),'unrelated logic unchanged: '+file);
 }
 console.log('PASS lossless edge/alpha crop, empty layer, crop coordinates, rejected invalid bounds, unchanged pixel density and sync');
})().catch(e=>{console.error(e);process.exitCode=1;});

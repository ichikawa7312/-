/* SentlogDrawingExportCore v1.88: bounded PDF composition and UTF-8 ZIP. */
(function(root){'use strict';
const enc=new TextEncoder();
function safeName(value,fallback='図面'){
 let s=String(value||fallback).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim();
 if(!s||s==='.'||s==='..')s=fallback;
 if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))s='_'+s;
 return [...s].slice(0,90).join('');
}
function names(drawings){const used=new Set();return drawings.map(d=>{const base=safeName(d.name),suffix='_記録図面.pdf';let name=base+suffix,n=2;while(used.has(name.toLowerCase()))name=base+'_'+n+++suffix;used.add(name.toLowerCase());return name;});}
function pixels(width,height,paperW,paperH){
 if(![width,height,paperW,paperH].every(n=>Number.isFinite(n)&&n>0))throw Error('図面サイズを確認できません。');
 const factor=Math.min(4096/width,4096/height,Math.sqrt(6000000/(width*height)),Math.max(paperW/72*240/width,paperH/72*240/height));
 return {width:Math.max(1,Math.round(width*factor)),height:Math.max(1,Math.round(height*factor))};
}
const table=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i&1)?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
async function crc32(blob){let c=0xffffffff;for(let start=0;start<blob.size;start+=1024*1024){const bytes=new Uint8Array(await blob.slice(start,start+1024*1024).arrayBuffer());for(const b of bytes)c=table[(c^b)&255]^(c>>>8);}return (c^0xffffffff)>>>0;}
async function zip(files){
 if(files.length>65535)throw Error('出力件数が多すぎます。分けて出力してください。');
 const parts=[],central=[];let offset=0,centralSize=0;
 const header=n=>{const a=new Uint8Array(n);return [a,new DataView(a.buffer)];};
 for(const f of files){
  const name=enc.encode(f.name),size=f.blob.size,crc=await crc32(f.blob);
  if(name.length>65535||size+offset>0xffffffff)throw Error('ZIPの上限を超えます。分けて出力してください。');
  const [a,v]=header(30);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,size,true);v.setUint32(22,size,true);v.setUint16(26,name.length,true);
  const [b,w]=header(46);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint16(14,33,true);w.setUint32(16,crc,true);w.setUint32(20,size,true);w.setUint32(24,size,true);w.setUint16(28,name.length,true);w.setUint32(42,offset,true);
  parts.push(a,name,f.blob);central.push(b,name);offset+=30+name.length+size;centralSize+=46+name.length;
 }
 const [end,v]=header(22);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);
 return new Blob([...parts,...central,end],{type:'application/zip'});
}
async function addPage(doc,source,info,PDFLib){
 const {width:W,height:H}=info.paper,page=doc.addPage([W,H]);
 if(source){
  const [x0,y0,x1,y1]=info.box;
  const embedded=await doc.embedPage(source.getPages()[info.page-1],{left:x0,bottom:y0,right:x1,top:y1});
  const r=((info.rotation%360)+360)%360;
  const position=r===90?{x:0,y:H,width:H,height:W,rotate:PDFLib.degrees(-90)}:r===180?{x:W,y:H,width:W,height:H,rotate:PDFLib.degrees(180)}:r===270?{x:W,y:0,width:H,height:W,rotate:PDFLib.degrees(90)}:{x:0,y:0,width:W,height:H};
  page.drawPage(embedded,position);
 }else if(info.background){const image=await doc.embedPng(new Uint8Array(await info.background.arrayBuffer()));page.drawImage(image,{x:0,y:0,width:W,height:H});}
 else throw Error('元図を出力できません。');
 const overlay=await doc.embedPng(new Uint8Array(await info.overlay.arrayBuffer()));page.drawImage(overlay,{x:0,y:0,width:W,height:H});
 await doc.flush();return page;
}
const api={safeName,names,pixels,crc32,zip,addPage};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SentlogDrawingExportCore=api;
})(globalThis);

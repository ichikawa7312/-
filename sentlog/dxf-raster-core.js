/* Read DXF raster-image references without modifying the original CAD bytes.
   Geometry follows AutoCAD IMAGE / IMAGEDEF group codes. */
(function(root){'use strict';
const C=(typeof module==='object'&&module.exports)?require('./dxf-core.js'):root.SentlogDxfCore;
const val=(r,code)=>r.tags.find(t=>t.code===code)?.value;
const number=(r,code,otherwise=0)=>{const n=Number(val(r,code));return Number.isFinite(n)?n:otherwise;};
function basename(value){return String(value||'').replace(/\\/g,'/').split('/').pop().trim();}
function parse(bytes){
 const d=C.scan(bytes),decoder=new TextDecoder(C.encoding(d),{fatal:false});
 const name=value=>{
   if(!value)return '';
   const binary=Uint8Array.from(String(value),x=>x.charCodeAt(0)&255);
   return decoder.decode(binary).replace(/\\U\+([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
 };
 const definitions=new Map();
 for(const r of d.records){
   if(r.type!=='IMAGEDEF'||r.section!=='OBJECTS')continue;
   const handle=String(val(r,5)||'').toUpperCase();
   if(!handle)continue;
   definitions.set(handle,{handle,fileName:basename(name(val(r,1))),rawPath:name(val(r,1))});
 }
 const placements=[];
 for(const r of d.records){
   if(r.type!=='IMAGE'||r.section!=='ENTITIES')continue;
   if(val(r,67)==='1'||(val(r,410)&&val(r,410)!=='Model'))continue;
   const handle=String(val(r,340)||'').toUpperCase();
   const def=definitions.get(handle);
   if(!def)continue;
   const width=number(r,13),height=number(r,23);
   const p={
     handle,entityHandle:String(val(r,5)||''),
     x:number(r,10),y:number(r,20),
     ux:number(r,11),uy:number(r,21),
     vx:number(r,12),vy:number(r,22),
     width,height,
     visible:val(r,70)==null||!!(number(r,70)&1),
     clipEnabled:number(r,280,0)===1,clipType:number(r,71,1),clipOutside:number(r,290,1)===0,
     clip:[]
   };
   // AutoCAD places clip vertices in 14/24 pairs.
   let previous=null;
   for(const t of r.tags){
     if(t.code===14){previous={x:Number(t.value),y:NaN};p.clip.push(previous);}
     else if(t.code===24&&previous&&Number.isNaN(previous.y)){previous.y=Number(t.value);previous=null;}
   }
   p.clip=p.clip.filter(q=>Number.isFinite(q.x)&&Number.isFinite(q.y));
   if(width>0&&height>0&&Math.abs(p.ux*p.vy-p.uy*p.vx)>1e-18&&[p.x,p.y,p.ux,p.uy,p.vx,p.vy].every(Number.isFinite))placements.push(p);
 }
 const used=new Set(placements.map(x=>x.handle));
 const references=[...definitions.values()].filter(x=>used.has(x.handle));
 return {references,placements};
}
function includeBounds(bounds,parsed){
 if(!bounds||!parsed?.placements?.length)return bounds;
 const result={...bounds};
 for(const p of parsed.placements){
   if(!p.visible)continue;
   for(const [u,v] of [[0,0],[p.width,0],[0,p.height],[p.width,p.height]]){
     const x=p.x+u*p.ux+v*p.vx,y=p.y+u*p.uy+v*p.vy;
     if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1e12||Math.abs(y)>1e12)continue;
     result.minX=Math.min(result.minX,x);result.maxX=Math.max(result.maxX,x);
     result.minY=Math.min(result.minY,y);result.maxY=Math.max(result.maxY,y);
   }
 }
 return result;
}
// Canvas pixel (0,0) is upper-left; the DXF insertion is the lower-left.
function imageTransform(p,frame,view,sourceWidth,sourceHeight){
 if(!(sourceWidth>0&&sourceHeight>0&&frame?.unitsPerPixel>0&&view?.scale>0))throw Error('画像の座標系が正しくありません');
 const scale=view.scale/frame.unitsPerPixel;
 return {
   a:scale*p.ux*p.width/sourceWidth,
   b:-scale*p.uy*p.width/sourceWidth,
   c:-scale*p.vx*p.height/sourceHeight,
   d:scale*p.vy*p.height/sourceHeight,
   e:view.tx+scale*(p.x+p.vx*p.height-frame.xMin),
   f:view.ty+scale*(frame.yMax-p.y-p.vy*p.height)
 };
}
const api={parse,includeBounds,imageTransform,basename};
if(typeof module==='object'&&module.exports)module.exports=api;
else root.SentlogDxfRasterCore=api;
})(typeof globalThis==='object'?globalThis:this);

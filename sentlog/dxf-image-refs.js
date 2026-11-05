/* Raster references for DXF IMAGE/IMAGEDEF. Does not change original DXF bytes. */
(function(root){'use strict';
const C=(typeof module==='object' && module.exports)?require('./dxf-core.js'):root.SentlogDxfCore;
if(!C)throw Error('DXF parser missing');
const value=(record,code)=>record.tags.find(t=>t.code===code)?.value;
const number=(record,code,defaultValue=0)=>{const s=value(record,code);if(s==null||s==='')return defaultValue;const n=Number(s);return Number.isFinite(n)?n:NaN;};
const basename=path=>String(path||'').split(/[\\/]/).pop();
function references(bytes){
 const parsed=C.scan(bytes);
 const definitions=new Map();
 for(const r of parsed.records){
  if(r.type!=='IMAGEDEF'||r.section!=='OBJECTS')continue;
  const handle=value(r,5),path=value(r,1);
  if(handle&&path)definitions.set(handle.toUpperCase(),{path,name:basename(path)});
 }
 const result=[];
 for(const r of parsed.records){
  if(r.type!=='IMAGE'||r.section!=='ENTITIES')continue;
  if(value(r,67)==='1'||(value(r,410)&&value(r,410)!=='Model'))continue;
  const def=definitions.get(String(value(r,340)||'').toUpperCase());
  const x=number(r,10),y=number(r,20),ux=number(r,11),uy=number(r,21),vx=number(r,12),vy=number(r,22),width=number(r,13),height=number(r,23);
  if(![x,y,ux,uy,vx,vy,width,height].every(Number.isFinite)||width<=0||height<=0)continue;
  result.push({handle:value(r,5)||'',definitionHandle:value(r,340)||'',name:def?.name||'',path:def?.path||'',
   insert:{x,y},u:{x:ux,y:uy},v:{x:vx,y:vy},width,height,
   clipping:Number(value(r,280)||0)===1,clipType:Number(value(r,71)||0),
   shown:(Number(value(r,70)||1)&1)!==0});
 }
 return result;
}
const api={references,basename};
if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDxfImageRefs=api;
})(typeof globalThis==='object'?globalThis:this);

/* Sentlog automatic chalk tracing, version 1. Pure, offline image processing.
 * Source photography is never uploaded by the recognition engine. Results are
 * suggestions requiring human confirmation, not diagnostic classifications.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.SentlogAutoTraceCore=api;
})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const NEIGHBORS=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function pathLength(points,closed=false){
  let n=0;for(let i=1;i<points.length;i++)n+=distance(points[i-1],points[i]);
  if(closed&&points.length>2)n+=distance(points.at(-1),points[0]);return n;
}
function signedArea(points){
  let n=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];n+=a.x*b.y-a.y*b.x;}return n/2;
}
function pointInPolygon(p,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }return inside;
}
function simplify(points,tolerance=1.8,closed=false){
  if(!Array.isArray(points)||points.length<3)return points||[];
  const src=closed?[...points,points[0]]:points;
  const keep=new Uint8Array(src.length);keep[0]=1;keep[src.length-1]=1;
  const stack=[[0,src.length-1]],tol2=tolerance*tolerance;
  while(stack.length){
    const [a,b]=stack.pop();const p=src[a],q=src[b],vx=q.x-p.x,vy=q.y-p.y,den=vx*vx+vy*vy;
    let best=tol2,index=-1;
    for(let i=a+1;i<b;i++){
      const r=src[i];const t=den?Math.min(1,Math.max(0,((r.x-p.x)*vx+(r.y-p.y)*vy)/den)):0;
      const d=(r.x-p.x-vx*t)**2+(r.y-p.y-vy*t)**2;
      if(d>best){best=d;index=i;}
    }
    if(index!==-1){keep[index]=1;stack.push([a,index],[index,b]);}
  }
  let out=src.filter((_,i)=>keep[i]);if(closed&&out.length>1)out.pop();
  if(closed&&out.length<3){out=[points[0],points[Math.floor(points.length/3)],points[Math.floor(points.length*2/3)]];}
  if(out.length>160){const step=Math.ceil(out.length/160);out=out.filter((_,i)=>i%step===0);}
  return out;
}
const PRESETS=Object.freeze({
  strict:{minBrightness:210,contrast:32,maxChroma:28,ridgeFraction:.58,ridgeContrast:20},
  standard:{minBrightness:185,contrast:23,maxChroma:39,ridgeFraction:.34,ridgeContrast:14},
  wide:{minBrightness:145,contrast:12,maxChroma:60,ridgeFraction:.13,ridgeContrast:8}
});
function settingsFor(opts={}){
  const preset=PRESETS[opts.sensitivity]||PRESETS.standard;
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  return {
    minBrightness:clamp(Number.isFinite(Number(opts.minBrightness))&&opts.minBrightness!=null?Number(opts.minBrightness):preset.minBrightness,80,250),
    contrast:clamp(Number.isFinite(Number(opts.contrast))&&opts.contrast!=null?Number(opts.contrast):preset.contrast,5,80),
    maxChroma:clamp(Number.isFinite(Number(opts.maxChroma))&&opts.maxChroma!=null?Number(opts.maxChroma):preset.maxChroma,10,95),
    ridgeFraction:clamp(preset.ridgeFraction,0,1),ridgeContrast:preset.ridgeContrast,
    radius:clamp(Number(opts.radius)||11,5,22)
  };
}
function normalizeRegion(region,w,h){
  if(!region)return null;
  const coords=[region.x0,region.y0,region.x1,region.y1].map(Number);
  if(coords.some(v=>!Number.isFinite(v)))return null;
  const x0=Math.max(0,Math.min(w,Math.floor(Math.min(coords[0],coords[2]))));
  const y0=Math.max(0,Math.min(h,Math.floor(Math.min(coords[1],coords[3]))));
  const x1=Math.max(0,Math.min(w,Math.ceil(Math.max(coords[0],coords[2]))));
  const y1=Math.max(0,Math.min(h,Math.ceil(Math.max(coords[1],coords[3]))));
  return x1-x0>=8&&y1-y0>=8?{x0,y0,x1,y1}:null;
}
function chalkMask(image,opts={}){
  const w=image.width|0,h=image.height|0,n=w*h;
  if(w<1||h<1||!image.data||image.data.length<n*4)throw Error('画像の形式が不正です');
  const cfg=settingsFor(opts),radius=cfg.radius,region=normalizeRegion(opts.region,w,h);
  const lum=new Uint8Array(n),neutral=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const j=i*4,r=image.data[j],g=image.data[j+1],b=image.data[j+2];
    lum[i]=Math.round(.213*r+.715*g+.072*b);
    neutral[i]=Math.max(r,g,b)-Math.min(r,g,b)<=cfg.maxChroma?1:0;
  }
  // Local positive contrast emphasizes chalk pigment over ordinary outlines.
  const stride=w+1,integral=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){let sum=0;for(let x=0;x<w;x++){sum+=lum[y*w+x];integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+sum;}}
  const mask=new Uint8Array(n);
  const xMin=region?region.x0:0,xMax=region?region.x1:w,yMin=region?region.y0:0,yMax=region?region.y1:h;
  for(let y=yMin;y<yMax;y++){
    const y0=Math.max(0,y-radius),y1=Math.min(h,y+radius+1);
    for(let x=xMin;x<xMax;x++){
      const i=y*w+x;if(!neutral[i]||lum[i]<cfg.minBrightness)continue;
      const x0=Math.max(0,x-radius),x1=Math.min(w,x+radius+1);
      const local=(integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0])/((x1-x0)*(y1-y0));
      if(lum[i]-local>=cfg.contrast)mask[i]=1;
    }
  }
  return mask;
}

function dilate(mask,w,h){
  const out=new Uint8Array(mask.length);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    if(mask[i]||mask[i-1]||mask[i+1]||mask[i-w]||mask[i+w]||
       mask[i-w-1]||mask[i-w+1]||mask[i+w-1]||mask[i+w+1])out[i]=1;
  }return out;
}
function erode(mask,w,h){
  const out=new Uint8Array(mask.length);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    if(mask[i]&&mask[i-1]&&mask[i+1]&&mask[i-w]&&mask[i+w]&&
       mask[i-w-1]&&mask[i-w+1]&&mask[i+w-1]&&mask[i+w+1])out[i]=1;
  }return out;
}
function components(mask,w,h){
  const seen=new Uint8Array(mask.length),queue=new Int32Array(mask.length),out=[];
  for(let start=0;start<mask.length;start++){
    if(!mask[start]||seen[start])continue;
    let head=0,tail=1;queue[0]=start;seen[start]=1;
    let minX=w,minY=h,maxX=0,maxY=0;
    while(head<tail){
      const i=queue[head++],x=i%w,y=(i/w)|0;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [dx,dy] of NEIGHBORS){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
        const ni=ny*w+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;queue[tail++]=ni;}
      }
    }
    if(tail>=20)out.push({pixels:Array.from(queue.subarray(0,tail)),minX,maxX,minY,maxY});
  }
  return out.sort((a,b)=>b.pixels.length-a.pixels.length);
}
function localComponent(comp,w){
  const cw=comp.maxX-comp.minX+3,ch=comp.maxY-comp.minY+3;
  const data=new Uint8Array(cw*ch);
  for(const i of comp.pixels){
    const x=i%w-comp.minX+1,y=((i/w)|0)-comp.minY+1;data[y*cw+x]=1;
  }
  return {data,w:cw,h:ch,ox:comp.minX-1,oy:comp.minY-1};
}
function holePixels({data,w,h}){
  const seen=new Uint8Array(data.length),queue=new Int32Array(data.length);
  let head=0,tail=1;queue[0]=0;seen[0]=1;
  while(head<tail){
    const i=queue[head++],x=i%w,y=(i/w)|0;
    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
      const ni=ny*w+nx;if(!data[ni]&&!seen[ni]){seen[ni]=1;queue[tail++]=ni;}
    }
  }
  let holes=0;for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;if(!data[i]&&!seen[i])holes++;
  }return holes;
}
function outerContour(local){
  const {data,w,h,ox,oy}=local;
  const edges=[],byStart=new Map();
  function edge(ax,ay,bx,by){
    const id=edges.length;edges.push({a:[ax,ay],b:[bx,by]});
    const key=ax+','+ay;if(!byStart.has(key))byStart.set(key,[]);byStart.get(key).push(id);
  }
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    if(!data[y*w+x])continue;
    if(!data[(y-1)*w+x])edge(x,y,x+1,y);
    if(!data[y*w+x+1])edge(x+1,y,x+1,y+1);
    if(!data[(y+1)*w+x])edge(x+1,y+1,x,y+1);
    if(!data[y*w+x-1])edge(x,y+1,x,y);
  }
  const used=new Uint8Array(edges.length);let best=null,bestArea=0;
  for(let i=0;i<edges.length;i++){
    if(used[i])continue;let idx=i,loop=[],steps=0;
    while(idx!=null&&!used[idx]&&steps++<edges.length){
      used[idx]=1;const e=edges[idx];loop.push({x:e.a[0]+ox,y:e.a[1]+oy});
      const next=byStart.get(e.b[0]+','+e.b[1])||[];idx=next.find(j=>!used[j]);
      if(idx==null)break;
    }
    const area=Math.abs(signedArea(loop));
    if(loop.length>=6&&area>bestArea){bestArea=area;best=loop;}
  }return best?simplify(best,Math.max(1.7,Math.min(3.8,Math.sqrt(bestArea)*.012)),true):[];
}
function thin(local){
  const {data,w,h}=local,a=Uint8Array.from(data),toRemove=[];
  function rowStep(pass){
    toRemove.length=0;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x;if(!a[i])continue;
      const p=[a[i-w],a[i-w+1],a[i+1],a[i+w+1],a[i+w],a[i+w-1],a[i-1],a[i-w-1]];
      const count=p.reduce((s,v)=>s+v,0);if(count<2||count>6)continue;
      let trans=0;for(let k=0;k<8;k++)if(!p[k]&&p[(k+1)%8])trans++;
      if(trans!==1)continue;
      if(pass===0){if(p[0]*p[2]*p[4]||p[2]*p[4]*p[6])continue;}
      else if(p[0]*p[2]*p[6]||p[0]*p[4]*p[6])continue;
      toRemove.push(i);
    }
    for(const i of toRemove)a[i]=0;return toRemove.length;
  }
  for(let n=0;n<70;n++){const u=rowStep(0),v=rowStep(1);if(!u&&!v)break;}
  return a;
}
function traceSkeleton(local){
  const {w,h,ox,oy}=local,bits=thin(local),indexes=[];
  for(let i=0;i<bits.length;i++)if(bits[i])indexes.push(i);
  if(indexes.length<10)return [];
  const nodes=new Map();
  for(const i of indexes){
    const x=i%w,y=(i/w)|0,adj=[];
    for(const [dx,dy] of NEIGHBORS){
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h||!bits[ny*w+nx])continue;
      if(dx&&dy&&bits[y*w+nx]&&bits[ny*w+x])continue;
      adj.push(ny*w+nx);
    }
    nodes.set(i,adj);
  }
  const visited=new Set(),edges=[],key=(a,b)=>a<b?a+':'+b:b+':'+a;
  function follow(from,next){
    const chain=[from];let a=from,b=next;
    while(b!=null&&chain.length<=nodes.size+1){
      const k=key(a,b);if(visited.has(k))break;visited.add(k);chain.push(b);
      const opts=(nodes.get(b)||[]).filter(v=>v!==a&&!visited.has(key(b,v)));
      if((nodes.get(b)||[]).length!==2||opts.length!==1)break;
      a=b;b=opts[0];
    }
    const pts=chain.map(i=>({x:i%w+ox,y:Math.floor(i/w)+oy}));
    if(pathLength(pts)>=17&&pts.length>=4)edges.push(simplify(pts,1.3));
  }
  for(const i of indexes){
    if((nodes.get(i)||[]).length===2)continue;
    for(const next of nodes.get(i)||[])if(!visited.has(key(i,next)))follow(i,next);
  }
  for(const i of indexes)for(const next of nodes.get(i)||[])if(!visited.has(key(i,next)))follow(i,next);
  return edges;
}
// A bright painted/structural edge usually has a dark side and a bright side.
// A chalk stroke is a narrow bright ridge with lower luminance on BOTH sides.
// This filter is conservative: operators can choose "wide" sensitivity or a
// targeted region if the chalk is thin or photographed in bright sunlight.
function luminanceAt(image,x,y){
  const w=image.width|0,h=image.height|0;
  const ix=Math.round(x),iy=Math.round(y);
  if(ix<0||iy<0||ix>=w||iy>=h)return null;
  const i=(iy*w+ix)*4,d=image.data;
  return .213*d[i]+.715*d[i+1]+.072*d[i+2];
}
function ridgeSupport(image,points,closed=false,minContrast=14){
  if(!Array.isArray(points)||points.length<2)return 0;
  let passed=0,tested=0;
  const n=points.length,segments=closed?n:n-1;
  for(let i=0;i<segments;i++){
    const a=points[i],b=points[(i+1)%n],len=distance(a,b);
    if(len<.5)continue;
    const nx=-(b.y-a.y)/len,ny=(b.x-a.x)/len;
    const steps=Math.max(1,Math.ceil(len/8));
    for(let j=0;j<steps;j++){
      const t=(j+.5)/steps,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
      let center=luminanceAt(image,x,y);
      if(center==null)continue;
      // Outer polygon contours often lie half a pixel outside the chalk.
      if(closed){
        const p1=luminanceAt(image,x+nx*1.5,y+ny*1.5);
        const p2=luminanceAt(image,x-nx*1.5,y-ny*1.5);
        center=Math.max(center,p1??0,p2??0);
      }
      let left=-Infinity,right=-Infinity;
      for(const d of [6,10,14]){
        const l=luminanceAt(image,x+nx*d,y+ny*d),r=luminanceAt(image,x-nx*d,y-ny*d);
        if(l!=null)left=Math.max(left,center-l);
        if(r!=null)right=Math.max(right,center-r);
      }
      if(!Number.isFinite(left)||!Number.isFinite(right))continue;
      tested++;if(left>=minContrast&&right>=minContrast)passed++;
    }
  }
  return tested?passed/tested:0;
}
function analyze(image,opts={}){
  const w=image.width|0,h=image.height|0;
  if(w*h>900000)throw Error('認識画像を縮小してください（最大90万画素）');
  const cfg=settingsFor(opts),region=normalizeRegion(opts.region,w,h);
  // Explicit seeds are an opt-in tracing boundary. An empty list means
  // absolutely NO recognition; never fall back to scanning the whole image.
  // Untouched callers may continue to use the legacy automatic analysis.
  const seeded=Array.isArray(opts.seeds);
  const seeds=seeded?opts.seeds.slice(0,32).filter(p=>p&&
    Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<w&&p.y>=0&&p.y<h&&
    (!region||(p.x>=region.x0&&p.x<region.x1&&p.y>=region.y0&&p.y<region.y1))):[];
  if(seeded&&!seeds.length)return {width:w,height:h,candidates:[],stats:{components:0,areas:0,lines:0,seeded:true,matched:0}};
  const mask=erode(dilate(chalkMask(image,{...opts,region}),w,h),w,h);
  // Morphology must never add pixels beyond the selected inspection area.
  if(region){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)
      if(x<region.x0||x>=region.x1||y<region.y0||y>=region.y1)mask[y*w+x]=0;
  }
  const comps=components(mask,w,h),areas=[],lines=[];
  const maxCandidates=Math.max(1,Math.min(80,opts.maxCandidates||45));
  let matched=0;
  // Index components once. Each tap chooses only its ONE nearest genuinely
  // masked chalk component (within 8 image px), never all nearby objects.
  // This matters on a dashboard/texture image with many bright boundaries.
  let relevant=null;
  if(seeded){
    const owners=new Int32Array(w*h);
    for(let ci=0;ci<comps.length;ci++)for(const pixel of comps[ci].pixels)owners[pixel]=ci+1;
    relevant=new Set();
    for(const p of seeds){
      let winner=-1,best=65;
      const x0=Math.max(0,Math.ceil(p.x-8)),x1=Math.min(w-1,Math.floor(p.x+8));
      const y0=Math.max(0,Math.ceil(p.y-8)),y1=Math.min(h-1,Math.floor(p.y+8));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const owner=owners[y*w+x];if(!owner)continue;
        const d=(x-p.x)**2+(y-p.y)**2;
        if(d<best){best=d;winner=owner-1;}
      }
      if(winner>=0)relevant.add(winner);
    }
  }
  for(const [ci,comp] of comps.entries()){
    if(seeded?!relevant.has(ci):ci>=90)continue;
    matched++;
    const sourceComponent='chalk:'+comp.minX+','+comp.minY+','+comp.maxX+','+comp.maxY;
    const cw=comp.maxX-comp.minX+1,ch=comp.maxY-comp.minY+1;
    if(cw<6&&ch<6)continue;
    if(comp.pixels.length>w*h*.3)continue;
    const local=localComponent(comp,w),hole=holePixels(local);
    if(cw>=20&&ch>=20&&hole>=Math.max(35,cw*ch*.055)){
      const pts=outerContour(local);
      if(pts.length>=3&&Math.abs(signedArea(pts))>100&&
         ridgeSupport(image,pts,true,cfg.ridgeContrast)>=cfg.ridgeFraction*.68)
         areas.push({kind:'area',points:pts,source:'chalking',sourceComponent});
    }else if(comp.pixels.length>=28){
      for(const pts of traceSkeleton(local)){
        if(pts.length>=2&&ridgeSupport(image,pts,false,cfg.ridgeContrast)>=cfg.ridgeFraction)
          lines.push({kind:'line',points:pts,source:'chalking',sourceComponent});
      }
    }
    if(areas.length+lines.length>maxCandidates*3)break;
  }
  const survivors=lines.filter(line=>{
    const samples=line.points.filter((_,i)=>i%Math.max(1,Math.floor(line.points.length/8))===0);
    return !areas.some(area=>samples.filter(p=>pointInPolygon(p,area.points)).length>=samples.length*.7);
  });
  const all=[...areas,...survivors].sort((a,b)=>pathLength(b.points,b.kind==='area')-pathLength(a.points,a.kind==='area')).slice(0,maxCandidates);
  return {width:w,height:h,candidates:all.map((c,i)=>({...c,id:'trace-'+(i+1)})),stats:{components:comps.length,areas:areas.length,lines:survivors.length,seeded,matched}};
}

return {chalkMask,analyze,pathLength,signedArea,simplify,pointInPolygon,settingsFor,normalizeRegion,ridgeSupport};
});

/* Sentlog DXF: retain original byte records; append editable annotation entities. */
(function(root){'use strict';
function binaryString(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return s;}
function scan(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length>8*1024*1024)throw Error('DXFは8MB以下に分けて取り込んでください。');
 const raw=binaryString(bytes);if(raw.startsWith('AutoCAD Binary DXF'))throw Error('バイナリDXFには対応していません。ASCII形式で保存してください。');
 const lines=[];const re=/([^\r\n]*)(\r\n|\n|\r|$)/g;let m;
 while((m=re.exec(raw))&&m[0])lines.push({value:m[1],start:m.index,end:re.lastIndex});
 while(lines.length&&lines.at(-1).value==='')lines.pop();
 if(lines.length%2)throw Error('DXFのデータが途中で終わっています。');
 if(lines.length>1000000)throw Error('図面要素が多すぎます。図面を分割してください。');
 const tags=[];for(let i=0;i<lines.length;i+=2){const code=Number(lines[i].value.trim());if(!Number.isInteger(code)||!lines[i].value.trim())throw Error('DXFのグループコードが正しくありません。');tags.push({code,value:lines[i+1].value,start:lines[i].start,valueStart:lines[i+1].start,valueEnd:lines[i+1].start+lines[i+1].value.length,end:lines[i+1].end});}
 const records=[];let current=null,section=null,table=null;
 for(let i=0;i<tags.length;i++){const t=tags[i];if(t.code===0){if(current)current.end=t.start;
   if(t.value==='SECTION')section=tags[i+1]?.value;
   if(t.value==='TABLE')table=tags[i+1]?.value;
   current={type:t.value,section,table,start:t.start,end:raw.length,tags:[]};records.push(current);
   if(t.value==='ENDTAB')table=null;if(t.value==='ENDSEC')section=null;
  }if(current)current.tags.push(t);
 }
 const variable=name=>{const i=tags.findIndex(t=>t.code===9&&t.value===name);return i<0?null:tags[i+1];};
 const version=variable('$ACADVER')?.value;
 if(!/^AC10\d\d$/.test(version)||Number(version.slice(2))<1015)throw Error('AutoCAD 2000以降のASCII形式のDXFで保存してください。');
 if(!records.some(r=>r.type==='EOF')||!records.some(r=>r.type==='ENDSEC'&&r.section==='ENTITIES'))throw Error('DXFの図形セクションが見つかりません。');
 return {raw,tags,records,variable,version};
}
const val=(r,code)=>r.tags.find(t=>t.code===code)?.value;
function encoding(d){const cp=d.variable('$DWGCODEPAGE')?.value||'ANSI_1252';if(Number(d.version.slice(2))>=1021)return 'utf-8';const aliases={ANSI_932:'shift_jis',ANSI_936:'gbk',ANSI_949:'euc-kr',ANSI_950:'big5',ANSI_1252:'windows-1252',ANSI_1251:'windows-1251'};if(!aliases[cp])throw Error('この文字コードには対応していません。UTF-8のDXF（2007以降）で保存してください。');return aliases[cp];}
function decode(bytes){return new TextDecoder(encoding(scan(bytes)),{fatal:true}).decode(bytes);}
function escapeText(s,legacy=true){const text=String(s).replace(/\\/g,'\\\\').replace(/([{}])/g,'\\$1').replace(/\r\n|\r|\n/g,'\\P');return legacy?text.replace(/[^\x20-\x7e]/g,c=>'\\U+'+c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')):text;}
const UNITS={1:{name:'inch',mm:25.4},2:{name:'ft',mm:304.8},4:{name:'mm',mm:1},5:{name:'cm',mm:10},6:{name:'m',mm:1000}};
function inspect(bytes){
 const d=scan(bytes),warnings=[],unsupported=new Map(),known=new Set(['LINE','LWPOLYLINE','POLYLINE','VERTEX','SEQEND','ARC','CIRCLE','ELLIPSE','POINT','SPLINE','INSERT','TEXT','MTEXT','SOLID','DIMENSION','ATTRIB','ATTDEF','HATCH','BLOCK','ENDBLK']);let layouts=0,entities=0,hatches=0;
 for(const r of d.records){if(!['ENTITIES','BLOCKS'].includes(r.section)||['SECTION','ENDSEC'].includes(r.type))continue;
  if(val(r,67)==='1'||(val(r,410)&&val(r,410)!=='Model')){layouts++;continue;}
  if(r.section==='BLOCKS'&&r.type==='BLOCK'&&(Number(val(r,70))&4))warnings.push('外部参照図面は、このファイル単独では表示できません。');
  if(!known.has(r.type))unsupported.set(r.type,(unsupported.get(r.type)||0)+1);
  if(r.type==='HATCH'){hatches++;if(Number(val(r,450))===1)warnings.push('グラデーションハッチングの見え方が元CADと異なる場合があります。');}
  if(['LINE','LWPOLYLINE','POLYLINE','ARC','CIRCLE','ELLIPSE','INSERT'].includes(r.type)&&r.tags.some(t=>[30,31,38].includes(t.code)&&Math.abs(Number(t.value))>1e-8))warnings.push('高さのある図形は平面表示になります。');
  if(r.type==='MTEXT'&&r.tags.some(t=>[1,3].includes(t.code)&&/\\[Sfp]/.test(t.value)))warnings.push('文字の書式・段組みの一部は表示が異なる場合があります。');
  if(r.section==='ENTITIES')entities++;
 }
 if(layouts)warnings.push('モデル空間を表示します。印刷レイアウトは元DXFに保持して出力します。');
 if(unsupported.size)warnings.push('表示未対応の要素：'+[...unsupported].map(([t,n])=>t+' '+n+'件').join('、')+'。元データは出力に保持します。');
 const units=Number(d.variable('$INSUNITS')?.value)||0;
 return {version:d.version,encoding:encoding(d),units,mmPerUnit:UNITS[units]?.mm||null,warnings:[...new Set(warnings)],entities,hatches,unsupported:[...unsupported.keys()]};
}
function makeFrame(bounds){
 if(!bounds||Object.values(bounds).some(v=>!Number.isFinite(v)))throw Error('表示できる図形の範囲がありません。');
 const w=Math.max(1e-6,bounds.maxX-bounds.minX),h=Math.max(1e-6,bounds.maxY-bounds.minY),margin=Math.max(w,h)*.035,k=(Math.max(w,h)+margin*2)/2048;
 return {xMin:bounds.minX-margin,yMax:bounds.maxY+margin,unitsPerPixel:k,width:Math.max(1,Math.ceil((w+2*margin)/k)),height:Math.max(1,Math.ceil((h+2*margin)/k))};
}
function appendPrimitives(bytes,primitives,frame){
 const d=scan(bytes),changes=[],added=[];const k=frame.unitsPerPixel;
 if(!primitives.length)return {bytes:new Uint8Array(bytes),layers:{},count:0};
 if(!(k>0)||!Number.isFinite(frame.xMin)||!Number.isFinite(frame.yMax))throw Error('図面の座標設定を確認できません。');
 const P=p=>{if(!Number.isFinite(p.x)||!Number.isFinite(p.y))throw Error('記録の座標が正しくありません。');return {x:frame.xMin+p.x*k,y:frame.yMax-p.y*k};};
 let next=d.tags.filter(t=>t.code===5||t.code===105).reduce((n,t)=>Math.max(n,parseInt(t.value,16)||0),0)+1;
 const handle=()=>(next++).toString(16).toUpperCase(),model=d.records.find(r=>r.type==='BLOCK_RECORD'&&val(r,2)==='*Model_Space');
 if(!model)throw Error('モデル空間の情報がありません。AutoCADでDXFを保存し直してください。');
 const legacy=Number(d.version.slice(2))<1021,decoder=new TextDecoder(encoding(d),{fatal:true});
 const symbol=s=>legacy?String(s).replace(/[^\x20-\x7e]/g,c=>'\\U+'+c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')):String(s);
 const readName=s=>decoder.decode(Uint8Array.from(s||'',c=>c.charCodeAt(0))).replace(/\\U\+([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
 const key=s=>String(s).normalize('NFC').toUpperCase(),used=new Map(),layers=Object.create(null);
 // Every table has its own namespace. Compare decoded names so a CP932 name,
 // its Unicode escape spelling, and mixed-case ASCII cannot collide.
 function allocate(table,requested){
  if(!used.has(table))used.set(table,new Set(d.records.filter(r=>r.type===table).map(r=>key(readName(val(r,2))))));
  const names=used.get(table),clean=String(requested).normalize('NFC').replace(/[<>\/\\":;?*|=,`\x00-\x1f\x7f]/g,'_').trim()||'記録';
  let base='';for(const c of clean){if(new TextEncoder().encode(symbol(base+c)).length>210)break;base+=c;}base=base||'記録';
  let name=base,i=1;while(names.has(key(name)))name=base+'_'+(++i);names.add(key(name));return name;
 }
 const fallback={damage:'変状_図形',label:'変状_名称',memo:'メモ_図形',dimension:'寸法_線',record:'記録_図形'};
 const requested=p=>String(p.layerName||fallback[p.layer]||fallback.record).normalize('NFC');
 const pair=(c,v)=>`${c}\r\n${typeof v==='number'?Number(v.toPrecision(15)):v}\r\n`,groups=arr=>arr.map(([c,v])=>pair(c,v)).join('');
 function resource(table,type,body){
  const header=d.records.find(r=>r.type==='TABLE'&&r.table===table),end=d.records.find(r=>r.type==='ENDTAB'&&r.table===table);if(!header||!end)throw Error('DXFの設定表が不足しています：'+table);
  const text=groups([[0,type],[5,handle()],[330,val(header,5)],[100,'AcDbSymbolTableRecord'],...body]);let change=changes.find(c=>c.table===table);
  if(!change){change={table,start:end.start,end:end.start,text:'',count:0,header};changes.push(change);}change.text+=text;change.count++;
 }
 for(const p of primitives){const name=requested(p);if(Object.hasOwn(layers,name))continue;layers[name]=allocate('LAYER',name);resource('LAYER','LAYER',[[100,'AcDbLayerTableRecord'],[2,symbol(layers[name])],[70,0],[62,p.layer==='damage'?1:p.layer==='dimension'?3:5],[6,'Continuous']]);}
 const style=symbol(allocate('STYLE','記録文字'));resource('STYLE','STYLE',[[100,'AcDbTextStyleTableRecord'],[2,style],[70,0],[40,0],[41,1],[50,0],[71,0],[42,1],[3,'msgothic.ttc'],[4,'']]);
 const dashNames=new Map();
 function dashName(dash){const key=dash.join(',');if(dashNames.has(key))return dashNames.get(key);const name=symbol(allocate('LTYPE','記録破線_'+(dashNames.size+1)));dashNames.set(key,name);const values=dash.length%2?[...dash,...dash]:dash;resource('LTYPE','LTYPE',[[100,'AcDbLinetypeTableRecord'],[2,name],[70,0],[3,'Annotation dash'],[72,65],[73,values.length],[40,values.reduce((a,b)=>a+b,0)*k],...values.flatMap((n,i)=>[[49,n*k*(i%2?-1:1)],[74,0]])]);return name;}
 function aci(rgb){const colors=[0xff0000,0xffff00,0x00ff00,0x00ffff,0x0000ff,0xff00ff,0,0x808080,0xc0c0c0];let best=0,dist=Infinity;colors.forEach((c,i)=>{const d=[16,8,0].reduce((n,b)=>n+(((c>>b)&255)-((rgb>>b)&255))**2,0);if(d<dist){best=i;dist=d;}});return rgb===0xffffff?255:best+1;}
 function entity(type,subclass,p,body){added.push(groups([[0,type],[5,handle()],[330,val(model,5)],[100,'AcDbEntity'],[8,symbol(layers[requested(p)])],[62,aci(p.color??0)],[420,p.color??0],...(p.opacity<.999?[[440,0x02000000|Math.round((1-p.opacity)*255)]]:[]),...(p.dash?.length?[[6,dashName(p.dash)]]:[]),[100,subclass],...body]));}
 function poly(p){entity('LWPOLYLINE','AcDbPolyline',p,[[90,p.points.length],[70,p.closed?1:0],...(p.width>0?[[43,p.width*k]]:[]),...p.points.flatMap(q=>{const r=P(q);return [[10,r.x],[20,r.y]];})]);}
 function hatch(p){
  if(p.points.length<3)return;const pts=p.points.map(P),pattern=p.pattern||'solid',angles=pattern==='cross'?[45,135]:pattern==='vertical'?[90]:pattern==='horizontal'?[0]:pattern==='fall'?[135]:[45];
  const solid=pattern==='solid',space=(p.spacing||12)*k;
  if(pattern==='sparse')angles.splice(0,angles.length,0,90);if(pattern==='dots')angles.splice(0,angles.length,0);
  let lines=angles.flatMap(a=>{const r=a*Math.PI/180;return [[53,a],[43,0],[44,0],[45,-Math.sin(r)*space],[46,Math.cos(r)*space],[79,pattern==='dots'?2:0],...(pattern==='dots'?[[49,0],[49,-space]]:[])];});
  if(pattern==='sparse')lines=[[53,0],[43,7*k],[44,-9*k],[45,0],[46,space],[79,2],[49,4*k],[49,-14*k],[53,90],[43,9*k],[44,-11*k],[45,space],[46,0],[79,2],[49,4*k],[49,-14*k]];
  entity('HATCH','AcDbHatch',p,[[10,0],[20,0],[30,0],[210,0],[220,0],[230,1],[2,solid?'SOLID':'CUSTOM'],[70,solid?1:0],[71,0],[91,1],[92,2],[72,0],[73,1],[93,pts.length],...pts.flatMap(q=>[[10,q.x],[20,q.y]]),[97,0],[75,0],[76,1],...(!solid?[[52,0],[41,1],[77,0],[78,angles.length],...lines]:[]),[98,0]]);
 }
 for(const p of primitives){
  if(p.type==='polyline')poly(p);
  else if(p.type==='hatch')hatch(p);
  else if(p.type==='ellipse'){
   const c=P(p.center),u={x:p.u.x*k,y:-p.u.y*k},v={x:p.v.x*k,y:-p.v.y*k},ru=Math.hypot(u.x,u.y),rv=Math.hypot(v.x,v.y);if(!ru||!rv)continue;
   if(Math.abs(ru-rv)<Math.max(ru,rv)*1e-8)entity('CIRCLE','AcDbCircle',p,[[10,c.x],[20,c.y],[30,0],[40,ru]]);
   else{const major=ru>=rv?u:v;entity('ELLIPSE','AcDbEllipse',p,[[10,c.x],[20,c.y],[30,0],[11,major.x],[21,major.y],[31,0],[40,Math.min(ru,rv)/Math.max(ru,rv)],[41,0],[42,Math.PI*2]]);}
  }else if(p.type==='text'){
   const q=P(p.at),text=escapeText(p.text,Number(d.version.slice(2))<1021),chunks=[];
   // MTEXT chunks must fit 250 bytes and must never split a Unicode/CIF escape.
   let chunk='';for(const token of text.match(/\\U\+[0-9A-F]{4}|\\.|[^]/g)||[]){if(new TextEncoder().encode(chunk+token).length>240){chunks.push(chunk);chunk='';}chunk+=token;}chunks.push(chunk);
   const a=-(p.angle||0)*Math.PI/180;
   entity('MTEXT','AcDbMText',p,[[10,q.x],[20,q.y],[30,0],[40,p.height*k],[41,0],[71,1],[7,style],...chunks.map((t,i)=>[i===chunks.length-1?1:3,t]),[11,Math.cos(a)],[21,Math.sin(a)],[31,0]]);
  }else throw Error('未対応の書き込みがあります：'+p.type);
 }
 const end=d.records.find(r=>r.type==='ENDSEC'&&r.section==='ENTITIES');changes.push({start:end.start,end:end.start,text:added.join('')});
 for(const c of [...changes])if(c.table){const t=c.header.tags.find(t=>t.code===70);if(!t)throw Error('DXFの表が不完全です。');changes.push({start:t.valueStart,end:t.valueEnd,text:String(Number(t.value)+c.count)});}
 const seed=d.variable('$HANDSEED');if(!seed)throw Error('DXFの管理番号情報がありません。');changes.push({start:seed.valueStart,end:seed.valueEnd,text:next.toString(16).toUpperCase()});
 if(Number(d.version.slice(2))>=1021)for(const c of changes)c.text=binaryString(new TextEncoder().encode(c.text));
 let output=d.raw;for(const c of changes.sort((a,b)=>b.start-a.start))output=output.slice(0,c.start)+c.text+output.slice(c.end);
 return {bytes:Uint8Array.from(output,c=>c.charCodeAt(0)),layers,count:added.length};
}
const api={scan,decode,encoding,inspect,makeFrame,appendPrimitives,UNITS};
if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDxfCore=api;
})(typeof globalThis==='object'?globalThis:this);

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../sentlog/dxf-core.js'),fixture=n=>fs.readFileSync(path.join(__dirname,'fixtures',n));
const inputs=[fixture('dxf-model.dxf'),Buffer.from(fixture('dxf-cp932.b64').toString(),'base64')];
const primitives=[
 {type:'polyline',layer:'damage',color:0xc62828,points:[{x:10,y:10},{x:50,y:90}],width:1.5,dash:[7,3,1,3]},
 {type:'polyline',layer:'memo',color:0x1d4ed8,points:[{x:80,y:80},{x:150,y:80},{x:150,y:120},{x:80,y:120}],closed:true,width:1},
 {type:'ellipse',layer:'memo',color:0x1d4ed8,center:{x:250,y:130},u:{x:100,y:0},v:{x:0,y:50}},
 {type:'text',layer:'label',color:0x000000,at:{x:100,y:100},height:12,angle:45,text:'漏水・ひび割れ①\n日本語テスト'.repeat(30)},
 {type:'hatch',layer:'damage',color:0x7e22ce,points:[{x:300,y:200},{x:400,y:200},{x:400,y:300},{x:300,y:300}],pattern:'cross',spacing:12},
 {type:'hatch',layer:'memo',color:0xffffff,points:[{x:20,y:30},{x:40,y:30},{x:40,y:50},{x:20,y:50}]},
 {type:'polyline',layer:'dimension',color:0,points:[{x:50,y:400},{x:250,y:400}],width:1}
];
for(const [index,bytes] of inputs.entries()){
 const before=C.scan(bytes),info=C.inspect(bytes);assert(info.hatches>=1);assert(info.warnings.some(w=>w.includes('モデル空間')));assert.equal(info.units,4);
 const names=['腐食_図形','メモ_四角','メモ_丸','漏水_名称','腐食_ハッチング','メモ_文字背景','寸法_線'];primitives.forEach((p,i)=>p.layerName=names[i]);
 const result=C.appendPrimitives(bytes,primitives,{xMin:-500,yMax:6000,unitsPerPixel:10});const after=C.scan(result.bytes);
 for(const r of before.records){const id=r.tags.find(t=>t.code===5||t.code===105)?.value;if(!id||['TABLE','SECTION'].includes(r.type))continue;const q=after.records.find(x=>x.tags.some(t=>(t.code===5||t.code===105)&&t.value===id));assert(q);assert.equal(before.raw.slice(r.start,r.end),after.raw.slice(q.start,q.end));}
 assert.equal(result.count,7);const second=C.appendPrimitives(result.bytes,primitives,{xMin:-500,yMax:6000,unitsPerPixel:10});for(const n of names){assert.equal(result.layers[n],n);assert.equal(second.layers[n],n+'_2');}
 assert.deepEqual(C.appendPrimitives(bytes,[],{xMin:0,yMax:0,unitsPerPixel:1}).bytes,new Uint8Array(bytes));
 assert(!C.decode(result.bytes).includes('SENTLOG'));
 const allHandles=after.records.filter(r=>r.type!=='SECTION').map(r=>r.tags.find(t=>t.code===5||t.code===105)?.value).filter(Boolean);assert.equal(new Set(allHandles).size,allHandles.length);
 assert(C.decode(result.bytes).includes(index===0?'漏水':'\\U+6F0F'));
 fs.mkdirSync('test-results/dxf',{recursive:true});fs.writeFileSync(`test-results/dxf/core-${index}.dxf`,result.bytes);
}
assert.throws(()=>C.scan(new TextEncoder().encode('AutoCAD Binary DXF\r\n')),/バイナリ/);
assert.throws(()=>C.scan(new Uint8Array(8*1024*1024+1)),/8MB/);
assert.throws(()=>C.scan(new TextEncoder().encode('0\nSECTION\n2\n')),/途中/);
const frame=C.makeFrame({minX:10000000,maxX:10001000,minY:-20000000,maxY:-19999000});assert.equal(frame.width,2048);assert.equal(frame.height,2048);assert(frame.unitsPerPixel>0);
console.log('PASS DXF: source-byte retention, codepages, Japanese long text, hatch, editable primitives, units/frame, collision-safe handles and repeat export');

// Sanitization, truncation, case-insensitive names, and escaped Japanese all
// allocate unique layer names without merging or changing existing layers.
for(const bytes of inputs){
 const names=['Leak/図形','Leak:図形','leak_図形','非常に長い損傷名'.repeat(35)+'甲','非常に長い損傷名'.repeat(35)+'乙','__proto__'];
 const items=names.map(layerName=>({...primitives[0],layerName}));
 const result=C.appendPrimitives(bytes,items,{xMin:0,yMax:0,unitsPerPixel:1});
 assert.equal(Object.keys(result.layers).length,names.length);
 assert.equal(new Set(Object.values(result.layers).map(n=>n.toUpperCase())).size,names.length);
 assert(Object.values(result.layers).every(n=>!/[<>/\\":;?*|=,`]/.test(n)&&n.length<100));
 const again=C.appendPrimitives(result.bytes,items,{xMin:0,yMax:0,unitsPerPixel:1});
 assert(Object.values(again.layers).every(n=>!Object.values(result.layers).includes(n)));
}
console.log('PASS unbranded Japanese layers: per-purpose names, source collisions, Unicode/CP932, case, invalid chars, long names and no-op export');

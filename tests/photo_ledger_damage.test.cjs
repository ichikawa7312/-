'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const D=require('../sentlog/photo-ledger-damage.js');
const L=require('../sentlog/photo-ledger.js');
const file=path.join(__dirname,'../sentlog/damage-ledger-template.xlsx');
const fixture=fs.readFileSync(file);
const decoder=new TextDecoder();
const entries=[
  ...Array.from({length:8},(_,i)=>({included:true,type:'ひび割れ',drawingId:'sheet-a',shapeId:'shape-2',typeNo:2,damage:'ひび割れ-2',member:'主桁G1',description:'浮き・段差あり',rangeText:'0.800×0.500m',photoId:'p'+i,jpeg:new Uint8Array([255,216,255,217])})),
  ...Array.from({length:3},(_,i)=>({included:true,type:'剥離',drawingId:'sheet-b',shapeId:'shape-9',typeNo:9,damage:'剥離-9',member:'床版',description:'記録済み',photoId:'q'+i,jpeg:new Uint8Array([255,216,255,217])})),
];
const groups=[{name:'ひび割れ',photos:entries.filter(e=>e.type==='ひび割れ')},{name:'剥離',photos:entries.filter(e=>e.type==='剥離')}];
function unpackStored(buffer){
 const r=new Map(),v=Buffer.from(buffer);let pos=0;
 while(pos+30<v.length&&v.readUInt32LE(pos)===0x04034b50){
  const size=v.readUInt32LE(pos+18),nameLength=v.readUInt16LE(pos+26),extra=v.readUInt16LE(pos+28),name=v.subarray(pos+30,pos+30+nameLength).toString(),dataAt=pos+30+nameLength+extra;
  r.set(name,v.subarray(dataAt,dataAt+size));pos=dataAt+size;
 }return r;
}
(async()=>{
 const raw=await D.unzip(fixture);
 assert.equal(raw.get('xl/styles.xml').length>10000,true);
 const good=D.recordsFor(groups[0].photos);
 assert.equal(good.length,4,'8 photos are 4 damage cards (2 pictures/card)');
 assert.equal(good[0].photos.length,2);assert.equal(good.at(-1).photos.length,2);
 const xlsx=await D.buildXlsx('試験案件','調査⑫',groups,new Uint8Array(fixture));
 const files=unpackStored(await xlsx.arrayBuffer());
 assert.deepEqual(files.get('xl/styles.xml'),Buffer.from(raw.get('xl/styles.xml')),'source Excel styles must be byte-identical');
 const names=decoder.decode(files.get('xl/workbook.xml'));
 assert.match(names, /<sheet name="ひび割れ"/);assert.match(names, /<sheet name="剥離"/);
 const sheet=decoder.decode(files.get('xl/worksheets/sheet1.xml'));
 assert.match(sheet, /主桁G1/);assert.match(sheet,/0\.800×0\.500m/);assert.match(sheet,/浮き・段差あり/);
 assert.match(sheet, /<mergeCells count="60">/,'original 30 merged ranges times 2 pages');
 assert.match(sheet, /<brk id="57"/);assert.match(sheet, /<brk id="114"/);
 assert.match(sheet, /<row r="114"/,'two complete pages');
 assert.match(sheet,/調査⑫　ひび割れ　写真台帳/,'stale original header replaced, same format');
 assert.doesNotMatch(sheet, /西面　外壁　写真台帳|写真番号：/,'no old fixed heading or photo numbering');
 assert.equal([...files].filter(([k])=>k.startsWith('xl/media/')&&k.endsWith('.jpeg')).length,11);
 assert.equal((decoder.decode(files.get('xl/drawings/drawing1.xml')).match(/<xdr:twoCellAnchor/g)||[]).length,8);
 assert.equal((decoder.decode(files.get('xl/drawings/drawing2.xml')).match(/<xdr:twoCellAnchor/g)||[]).length,3);
 const rawXml=decoder.decode(raw.get('xl/worksheets/sheet1.xml'));
 const widths=t=>(t.match(/<cols>[^]*?<\/cols>/)||[])[0];
 assert.equal(widths(sheet),widths(rawXml),'original column dimensions untouched');
 assert.ok(sheet.includes('<row r="57" spans="1:12" ht="14.25"'),'original row heights untouched');
 assert.equal((sheet.match(/<mergeCell ref=/g)||[]).length,60);
 await assert.rejects(()=>D.buildXlsx('a','b',[{name:'空',photos:[]}],new Uint8Array(fixture)),/出力対象/);
 await assert.rejects(()=>D.buildXlsx('a','b',[{name:'a',photos:[{drawingId:'x',shapeId:'y'}]}],new Uint8Array(fixture)),/未取得/);
 console.log('PASS: damage ledger original-cell formatting, paired photos, multi-page, category sheets, no photo serials');
})().catch(e=>{console.error(e);process.exitCode=1});
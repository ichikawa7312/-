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
 assert.equal(good.length,1,'one damaged location must occupy exactly one printed card');
 assert.equal(good[0].photos.filter(Boolean).length,2,'exactly 2 submission photos');
 assert.equal(good[0].extraPhotos.length,6,'all six extras stay in the same Excel sheet');
 const chosen=[
   {...groups[0].photos[0],damageRole:'reserve'},
   {...groups[0].photos[1],damageRole:'close'},
   {...groups[0].photos[2],damageRole:'overview'},
   ...groups[0].photos.slice(3).map(e=>({...e,damageRole:'reserve'}))
 ];
 const custom=D.recordsFor(chosen)[0];
 assert.deepEqual(custom.photos.map(e=>e?.photoId),['p2','p1'],'main photo order follows explicit user selection');
 assert.equal(custom.extraPhotos.length,6);
 assert.equal(groups[0].photos.every(e=>!e.damageRole),true,'selection does not change source photos');
 // The shooting-location cell must use only the shape's actual member/part.
 // Do not silently substitute drawing/PDF names or camera filenames.
 const unnamed={included:true,type:'ひび割れ',drawingId:'sheet-file',shapeId:'shape-empty',typeNo:4,
   member:'  ',sheetName:'配管点検_図面名.pdf',photoName:'IMG_1234.jpg',photoId:'camera-1',
   description:'',rangeText:'',jpeg:new Uint8Array([255,216,255,217])};
 assert.equal(D.recordsFor([unnamed])[0].member,'','blank location must remain blank even when drawing/photo names exist');
 assert.equal(D.recordsFor([{...unnamed,member:'主桁 G2'}])[0].member,'主桁 G2');
 const blankBook=await D.buildXlsx('試験案件','調査⑫',[{name:'ひび割れ',photos:[unnamed]}],new Uint8Array(fixture));
 const blankFiles=unpackStored(await blankBook.arrayBuffer());
 const blankSheet=decoder.decode(blankFiles.get('xl/worksheets/sheet1.xml'));
 assert.match(blankSheet, /<c r="C3"[^>]* t="inlineStr"><is><t xml:space="preserve"><\/t><\/is><\/c>/,
   'shooting location C3 must be an empty cell when member is not recorded');
 assert.doesNotMatch(blankSheet,/配管点検_図面名\.pdf|IMG_1234\.jpg/,'filenames must never become a shooting location');
 assert.deepEqual(blankFiles.get('xl/styles.xml'),Buffer.from(raw.get('xl/styles.xml')),'blank location must not modify styles');
 const xlsx=await D.buildXlsx('試験案件','調査⑫',groups,new Uint8Array(fixture));
 const files=unpackStored(await xlsx.arrayBuffer());
 assert.deepEqual(files.get('xl/styles.xml'),Buffer.from(raw.get('xl/styles.xml')),'source Excel styles must be byte-identical');
 const names=decoder.decode(files.get('xl/workbook.xml'));
 assert.match(names, /<sheet name="ひび割れ"/);assert.match(names, /<sheet name="剥離"/);
 const sheet=decoder.decode(files.get('xl/worksheets/sheet1.xml'));
 assert.match(sheet, /主桁G1/);assert.match(sheet,/0\.800×0\.500m/);assert.match(sheet,/浮き・段差あり/);
 assert.match(sheet, /<mergeCells count="30">/,'one original-format printed page for one damaged location');
 assert.match(sheet, /<brk id="57"/,'the original final page break is kept');
 assert.doesNotMatch(sheet, /<brk id="114"/,'reserves must not introduce a second printed page');
 assert.match(sheet, /<row r="57"/,'original page rows remain present');
 assert.match(sheet, /<c r="N2"[^>]*t="inlineStr">/,'reserve title shares the first damage card header row');
 assert.match(sheet, /予備写真 6枚（印刷対象外）/);
 for(const col of ['N','T','Z','AF','AL','AR'])
   assert.match(sheet,new RegExp('<c r="'+col+'3"[^>]*t="inlineStr">'),'all six reserve captions share the same row beside the damage card');
 assert.match(sheet,/調査⑫　ひび割れ　写真台帳/,'stale original header replaced, same format');
 assert.doesNotMatch(sheet, /西面　外壁　写真台帳|写真番号：/,'no old fixed heading or photo numbering');
 assert.equal([...files].filter(([k])=>k.startsWith('xl/media/')&&k.endsWith('.jpeg')).length,11);
 const mainDrawing=decoder.decode(files.get('xl/drawings/drawing1.xml'));
 const otherDrawing=decoder.decode(files.get('xl/drawings/drawing2.xml'));
 assert.equal((mainDrawing.match(/<xdr:twoCellAnchor/g)||[]).length,2,'only two photos printed');
 assert.equal((mainDrawing.match(/<xdr:oneCellAnchor/g)||[]).length,6,'six reserve images must be editable outside the print range');
 assert.equal((otherDrawing.match(/<xdr:twoCellAnchor/g)||[]).length,2);
 assert.equal((otherDrawing.match(/<xdr:oneCellAnchor/g)||[]).length,1);
 assert.match(mainDrawing,/<xdr:col>13<\/xdr:col>/,'reserves begin at N, right of A:L');
 const reserveAnchors=[...mainDrawing.matchAll(/<xdr:oneCellAnchor>([\s\S]*?)<\/xdr:oneCellAnchor>/g)];
 assert.deepEqual(reserveAnchors.map(a=>Number(a[1].match(/<xdr:col>(\d+)<\/xdr:col>/)[1])),[13,19,25,31,37,43],
   'every extra photo must appear left to right on its own damage row');
 assert.deepEqual(reserveAnchors.map(a=>Number(a[1].match(/<xdr:row>(\d+)<\/xdr:row>/)[1])),Array(6).fill(6),
   'all extras for one location share the printed card photo row');
 assert.match(mainDrawing,/xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/);
 // Different damage records must each keep their own reserve photos on the
 // corresponding printed row (1st, 2nd, 3rd card, then next printed page).
 const others=Array.from({length:4},(_,j)=>Array.from({length:5},(_,i)=>({
   included:true,drawingId:'area',shapeId:'shape-'+j,typeNo:j+1,damage:'調査-'+(j+1),
   photoId:'r'+j+'-'+i,photoName:'sample-'+i+'.jpg',jpeg:entries[0].jpeg
 }))).flat();
 const multiRecords=D.recordsFor(others),multiData=D.drawingData(multiRecords,1);
 assert.equal(multiRecords.length,4,'four damage records keep four printed cards');
 const allReserve=[...multiData.drawing.matchAll(/<xdr:oneCellAnchor>([\s\S]*?)<\/xdr:oneCellAnchor>/g)]
   .map(m=>({col:Number(m[1].match(/<xdr:col>(\d+)<\/xdr:col>/)[1]),row:Number(m[1].match(/<xdr:row>(\d+)<\/xdr:row>/)[1])}));
 assert.deepEqual(allReserve.map(p=>p.col),[13,19,25,13,19,25,13,19,25,13,19,25]);
 assert.deepEqual(allReserve.map(p=>p.row),[6,6,6,25,25,25,44,44,44,63,63,63],
   'each set of 3 reserves is aligned with its corresponding printed damage location across pages');
 assert.deepEqual(multiData.notes.filter(n=>n.text.startsWith('予備')).map(n=>n.row),
   [3,3,3,22,22,22,41,41,41,60,60,60]);
 const workbook=decoder.decode(files.get('xl/workbook.xml'));
 assert.match(workbook,/\$A\$1:\$L\$57/,'printed area remains strictly within columns A:L');
 const rawXml=decoder.decode(raw.get('xl/worksheets/sheet1.xml'));
 const widths=t=>(t.match(/<cols>[^]*?<\/cols>/)||[])[0];
 assert.equal(widths(sheet),widths(rawXml),'original column dimensions untouched');
 assert.ok(sheet.includes('<row r="57" spans="1:12" ht="14.25"'),'original row heights untouched');
 assert.equal((sheet.match(/<mergeCell ref=/g)||[]).length,30);
 await assert.rejects(()=>D.buildXlsx('a','b',[{name:'空',photos:[]}],new Uint8Array(fixture)),/出力対象/);
 await assert.rejects(()=>D.buildXlsx('a','b',[{name:'a',photos:[{drawingId:'x',shapeId:'y'}]}],new Uint8Array(fixture)),/未取得/);
 console.log('PASS: damage ledger two chosen photos, all off-print backups, original format, original JPEG data and layout');
})().catch(e=>{console.error(e);process.exitCode=1});

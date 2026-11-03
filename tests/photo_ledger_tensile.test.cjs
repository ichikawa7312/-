'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const D=require('../sentlog/photo-ledger-tensile.js');
const S=require('../sentlog/photo-ledger-damage.js');
const templateEncoded=fs.readFileSync(path.join(__dirname,'../sentlog/tensile-ledger-template.b64'),'utf8').replace(/\s+/g,'');
const template=Buffer.from(templateEncoded,'base64');
const image=new Uint8Array([0xff,0xd8,0xff,0xe0,0,0x10,0x4a,0x46,0x49,0x46,0,0,0xff,0xd9]);
const mk=(shapeId,n,member)=>Array.from({length:n},(_,i)=>({
  drawingId:'sheet1',shapeId,photoId:shapeId+'-'+i,photoName:'camera-'+i+'.jpg',
  sheetName:'設計図面_'+i+'.pdf',member,damage:'アンカー-'+shapeId,
  included:true,jpeg:image,description:'照査結果'
}));
function unzipStored(buffer){
  const b=Buffer.from(buffer),files=new Map();let offset=0;
  while(offset+30<=b.length&&b.readUInt32LE(offset)===0x04034b50){
    const size=b.readUInt32LE(offset+18),nameSize=b.readUInt16LE(offset+26),extra=b.readUInt16LE(offset+28);
    const name=b.subarray(offset+30,offset+30+nameSize).toString();
    const start=offset+30+nameSize+extra;
    files.set(name,b.subarray(start,start+size));
    offset=start+size;
  }
  return files;
}
(async()=>{
  const raw=await S.unzip(template);
  assert.ok(raw.has('xl/worksheets/sheet1.xml'));
  assert.ok(!raw.has('xl/comments1.xml'),'invisible author comments must be removed');
  assert.ok(!raw.has('xl/worksheets/sheet2.xml'),'hidden extra sheet not needed');
  assert.ok(!Buffer.from(raw.get('xl/workbook.xml')).toString().includes('Z:\\'),'author workstation path removed');

  const entries=[...mk('A',4,'配管室'),...mk('B',6,'')];
  const metadata={
    [D.keyFor(entries[0])]:{place:'上流側',anchorNo:'A-001',detail:'右端上から2本目',loadKn:'12.5',judgement:'合格',after:'異常なし'},
    [D.keyFor(entries[4])]:{place:'',anchorNo:'A-002',detail:'下流端',loadKn:'',judgement:'',after:''}
  };
  const records=D.recordsFor(entries,metadata);
  assert.equal(records.length,3,'10 photos should form 3 worksheets, no omitted extra photos');
  assert.deepEqual(records.map(r=>r.photos.length),[4,4,2]);
  assert.equal(records[1].details.place,'','blank place must not fall back to PDF or photo filename');
  const xlsx=await D.buildXlsx('試験案件','調査No.1',entries,metadata,new Uint8Array(template));
  const files=unzipStored(Buffer.from(await xlsx.arrayBuffer()));
  assert.deepEqual(files.get('xl/styles.xml'),Buffer.from(raw.get('xl/styles.xml')),'exact template styles retained');
  for(let i=1;i<=3;i++){
    const sheet=files.get('xl/worksheets/sheet'+i+'.xml').toString();
    const drawing=files.get('xl/drawings/drawing'+i+'.xml').toString();
    assert.match(sheet,/ref="C1:G10"/,'original merged photo areas retained');
    assert.match(sheet,/<pageSetup paperSize="9" scale="76" orientation="portrait"/,'A4 print settings retained');
    assert.equal((sheet.match(/<mergeCell ref=/g)||[]).length,36,'merged ranges retained');
    assert.equal((drawing.match(/<xdr:sp /g)||[]).length,4,'original 4 numbered circles retained');
    assert.equal((drawing.match(/<xdr:oneCellAnchor>/g)||[]).length,[4,4,2][i-1]);
    assert.doesNotMatch(sheet,/設計図面_|camera-/,'source file names are not mapped to location');
  }
  const first=files.get('xl/worksheets/sheet1.xml').toString();
  assert.match(first,/上流側/);assert.match(first,/A-001/);assert.match(first,/12.5kN 合格/);
  assert.match(first,/試験後 母材状況 異常なし/);
  const second=files.get('xl/worksheets/sheet2.xml').toString();
  assert.match(second,/引張試験結果 未入力 未判定/);
  assert.match(second,/試験後 母材状況 未確認/);
  assert.doesNotMatch(second,/合格|異常なし/);
  assert.equal([...files.keys()].filter(name=>name.startsWith('xl/media/tensile-')).length,10);
  assert.match(files.get('xl/workbook.xml').toString(),/\$A\$1:\$J\$43/,'print range remains A4 page');

  const loadFree={[D.keyFor(entries[0])]:{judgement:'合格',loadKn:''}};
  await assert.rejects(()=>D.buildXlsx('x','y',[entries[0]],loadFree,new Uint8Array(template)),/引張荷重/);
  await assert.rejects(()=>D.buildXlsx('x','y',[entries[0]],{[D.keyFor(entries[0])]:{loadKn:'abc'}},new Uint8Array(template)),/数値/);
  await assert.rejects(()=>D.buildXlsx('x','y',[],{},new Uint8Array(template)),/出力できる写真/);
  console.log('PASS tensile: exact XLSX layout, numbered circles, safe result input, 10 photo/3 worksheet coverage, no source name fallback');
})().catch(e=>{console.error(e);process.exitCode=1});
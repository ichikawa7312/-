const assert=require('node:assert/strict');
const fs=require('node:fs');
const L=require('../sentlog/photo-ledger.js');
const builder=fs.readFileSync(require('node:path').join(__dirname,'../scripts/build_photo_ledger.py'),'utf8');
assert.ok(builder.includes('html=html.replace'), 'feature module is loaded as separate script');
assert.ok(!builder.includes("const deps=[['photo-ledger.js"), 'optional feature must not block app startup');

const group={id:'group-1',name:'調査⑫',sheets:[
  {id:'sheet1',sheetName:'PDF 1',groupId:'group-1'},
  {id:'sheet2',sheetName:'PDF 2',groupId:'group-1'}]};
const st={sheet1:{shapes:[
  {id:'a',type:'ひび割れ',typeNo:51,member:'床版',memo:'W=0.2mm',photos:[{id:'p1',name:'A.jpg'},{id:'p2',name:'B.jpg'}]},
  {id:'b',type:'全景',typeNo:1,photos:[{id:'p3',name:'C.jpg'}]},
  {id:'empty',type:'腐食',typeNo:2,photos:[]}]},sheet2:{shapes:[
  {id:'c',type:'ひび割れ',typeNo:2,photos:[{id:'p4'},{id:'p5'},{id:'p6'},{id:'p7'},{id:'p8'}]},
  {id:'d',type:'剥離',typeNo:1,photos:[{id:'p9'}]}]}};
assert.equal(L.damageLabel({type:'ひび割れ',typeNo:51,autoLabel:'ひび割れ㊿'}),'ひび割れ-51');
assert.equal(L.damageLabel({type:'鉄筋露出',typeNo:102}),'鉄筋露出-102');
assert.equal(L.category({type:'全景'}),L.OTHER);
assert.deepEqual(L.excelSheetNames(['abcdef '.repeat(7),'abcdef '.repeat(7)]).map(x=>x.length).every(n=>n<=31),true);
const got=L.collect(group,st);assert.deepEqual(got.errors,[]);assert.equal(got.entries.length,9);
assert.equal(got.entries[0].type,L.OTHER);
const c=got.entries.filter(e=>e.type==='ひび割れ');assert.equal(c.length,7);
assert.equal(c[0].typeNo,2);assert.equal(c[0].drawingId,'sheet2');
assert.equal(c[5].typeNo,51);
assert.equal(L.collect(group,{sheet1:st.sheet1}).errors.length,1,'missing sheet state must never be silently omitted even when metadata counts are stale or empty');
assert.equal(L.collect({sheets:[{id:'s',photoCount:1,sheetName:'lost.pdf'}]},{}).errors.length,1);
assert.equal(L.collect({sheets:[{id:'s',sheetName:'stale-photo-count',photoCount:2}]},{s:{shapes:[{id:'a',type:'腐食',typeNo:1,photos:[{id:'one'}]}]}}).errors.length,1,'missing references must stop export even when a sheet state exists');
assert.equal(L.collect({sheets:[{id:'s',sheetName:'duplicate',photoCount:2}]},{s:{shapes:[{id:'a',type:'腐食',typeNo:1,photos:[{id:'same'},{id:'same'}]}]}}).errors.length,1,'duplicate IDs on one shape cannot be silently discarded');

const groups=L.groupsFor(got.entries,['全景・その他','ひび割れ','剥離']);
let fake=new Uint8Array([255,216,255,217]);for(const e of got.entries)e.jpeg=fake;
function unzip(buffer){const files=new Map();let i=0;while(i+30<buffer.length&&buffer.readUInt32LE(i)===0x04034b50){const size=buffer.readUInt32LE(i+18),len=buffer.readUInt16LE(i+26),extra=buffer.readUInt16LE(i+28);const name=buffer.subarray(i+30,i+30+len).toString();const a=i+30+len+extra;files.set(name,buffer.subarray(a,a+size));i=a+size;}return files;}
(async()=>{
  const xlsx=await L.buildXlsx('試験案件','調査⑫',groups);const files=unzip(Buffer.from(await xlsx.arrayBuffer()));
  assert.ok(files.has('xl/workbook.xml'));assert.ok(files.has('xl/worksheets/sheet2.xml'));
  const sheet=files.get('xl/worksheets/sheet2.xml').toString();
  assert.match(sheet,/<pageSetup paperSize="9" orientation="portrait" fitToWidth="1"/);
  assert.match(sheet,/<rowBreaks count="2" manualBreakCount="2">/);
  assert.match(sheet, /<row r="3" ht="25" customHeight="1">/,'photo blocks should use the A4 page height');
  assert.match(sheet, /width="14\.9"/,'photo region enlarged');
  assert.match(sheet, /width="10\.4"/,'details fit within A4 page width');
  assert.match(sheet, /<pageMargins left="0\.35" right="0\.35" top="0\.35" bottom="0\.35"/);
  assert.match(sheet, /写真番号：002/,'serials continue across category worksheets');
  assert.match(sheet, /写真番号：008/,'serials remain uninterrupted within categories');
  assert.match(sheet, /E6:H11/,'notes have a six-row merged multiline area');

  // Each printed page contains three complete card frames separated by 18pt gaps.
  assert.match(sheet, /<row r="12" ht="18" customHeight="1"\/>/,'first spacer is open and borderless');
  assert.match(sheet, /<row r="22" ht="18" customHeight="1"\/>/,'second spacer is open and borderless');
  assert.match(sheet, /<row r="13" ht="25" customHeight="1">/,'second photo frame begins after spacer');
  assert.match(sheet, /<row r="23" ht="25" customHeight="1">/,'third photo frame begins after spacer');
  assert.match(sheet, /E13:H13/,'second photo detail fields still merge');
  assert.match(sheet, /<row r="32" ht="18" customHeight="1"\/>/,'footer row stays in print range, without a number');
  assert.match(files.get('xl/workbook.xml').toString(), /\$H\$96/,'print area uses 32-row pages');
  const totalHeight=26+20+3*9*25+2*18+18;
  const availableHeight=297/25.4*72-2*0.35*72;
  assert.ok(totalHeight<=availableHeight,'three photo cards and gaps fit A4 print height');

  assert.ok(!sheet.includes('写真名：')&&!sheet.includes('図面：PDF')&&!sheet.includes('図面No.：調査⑫'), 'redundant image and PDF metadata must not appear');
  const styles=files.get('xl/styles.xml').toString();

  // Clean monochrome report header: no color band or bureaucratic "案件：" label.
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr">[^]*?調査⑫　写真台帳/,'drawing title retained');
  assert.match(sheet, /<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">試験案件<\/t><\/is><\/c>/,'project name shown on its own');
  assert.doesNotMatch(sheet, /案件：/,'administrative label removed');
  assert.match(styles, /<fills count="2">/,'no decorative title background');
  assert.doesNotMatch(styles, /FFEFF3F8|fillId="2"|applyFill="1"/,'no colored header');
  assert.match(styles, /<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"\/>/,'title stays bold on white');
  assert.match(styles, /<borders count="16">/,'perimeter and divider border styles');
  assert.match(styles, /<cellXfs count="51">/,'51st cell style aligns page number right');
  assert.match(files.get('xl/drawings/drawing2.xml').toString(), /<a:ln w="6350">/,'images have visible outlines');
  assert.match(styles, /<color rgb="FF000000"\/>/,'all cell frames must print in black');
  assert.doesNotMatch(styles, /FF94A3B8/,'old gray line styles must not remain');
  // The merged E:H detail rows must have a black bottom rule after each field.
  // Styles use variant base 2 (normal), 18 (bold), 34 (notes), plus a border mask.
  assert.match(sheet, /<c r="E3" s="31" t="inlineStr">/,'number row has upper/bottom/left rules');
  assert.match(sheet, /<c r="F3" s="14"\/>/,'number rule continues across merged cells');
  assert.match(sheet, /<c r="E4" s="11" t="inlineStr">/,'damage row is separated');
  assert.match(sheet, /<c r="F4" s="10"\/>/,'damage rule continues across merged cells');
  assert.match(sheet, /<c r="E5" s="11" t="inlineStr">/,'member row is separated');
  assert.match(sheet, /<c r="F5" s="10"\/>/,'member rule continues across merged cells');
  assert.match(sheet, /<c r="E6" s="35" t="inlineStr">/,'notes keep a tall undivided writing area');
  const drawing=files.get('xl/drawings/drawing2.xml').toString();
  const anchors=drawing.match(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g)||[];
  assert.equal(anchors.length,7,'photo anchors and media count stay aligned');
  for(const anchor of anchors){
    assert.match(anchor, /<xdr:from><xdr:col>0<\/xdr:col><xdr:colOff>114300<\/xdr:colOff>/);
    assert.match(anchor, /<xdr:to><xdr:col>3<\/xdr:col><xdr:colOff>923925<\/xdr:colOff>/,'right edge stops inside the D-column frame');
    assert.match(anchor, /<xdr:rowOff>241300<\/xdr:rowOff><\/xdr:to>/,'bottom edge stays above the row border');
    assert.match(anchor, /<a:srgbClr val="000000"\/>/,'photo outlines are black');
  }


  assert.match(sheet,/<brk id="32"/);assert.match(sheet,/<brk id="64"/);
  assert.match(sheet,/ひび割れ-51/);
  const names=files.get('xl/workbook.xml').toString();assert.match(names,/全景・その他/);assert.match(names,/ひび割れ/);
  assert.equal([...files.keys()].filter(x=>x.startsWith('xl/media/image')).length,9);
  let missing=got.entries[0];delete missing.jpeg;
  await assert.rejects(()=>L.buildXlsx('x','y',groups),/未取得/);
  // Large synthetic case: ensure many photos are not truncated or renumbered,
  // and every A4 sheet has exactly three image slots without silent omissions.
  const large=Array.from({length:120},(_,i)=>({
    key:'large:'+i,damage:'ひび割れ-'+(i+1),type:'ひび割れ',
    jpeg:fake,description:'合成写真',member:'床版',sheetName:'上部工',photoName:'fixture.jpg',page:1
  }));
  const big=unzip(Buffer.from(await (await L.buildXlsx('大量写真検証','図面No.1',[{name:'ひび割れ',photos:large}])).arrayBuffer()));
  assert.equal([...big.keys()].filter(x=>x.startsWith('xl/media/image')&&x.endsWith('.jpeg')).length,120);
  const bigSheet=big.get('xl/worksheets/sheet1.xml').toString();
  assert.match(bigSheet,/<rowBreaks count="39" manualBreakCount="39">/);
  assert.match(bigSheet,/<brk id="1248"/);
  assert.match(bigSheet,/写真番号：120/);
  assert.match(bigSheet,/ひび割れ-120/);
  const over=Array.from({length:L.MAX_PHOTOS+1},(_,i)=>({...large[0],key:'over:'+i}));
  await assert.rejects(()=>L.buildXlsx('過大','図面',[{name:'ひび割れ',photos:over}]),/600枚を超え/);
  console.log('PASS photo ledger: 120-photo pagination, image count, uninterrupted numbering and safe max guard');
  console.log('PASS photo ledger: multi-PDF aggregation, exact -51 labels, A4/3-up XLSX, 3-page breaks, photo guards');
})().catch(e=>{console.error(e);process.exitCode=1;});
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Visual=require('../sentlog/photo-ledger-visual3.js');
const Damage=require('../sentlog/photo-ledger-damage.js');
const template=Buffer.from(fs.readFileSync(path.join(__dirname,'../sentlog/visual3-ledger-template.b64'),'utf8').replace(/\s+/g,''),'base64');
const fixture=new Uint8Array([0xff,0xd8,0xff,0xe0,0,0x10,0x4a,0x46,0x49,0x46,0,0,0xff,0xd9]);
function zipParts(buffer){
  const buf=Buffer.from(buffer),out=new Map();let pos=0;
  while(pos+30<=buf.length&&buf.readUInt32LE(pos)===0x04034b50){
    const len=buf.readUInt32LE(pos+18),namelen=buf.readUInt16LE(pos+26),extra=buf.readUInt16LE(pos+28);
    const key=buf.subarray(pos+30,pos+30+namelen).toString('utf8');
    const from=pos+30+namelen+extra;
    out.set(key,buf.subarray(from,from+len));pos=from+len;
  }
  return out;
}
(async()=>{
  assert.equal(crypto.createHash('sha256').update(template).digest('hex'),'d2d4ea224ab1a35bab4b502480ad15780599bb8a6a5aeea23b25bf3dfc0f1ee5');
  const original=await Damage.unzip(template);
  const styles=Buffer.from(original.get('xl/styles.xml'));
  const groups=[
    {name:'全景',photos:Array.from({length:4},(_,i)=>({
      drawingId:'d1',shapeId:'s'+i,photoId:'p'+i,damage:'全景-'+(i+1),
      member:'魚道工',description:i===0?'上流から撮影':'',included:true,jpeg:fixture,
      ...(i===0?{visual3:{managementNo:'整理A',facility:'魚道工',structure:'鉄筋コンクリート',purpose:'全景',notes:'上流から撮影'}}:{})
    }))},
    {name:'調査',photos:Array.from({length:2},(_,i)=>({
      drawingId:'d2',shapeId:'t'+i,photoId:'q'+i,damage:'調査-'+(i+1),
      member:'水路工',description:'目視確認',included:true,jpeg:fixture
    }))}
  ];
  const snapshot=groups.map(g=>g.photos.map(p=>({damage:p.damage,description:p.description,visual3:p.visual3})));
  const file=await Visual.buildXlsx('依田川農水頭首工','11 魚道工',groups,new Uint8Array(template));
  const out=zipParts(Buffer.from(await file.arrayBuffer()));
  assert.equal(out.size,30,'two populated sheets plus one number-only template sheet and six JPEGs');
  assert.deepEqual(out.get('xl/styles.xml'),styles,'original workbook styles are byte-identical');
  const book=out.get('xl/workbook.xml').toString();
  assert.match(book,/\$A\$1:\$AJ\$68/,'two page print area');
  assert.match(book,/\$A\$1:\$AJ\$34/,'one page print area');
  assert.match(book,/\$A\$1:\$AJ\$4556/,'134-page print area for numbers 1 through 400');
  assert.match(book,/連番ひな形（1～400）/,'one visibly named numbered template tab');
  assert.doesNotMatch(book,/#REF!/,'invalid historical named ranges removed');
  for(const [idx,n,pages] of [[1,4,2],[2,2,1]]){
    const sheet=out.get('xl/worksheets/sheet'+idx+'.xml').toString();
    const drawing=out.get('xl/drawings/drawing'+idx+'.xml').toString();
    const rels=out.get('xl/drawings/_rels/drawing'+idx+'.xml.rels').toString();
    assert.equal((sheet.match(/<mergeCell ref=/g)||[]).length,48*pages,'all 48 original merged areas per page');
    assert.match(sheet,/<pageSetup paperSize="9"[^>]*orientation="portrait"/,'original A4 portrait settings');
    assert.match(sheet,/<drawing r:id="rId2"\/>/,'each sheet has its own drawing');
    assert.equal((drawing.match(/<xdr:oneCellAnchor>/g)||[]).length,n,'all photos embedded, no omissions');
    assert.equal((rels.match(/\/image"/g)||[]).length,n,'image relationships match');
    for(let i=1;i<=n;i++)assert.ok(out.has('xl/media/visual3-'+idx+'-'+i+'.jpeg'));
  }
  const templateSheet=out.get('xl/worksheets/sheet3.xml').toString();
  const templateDrawing=out.get('xl/drawings/drawing3.xml').toString();
  const templateRels=out.get('xl/drawings/_rels/drawing3.xml.rels').toString();
  assert.equal(Visual.NUMBERED_TEMPLATE_COUNT,400);
  assert.equal((templateSheet.match(/<mergeCell ref=/g)||[]).length,48*134,'original merged photo layout preserved across all 134 pages');
  assert.match(templateSheet,/<pageSetup paperSize="9"[^>]*orientation="portrait"/,'A4 portrait retained for blank sheet');
  assert.match(templateSheet,/<rowBreaks count="133" manualBreakCount="133">/,'separate 134 numbered pages');
  const allNumbers=[...templateSheet.matchAll(/<c r="AB\d+"[^>]*t="inlineStr"><is><t xml:space="preserve">(\d+)<\/t><\/is><\/c>/g)].map(m=>Number(m[1]));
  assert.deepEqual(allNumbers,Array.from({length:400},(_,i)=>i+1),'exactly 1..400, each once and in order');
  // Every editable value other than the photo number is blank. Structural field labels remain.
  const allBlankCells=[...templateSheet.matchAll(/<c r="(?:AD|B)\d+"[^>]*t="inlineStr"><is><t xml:space="preserve">([^<]*)<\/t><\/is><\/c>/g)];
  assert.equal(allBlankCells.length,400*6+2*6,'all 3 empty slots on final page are also cleared');
  assert.ok(allBlankCells.every(m=>m[1]===''),'no copied project name, facility name, photo content or notes');
  assert.equal((templateDrawing.match(/<xdr:oneCellAnchor>/g)||[]).length,0,'no photos or placeholders embedded');
  assert.equal((templateRels.match(/\/image"/g)||[]).length,0,'no image relationships on blank tab');
  assert.ok(![...out.keys()].some(name=>name.startsWith('xl/media/visual3-3-')),'no image media duplicated for blank tab');
  const sheet1=out.get('xl/worksheets/sheet1.xml').toString();
  assert.match(sheet1,/r="AB2"[^>]*t="inlineStr"[^>]*><is><t xml:space="preserve">1<\/t>/,'photo serial number');
  for(const value of ['整理A','魚道工','鉄筋コンクリート','上流から撮影']){
    assert.ok(sheet1.includes(value),'correct visual3 metadata '+value);
  }
  assert.match(sheet1,/r="AB36"[^>]*><is><t xml:space="preserve">4<\/t>/,'numbers increment across page break');
  assert.deepEqual(groups.map(g=>g.photos.map(p=>({damage:p.damage,description:p.description,visual3:p.visual3}))),snapshot,'source entries unchanged');
  await assert.rejects(()=>Visual.buildXlsx('x','y',[{name:'a',photos:[{jpeg:null}]}],new Uint8Array(template)),/未取得/);
  console.log('PASS visual 3-up ledger: two photo sheets plus one untouched-format numbered 1-400 blank sheet, with all other fields empty');
})().catch(e=>{console.error(e);process.exitCode=1;});
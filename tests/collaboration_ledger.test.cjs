'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const Ledger=require('../sentlog/photo-ledger.js');
const Visual=require('../sentlog/photo-ledger-visual3.js');
const Damage=require('../sentlog/photo-ledger-damage.js');
const Tensile=require('../sentlog/photo-ledger-tensile.js');
const root=path.resolve(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));
const image=new Uint8Array([255,216,255,217]);
const group={id:'g',name:'図面1',sheets:[{id:'drawing',sheetName:'第1図'}]};
const source={drawing:{shapes:[{id:'record',recordKind:'field-record',recordType:'survey',
  type:'調査',typeNo:1,memo:'提出する本文',member:'床版',photos:[{id:'photo',name:'現場写真.jpg'}],
  commentEntries:[{id:'entry-private',text:'HISTORY_NOT_FOR_REPORT',author:'AUTHOR_NOT_FOR_REPORT@example.invalid'}],
  fieldHistory:[{before:'OLD_VALUE_NOT_FOR_REPORT',deviceId:'DEVICE_NOT_FOR_REPORT'}]}]}};
const original=JSON.stringify(source);
function entry(text='提出する本文'){
  const state=copy(source);state.drawing.shapes[0].memo=text;
  return Ledger.collect(group,state).entries[0];
}
function reopen(previous,newSource){return Ledger.applyEntryDraft(entry(newSource),Ledger.draftEntry(previous));}
function unzipStored(buffer){
  const data=Buffer.from(buffer),parts=new Map();let pos=0;
  while(pos+30<=data.length&&data.readUInt32LE(pos)===0x04034b50){
    const size=data.readUInt32LE(pos+18),nameLength=data.readUInt16LE(pos+26),extra=data.readUInt16LE(pos+28);
    const name=data.subarray(pos+30,pos+30+nameLength).toString();const start=pos+30+nameLength+extra;
    parts.set(name,data.subarray(start,start+size));pos=start+size;
  }
  return parts;
}
function assetTemplate(prefix,count,compressed=false){
  const text=Array.from({length:count},(_,i)=>fs.readFileSync(path.join(root,'scripts/assets',prefix+'-'+(i+1)+'.b64'),'ascii').trim()).join('');
  const bytes=Buffer.from(text,'base64');return compressed?zlib.gunzipSync(bytes):bytes;
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}

(async()=>{
  await test('new unedited drafts refresh their description when the submitted source changes',()=>{
    const before=entry('以前の本文');const saved=Ledger.draftEntry(before),savedCopy=structuredClone(saved);
    const fresh=Ledger.applyEntryDraft(entry('新しい本文'),saved);
    assert.equal(fresh.description,'新しい本文');assert.equal(fresh.descriptionOrigin.needsReview,false);
    assert.deepEqual(Ledger.pendingComments([fresh],'standard'),[]);
    assert.deepEqual(saved,savedCopy,'loading cannot rewrite the saved draft');
    assert.equal(reopen(fresh,'').description,'','an explicit source deletion also refreshes an automatic caption');
  });
  await test('explicit ledger edits survive source changes until the chosen wording is acknowledged',()=>{
    const edited=entry('以前の本文');Ledger.writeComment(edited,'description','提出用に編集した備考');
    let fresh=reopen(edited,'新しい本文');assert.equal(fresh.description,'提出用に編集した備考');
    assert.equal(fresh.sourceDescription,'新しい本文');assert.equal(fresh.descriptionOrigin.needsReview,true);
    assert.equal(Ledger.pendingComments([fresh],'standard').length,1);
    const unresolved=reopen(fresh,'新しい本文');assert.equal(unresolved.descriptionOrigin.needsReview,true,'saving cannot acknowledge an unresolved source change');
    Ledger.chooseComment(fresh,'description','draft');
    fresh=reopen(fresh,'新しい本文');assert.equal(fresh.description,'提出用に編集した備考');
    assert.equal(fresh.descriptionOrigin.needsReview,false,'unchanged source does not repeatedly ask for the same choice');
    fresh=reopen(fresh,'もう一度更新した本文');assert.equal(fresh.descriptionOrigin.needsReview,true);
    Ledger.chooseComment(fresh,'description','source');
    assert.equal(fresh.description,'もう一度更新した本文');assert.equal(fresh.descriptionOrigin.edited,false);
    assert.equal(reopen(fresh,'次の本文').description,'次の本文','choosing source returns the caption to automatic following');
  });
  await test('intentional blank ledger edits and legacy drafts are preserved conservatively',()=>{
    const blank=entry('元本文');Ledger.writeComment(blank,'description','');
    const fresh=reopen(blank,'更新本文');assert.equal(fresh.description,'');assert.equal(fresh.descriptionOrigin.needsReview,true);
    Ledger.chooseComment(fresh,'description','draft');assert.equal(reopen(fresh,'更新本文').description,'');
    for(const value of ['旧版の台帳専用文','']){
      const legacy={key:entry().key,included:true,description:value};const snapshot=copy(legacy);
      const loaded=Ledger.applyEntryDraft(entry(),legacy);
      assert.equal(loaded.description,value);assert.equal(loaded.descriptionOrigin.source,null);
      assert.equal(loaded.descriptionOrigin.needsReview,true);assert.deepEqual(legacy,snapshot);
      assert.equal(reopen(loaded,'提出する本文').descriptionOrigin.needsReview,true);
    }
    const same=Ledger.applyEntryDraft(entry(),{description:'提出する本文'});
    assert.equal(same.descriptionOrigin.needsReview,false,'a legacy draft already matching the source needs no confirmation');
  });
  await test('visual-three-up notes keep independent edits and choices from the standard description',()=>{
    const before=entry('以前の本文');Ledger.writeComment(before,'visual3Notes','目視用に整理した備考');
    let fresh=reopen(before,'新しい本文');
    assert.equal(fresh.description,'新しい本文');assert.equal(fresh.visual3.notes,'目視用に整理した備考');
    assert.equal(Ledger.pendingComments([fresh],'standard').length,0);
    assert.equal(Ledger.pendingComments([fresh],'visual3').length,1);
    Ledger.chooseComment(fresh,'visual3Notes','draft');fresh=reopen(fresh,'新しい本文');
    assert.equal(Ledger.pendingComments([fresh],'visual3').length,0);
    fresh=reopen(fresh,'さらに新しい本文');Ledger.chooseComment(fresh,'visual3Notes','source');
    assert.equal(fresh.visual3.notes,'さらに新しい本文');
    assert.equal(reopen(fresh,'最後の本文').visual3.notes,'最後の本文');
    const legacy=Ledger.applyEntryDraft(entry(),{description:'提出する本文',visual3:{notes:'旧版の目視備考',facility:'手入力の施設'}});
    assert.equal(legacy.visual3.notes,'旧版の目視備考');assert.equal(legacy.visual3.facility,'手入力の施設');
    assert.equal(Ledger.pendingComments([legacy],'visual3').length,1);
  });
  await test('only descriptions actually printed by the chosen format require a choice',()=>{
    const first=entry(),second=Ledger.applyEntryDraft({...entry(),key:'second',photoId:'second'},{description:'旧下書き'});
    assert.equal(Ledger.pendingComments([first,second],'standard').length,1);
    assert.equal(Ledger.pendingComments([first,second],'damage').length,0,'damage prints the first included photo description once per record');
    assert.equal(Ledger.pendingComments([{...first,included:false},second],'damage').length,1);
    assert.equal(Ledger.pendingComments([second],'tensile').length,0,'tensile uses its own independent details');
    assert.equal(Ledger.pendingComments([{...second,included:false}],'visual3').length,0);
  });
  await test('export-time source refresh reads the latest records without writing source data',()=>{
    const code=fs.readFileSync(path.join(root,'sentlog/photo-ledger.js'),'utf8');
    const start=code.indexOf('  function refreshSourceComments(){'),end=code.indexOf('  function renderEntries(){',start);
    assert(start>=0&&end>start);
    const automatic=entry('古い本文'),edited=entry('古い本文');edited.key='edited';Ledger.writeComment(edited,'description','台帳用の文');
    const current={entries:[automatic,edited],changed:false};let renders=0,reads=0;
    const state=copy(source);state.drawing.shapes[0].memo='出力直前の本文';const raw=JSON.stringify(state.drawing);
    const refresh=vm.runInNewContext(code.slice(start,end)+';refreshSourceComments',{
      current,Map,JSON,String,Error,DATA_PREFIX:'surveyFieldNoteDrawingV1:',
      S:{getItem(key){assert.equal(key,'surveyFieldNoteDrawingV1:drawing');reads++;return raw;},setItem(){throw Error('source write forbidden');}},
      applyEntryDraft:Ledger.applyEntryDraft,draftEntry:Ledger.draftEntry,renderEntries(){renders++;}
    });
    refresh();assert.equal(reads,1);assert.equal(renders,1);
    assert.equal(automatic.description,'出力直前の本文');assert.equal(edited.description,'台帳用の文');
    assert.equal(edited.descriptionOrigin.needsReview,true);assert.equal(raw,JSON.stringify(state.drawing));
  });
  await test('visual-three-up retains complete long text and reports the exact item and field before export',async()=>{
    const long='説明'.repeat(160)+' 完全な末尾';const photo={...entry(long),jpeg:image};
    assert.equal(Visual.defaults(photo,'図面1').notes,long);
    assert.equal(Visual.details(photo,'図面1').notes,long);
    let error;
    try{Visual.validateEntries([photo],'図面1');}catch(e){error=e;}
    assert.equal(error?.code,'LEDGER_TEXT_TOO_LONG');assert.equal(error.ledgerEntryKey,photo.key);assert.equal(error.ledgerField,'notes');
    assert.match(error.message,/調査-1.*現場写真.jpg.*備考.*300文字以内.*記載内容を編集/);
    await assert.rejects(Visual.buildXlsx('案件','図面1',[{name:'調査',photos:[photo]}]),{code:'LEDGER_TEXT_TOO_LONG'});
    assert.equal(photo.description,long,'failed export cannot replace the original long value');
    for(const field of ['managementNo','facility','structure','purpose','notes']){
      assert.throws(()=>Visual.validateEntries([{...entry(),visual3:{[field]:'あ'.repeat(301)}}],'図面1'),e=>e.ledgerField===field);
    }
    assert.equal(Visual.validateEntries([{...entry(),visual3:{notes:'📷'.repeat(300)}}],'図面1'),true,'Unicode characters are not split or counted as two letters');
    Ledger.writeComment(photo,'visual3Notes','台帳用に整理した短い備考');
    assert.equal(Visual.validateEntries([photo],'図面1'),true);assert.equal(photo.sourceDescription,long);
  });
  await test('all four report formats exclude history and author metadata while retaining their templates',async()=>{
    const collected=Ledger.collect(group,source).entries;const photo={...collected[0],jpeg:image};
    const groups=[{name:'調査',photos:[photo]}];
    const visualTemplate=assetTemplate('visual3-template',7);
    const damageTemplate=assetTemplate('damage-ledger-template',5,true);
    const tensileTemplate=Buffer.from(fs.readFileSync(path.join(root,'sentlog/tensile-ledger-template.b64'),'ascii').replace(/\s+/g,''),'base64');
    const files=[
      ['standard',await Ledger.buildXlsx('案件','図面1',groups)],
      ['damage',await Damage.buildXlsx('案件','図面1',groups,new Uint8Array(damageTemplate))],
      ['visual3',await Visual.buildXlsx('案件','図面1',groups,new Uint8Array(visualTemplate))],
      ['tensile',await Tensile.buildXlsx('案件','図面1',[photo],{},new Uint8Array(tensileTemplate))]
    ];
    for(const [format,file] of files){
      const parts=unzipStored(await file.arrayBuffer());
      const xml=[...parts].filter(([name])=>name.endsWith('.xml')).map(([,bytes])=>bytes.toString()).join('\n');
      for(const secret of ['HISTORY_NOT_FOR_REPORT','AUTHOR_NOT_FOR_REPORT','OLD_VALUE_NOT_FOR_REPORT','DEVICE_NOT_FOR_REPORT'])assert(!xml.includes(secret),format+' must not export '+secret);
      if(format!=='tensile')assert(xml.includes('提出する本文'),format+' uses only the canonical submitted comment');
      else assert(!xml.includes('提出する本文'),'tensile remains independent of record comments');
      if(format==='visual3'){
        const blanks=parts.get('xl/worksheets/sheet2.xml').toString();
        const numbers=[...blanks.matchAll(/<c r="AB\d+"[^>]*t="inlineStr"><is><t xml:space="preserve">(\d+)<\/t><\/is><\/c>/g)].map(m=>Number(m[1]));
        assert.deepEqual(numbers,Array.from({length:400},(_,i)=>i+1));
        assert(!blanks.includes('提出する本文'),'number-only template stays blank');
        const originalParts=await Damage.unzip(visualTemplate);
        assert.deepEqual(parts.get('xl/styles.xml'),Buffer.from(originalParts.get('xl/styles.xml')));
      }
    }
    assert.equal(JSON.stringify(source),original,'draft edits and all reports leave source records, photos and metadata byte-equivalent');
  });
  console.log(`${passed} collaboration ledger scenarios passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// One corpus, the real JS validator and the real SQL validator. --sql emits
// local-CI-only SQL; --pglite runs it against a disposable in-process database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const context={projectId:'11111111-1111-4111-8111-111111111111',deviceId:'aaaaaaaa-0000-4000-8000-000000000001',drawingId:'drawing-1',eventId:'contract-event'};
const base=C.upgrade({id:'survey-1',recordKind:'field-record',kind:'field-record',recordType:'survey',type:'調査',member:'横桁',page:1,
  point:{x:1,y:2},memo:"日本語・📷・quote '・改行\n所見",photos:[{id:'photo-1',name:'写真.jpg',size:50,sha256:'a'.repeat(64)}],crackWidthMm:0.2});
let counter=0;
const opts=()=>({actor:{deviceId:context.deviceId,deviceName:'検証端末'},at:0,idFactory:()=>`contract:${++counter}`});
const comment=C.view(base).comments[0],photo=C.view(base).photos[0],head=k=>C.view(base).fields[k].headIds;
const cases=[];
function valid(label,before,after){cases.push({label,event:D.diffRecord(before,after,{...context,eventId:'contract:'+label}),ok:true});}
valid('create',null,base);
valid('append-comment',base,C.appendComment(base,'追加所見 🌧️',opts()));
valid('edit-comment',base,C.editComment(base,comment.id,'修正した所見',{...opts(),expectedHeads:comment.headIds}));
valid('delete-comment',base,C.removeComment(base,comment.id,{...opts(),expectedHeads:comment.headIds}));
valid('field-number',base,C.setField(base,'crackWidthMm',0.3,{...opts(),expectedHeads:head('crackWidthMm')}));
valid('field-null',base,C.setField(base,'member',null,{...opts(),expectedHeads:head('member')}));
valid('field-unset',base,C.setField(base,'member',undefined,{...opts(),unset:true,expectedHeads:head('member')}));
const geometry=copy(C.view(base).fields.geometry.value);geometry.point.x=30;
valid('geometry',base,C.setField(base,'geometry',geometry,{...opts(),expectedHeads:head('geometry')}));
valid('photo-add',base,C.addPhoto(base,{id:'photo-2',name:'追加.png',size:75,sha256:'b'.repeat(64)},opts()));
const removed=C.removePhoto(base,photo.id,{...opts(),expectedHeads:photo.headIds});
valid('photo-delete',base,removed);
valid('photo-restore',removed,C.restorePhoto(removed,photo.id,{...opts(),expectedHeads:C.view(removed).photos[0].headIds}));
const deleted=C.markDeleted(base,{...opts(),expectedToken:C.revisionToken(base)});
valid('record-delete',base,deleted);
valid('record-restore',deleted,C.restore(deleted,{...opts(),expectedToken:C.revisionToken(deleted)}));
valid('special-key',base,C.appendComment(base,'特殊IDでも消えない',{...opts(),commentId:'__proto__'}));
const create=cases[0].event;
function invalid(label,mutate){const event=copy(create);mutate(event);cases.push({label,event,ok:false});}
invalid('missing-kind',e=>delete e.kind);invalid('null-kind',e=>e.kind=null);
invalid('string-schema',e=>e.schema='1');invalid('foreign-record',e=>e.record.id='other');
invalid('missing-projected-photo-id',e=>e.record.photos=[{}]);
invalid('null-projected-photo',e=>e.record.photos=[null]);
invalid('string-projected-photo',e=>e.record.photos=['photo']);
invalid('projection-file-bytes',e=>e.record.photos[0].data='raw');
invalid('projection-uppercase-data-url',e=>e.record.photos[0].url='DATA:image/jpeg;base64,AAAA');
invalid('history-uppercase-data-url',e=>e.record.collab.photos['photo-1'].revisions[0].value.url='DATA:image/jpeg;base64,AAAA');
invalid('bad-photo-size',e=>e.record.collab.photos['photo-1'].revisions[0].value.size=-1);
invalid('bad-photo-hash',e=>e.record.collab.photos['photo-1'].revisions[0].value.sha256='not-a-hash');
invalid('bad-comment-order',e=>e.record.collab.comments[comment.id].order=-1);
invalid('missing-field-value',e=>delete e.record.collab.fields.member.revisions[0].value);
invalid('bad-actor',e=>e.record.collab.fields.member.revisions[0].actor=null);
invalid('negative-clock',e=>e.record.collab.fields.member.revisions[0].at=-1);
invalid('string-parents',e=>e.record.collab.fields.member.revisions[0].parents='x');
invalid('missing-deletion',e=>delete e.record.collab.deletion);
const quoted=x=>"'"+x.replace(/'/g,"''")+"'";
const statements=[];
for(const item of cases){
  let accepted=true;try{D.validateEvent(item.event);}catch{accepted=false;}
  assert.equal(accepted,item.ok,`JS contract: ${item.label}`);
  const call=`PERFORM sentlog_delta_private.validate_payload(${quoted(JSON.stringify(item.event))}::jsonb);`;
  statements.push(item.ok?`DO $test$ BEGIN ${call} END $test$;`:
    `DO $test$ BEGIN BEGIN ${call} RAISE EXCEPTION ${quoted('SQL accepted invalid JS payload: '+item.label)}; EXCEPTION WHEN invalid_parameter_value THEN NULL; END; END $test$;`);
}
const summary=`PASS JS/PostgreSQL payload parity: ${cases.filter(x=>x.ok).length} actual generated events and ${cases.filter(x=>!x.ok).length} invalid boundaries`;
const sql=statements.join('\n')+`\nSELECT ${quoted(summary)} AS result;\n`;
if(process.argv.includes('--sql'))process.stdout.write(sql);
else if(process.argv.includes('--pglite'))(async()=>{
  const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
  try{
    for(const f of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql'])
      await db.exec(fs.readFileSync(path.resolve(__dirname,'..',f),'utf8').replace(/^\\set[^\n]*$/mg,''));
    await db.exec(sql);console.log(summary);
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
else throw Error('Use --sql or --pglite; no remote database mode is provided');

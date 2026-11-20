'use strict';
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
const clone=value=>JSON.parse(JSON.stringify(value));
const actor={deviceId:'projection-device',deviceName:'Projection test'};
const opts=(id,extra={})=>({actor,at:123,revisionId:id,...extra});
const field=(r,key,value,id,extra={})=>C.setField(r,key,value,opts(id,{expectedHeads:C.view(r).fields[key]?.headIds||[],...extra}));
const merge=(a,b)=>{const m=C.mergeRecords(a,b);assert.equal(m.ok,true,m.reason);return m.record;};
const cases=[];const add=(label,record)=>{cases.push({label,record});return record;};
const base=add('baseline fields, geometry, unknown nested metadata',C.upgrade({id:'record',memo:'first',photos:[{id:'photo',name:'p',size:3}],kind:'polygon',points:[{x:1,y:2}],member:'pier',custom:{nested:[1,2]}}));
add('disjoint fields',merge(field(base,'member','girder','field-a'),field(base,'custom',{nested:[3]},'field-b')));
add('different concurrent fields retain common value',merge(field(base,'member','left','field-c'),field(base,'member','right','field-d')));
add('same concurrent field values',merge(field(base,'member','same','field-e'),field(base,'member','same','field-f')));
add('unset versus concurrent value',merge(field(base,'member',null,'field-g',{unset:true}),field(base,'member','kept','field-h')));
const c0=Object.keys(base.collab.comments)[0],commentHeads=C.view(base).comments.find(x=>x.id===c0).headIds;
add('concurrent comment alternatives',merge(C.editComment(base,c0,'left',opts('comment-a',{expectedHeads:commentHeads})),C.editComment(base,c0,'right',opts('comment-b',{expectedHeads:commentHeads}))));
add('same concurrent comments are displayed once',merge(C.editComment(base,c0,'same',opts('comment-c',{expectedHeads:commentHeads})),C.editComment(base,c0,'same',opts('comment-d',{expectedHeads:commentHeads}))));
add('comment removal plus concurrent edit',merge(C.removeComment(base,c0,opts('comment-e',{expectedHeads:commentHeads})),C.editComment(base,c0,'retained',opts('comment-f',{expectedHeads:commentHeads}))));
const deletion=C.markDeleted(base,opts('delete-a',{expectedToken:C.revisionToken(base)}));
add('record deletion',deletion);
add('record deletion versus unobserved field',merge(deletion,field(base,'member','concurrent','field-i')));
add('record restore',C.restore(deletion,opts('restore-a',{expectedToken:C.revisionToken(deletion)})));
const photoHeads=C.view(base).photos[0].headIds;
const removedPhoto=C.removePhoto(base,'photo',opts('photo-delete',{expectedHeads:photoHeads}));
add('photo removal',removedPhoto);
add('photo restore',C.restorePhoto(removedPhoto,'photo',opts('photo-restore',{expectedHeads:C.view(removedPhoto).photos[0].headIds})));
const changedPhoto=C.addPhoto(base,{id:'photo',name:'changed',size:3},opts('photo-change'));
add('photo deletion with concurrent metadata',merge(removedPhoto,changedPhoto));
add('ambiguous photo metadata preserves conflict placeholder',merge(changedPhoto,C.addPhoto(base,{id:'photo',name:'different',size:3},opts('photo-change-two'))));
let unicode=C.upgrade({id:'記録🧪',memo:'',photos:[]});
for(const id of ['é','e','𐀀','\ue000','日本','日本a'])unicode=C.appendComment(unicode,id,opts('unicode:'+id,{commentId:id}));
for(const id of ['𐀀','\ue000','é','e'])unicode=C.addPhoto(unicode,{id,name:id},opts('photo:'+id));
add('Unicode comments, photos and revision order',unicode);
const graph=clone(base),entry=graph.collab.fields.member,root=entry.revisions[0];
const revision=(id,parents,value)=>({id,parents,value,actor,at:1});
entry.revisions=[root,revision('branch-a',[root.id],'A'),revision('branch-b',[root.id],'B'),
  revision('merge-a',['branch-a','branch-b'],'left'),revision('merge-b',['branch-b','branch-a'],'right')];
add('criss-cross divergent maximal ancestors leave field unset',C.upgrade(graph));
const agreeing=clone(graph);agreeing.collab.fields.member.revisions[1].value='same';agreeing.collab.fields.member.revisions[2].value='same';
add('criss-cross agreeing maximal ancestors select common value',C.upgrade(agreeing));
const forged=clone(base);forged.memo='fake display';forged.member='fake member';forged.photos=[];forged.collab.projection={memo:'fake collab display'};
add('untrusted raw display fields and projection cache are ignored',forged);

(async()=>{const db=new PGlite();try{
  for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql','docs/sentlog-delta-semantic-validation-prototype.sql','docs/sentlog-delta-projection-prototype.sql'])await db.exec(read(file));
  for(const {label,record} of cases){
    const expected=C.upgrade(record),view=C.view(expected);
    for(const key of ['globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'])delete expected[key];
    const result=(await db.query('SELECT sentlog_delta_private.project_record($1,$2::jsonb) AS result',[record.id,JSON.stringify(record.collab)])).rows[0].result;
    assert.deepEqual(result,{record:expected,deleted:view.deleted,pendingDelete:view.pendingDelete},label);
    console.log('PASS '+label);
  }
  await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT sentlog_delta_private.project_record($1,$2::jsonb)',[base.id,JSON.stringify(base.collab)]),e=>e.code==='42501');
  console.log('PASS projection helpers are not an authenticated RPC surface');
  console.log(`PASS ${cases.length+1} independent SQL/JavaScript projection checks`);
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

const assert=require('node:assert/strict');
const F=require('../sentlog/display-filter-core.js');
const shapes=[
 {id:'a',page:1,type:'ひび割れ',autoLabel:'ひび割れ①'},
 {id:'b',page:2,type:'腐食',autoLabel:'腐食①',photos:['p']},
 {id:'c',page:1,recordKind:'field-record',recordType:'photo',recordNo:3},
 {id:'d',page:2,recordKind:'field-record',recordType:'survey',recordNo:2},
 {id:'e',page:1,recordKind:'dimension-line',kind:'dimension',manualText:'1.200m'},
 {id:'f',page:1,recordKind:'drawing-memo',memoType:'text',text:'工事メモ'},
 {id:'g',page:2,recordKind:'drawing-memo',memoType:'dimension',manualText:'3.2m'}
];
assert.deepEqual(shapes.map(F.category),['ひび割れ','腐食','写真位置','調査位置','寸法線','メモ','寸法線']);
assert.equal(F.label(shapes[0]),'ひび割れ①');
assert.equal(F.label(shapes[2]),'写真位置-3');
assert.equal(F.label(shapes[4]),'1.200m');
assert.equal(F.isAll(shapes,null),true);
const photoOnly={categories:['写真位置'],hiddenIds:[]};
assert.deepEqual(shapes.filter(s=>F.isVisible(s,photoOnly)).map(s=>s.id),['c']);
const damageOnly={categories:['ひび割れ','腐食'],hiddenIds:['b']};
assert.deepEqual(shapes.filter(s=>F.isVisible(s,damageOnly)).map(s=>s.id),['a']);
assert.equal(F.isVisible(shapes[3],{categories:[],hiddenIds:[]}),false);
assert.deepEqual(F.normalise({categories:['写真位置','unrecognised'],hiddenIds:['c','c','missing']},shapes),{categories:['写真位置'],hiddenIds:['c']});
assert.equal(F.isAll(shapes,damageOnly),false);
const original=JSON.stringify(shapes);
for(let i=0;i<20;i++)shapes.filter(s=>F.isVisible(s,photoOnly));
assert.equal(JSON.stringify(shapes),original,'filter must not mutate persisted shapes');
console.log('PASS Sentlog display/PDF filter categories, individual selection and no mutation');

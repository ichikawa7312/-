'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('../sentlog/damage-catalog.js');
const damage=require('../sentlog/damage-styles.js'),labels=require('../sentlog/label-colors.js');
const project={id:'test',damageNamesV1:[{name:'補修材の再剥離A',displayGroup:'loss'}]};
const cases=['ひび割れ','浮き','漏水','腐食','変形','その他','ひびわれ','補修材の再剥離A','分類不明'];
const records=cases.map((type,i)=>({id:'record-'+i,type,autoLabel:'同じ表示名①',photos:[{id:'photo-'+i}],labelPos:{x:i,y:i},strokeWidth:.8}));
const saved=JSON.stringify({project,records});
const luminance=hex=>hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
for(const g of Object.values(damage.groups))assert.ok(1.05/(luminance(g.color)+.05)>=4.5,g.name+' must contrast with white');
function node(id,role,localName,kind){
 return {localName,dataset:{damageLabelId:id,damageLabelRole:role,damageMarkerKind:kind},attrs:{x:'1',y:'2',r:'3',points:'1,2 3,4 5,6',stroke:'#old',fill:'#old','stroke-width':'.6','font-size':'12'},textContent:'同じ表示名①',setAttribute(k,v){this.attrs[k]=String(v)}};
}
for(const z of [.05,.25,.5,1,2,8])for(const mode of ['hatch','color','mono','original']){
 const nodes=records.flatMap(s=>[node(s.id,'name','text'),node(s.id,'leader','line'),node(s.id,'marker','circle','open-circle'),node(s.id,'marker','circle','filled-circle'),node(s.id,'marker','polygon','arrow')]);
 const unused=[node('missing','name','text'),node(records[0].id,'photo','text'),node(records[0].id,'hit','rect'),node(records[0].id,'name','rect')];
 const unpainted=JSON.stringify(unused);nodes.push(...unused);
 const host={querySelectorAll:()=>nodes};
 labels.paintNodes(host,records,project,mode,z);
 for(let i=0;i<records.length;i++){
  const [name,leader,open,filled,arrow]=nodes.slice(i*5,i*5+5);
  const expected=mode==='hatch'||mode==='color'?damage.styleFor(records[i].type,project,mode).color:'#111827';
  assert.equal(name.attrs.fill,expected);assert.equal(name.attrs.stroke,'#FFFFFF');
  assert.equal(name.attrs['paint-order'],'stroke fill');assert.ok(Math.abs(Number(name.attrs['stroke-width'])*z-2.2)<1e-8);
  assert.equal(name.attrs['font-size'],'12');assert.equal(name.attrs.x,'1');assert.equal(name.attrs.y,'2');assert.equal(name.textContent,'同じ表示名①');
  assert.equal(leader.attrs.stroke,expected);assert.equal(leader.attrs['stroke-width'],'.6');
  assert.equal(open.attrs.stroke,expected);assert.equal(open.attrs.fill,'#FFFFFF');
  assert.equal(filled.attrs.fill,expected);assert.equal(filled.attrs.stroke,'#FFFFFF');
  assert.equal(arrow.attrs.stroke,expected);assert.equal(arrow.attrs.fill,expected);
  for(const tip of [open,filled,arrow]){assert.equal(tip.attrs.r,'3');assert.equal(tip.attrs.points,'1,2 3,4 5,6');assert.equal(tip.attrs['stroke-width'],'.6')}
 }
 const once=JSON.stringify(nodes);labels.paintNodes(host,records,project,mode,z);assert.equal(JSON.stringify(nodes),once,'No duplicate DOM or drift');
 assert.equal(JSON.stringify(unused),unpainted,'Leave unknown IDs, badges, hit targets and other text untouched');
}
assert.equal(JSON.stringify({project,records}),saved,'No shared data, photos or coordinates modified');
assert.equal(labels.labelStyle('補修材の再剥離A',{},'color',1).color,damage.groups.other.color);
assert.ok(Number.isFinite(labels.labelStyle('ひび割れ',{},'color',NaN).halo));
const src=fs.readFileSync('sentlog/label-colors.js','utf8');new vm.Script(src);
assert.ok(!/\b(?:fetch|persist|saveWorkspace|addShape|assignNumbers|rebuildNumberingState|setItem)\s*\(/.test(src));
assert.ok(!/textContent\s*=|innerHTML\s*=|state\.[a-zA-Z]+\s*=/.test(src));
const loader=fs.readFileSync('sentlog/index.html','utf8'),sw=fs.readFileSync('sentlog/sw.js','utf8'),render=fs.readFileSync('sentlog/part09.txt','utf8');
assert.ok(loader.includes("[8,'damageLabelRole']"));assert.ok(loader.includes('label-colors.js?v=154'));assert.ok(loader.includes("'v1.54'"));
assert.ok(sw.includes("'label-colors.js'"));assert.ok(sw.includes('sentlog-pwa-v165'));
assert.ok(render.includes("t.dataset.damageLabelId=s.id"));assert.ok(render.includes("leader.dataset.damageLabelId=s.id"));assert.ok(render.includes("markerEl.dataset.damageLabelId=s.id"));
console.log('PASS v1.54: six contrast-checked label colors, ID associations, all marker styles, constant halo at 6 zooms, black modes, immutable records and untouched photo/dimension/hit nodes');

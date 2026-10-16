/* Sentlog v1.53: six display families, not inspection grades or causes.
 * Styles are derived at render time; annotations/IDs/geometry never migrate.
 * The only shared write is an explicitly chosen custom-name displayGroup.
 */
(function(root){
 'use strict';
 const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 const groups=Object.freeze({
  crack:{name:'ひび割れ・亀裂系',color:'#C62828',pattern:'vertical',dash:[]},
  loss:{name:'浮き・剥離・欠損系',color:'#B45309',pattern:'fall',dash:[6,4]},
  water:{name:'漏水・析出物系',color:'#0369A1',pattern:'dots',dash:[1,3]},
  corrosion:{name:'腐食・防食劣化系',color:'#7E22CE',pattern:'cross',dash:[7,3,1,3]},
  movement:{name:'変形・移動系',color:'#15803D',pattern:'horizontal',dash:[12,4]},
  other:{name:'その他・複合・設備系',color:'#4B5563',pattern:'sparse',dash:[3,3]}
 });
 const names={
  crack:['ひび割れ','床版ひび割れ','亀裂','周辺地盤のひび割れ'],
  loss:['浮き','剥離','剥落','剥離・鉄筋露出','鉄筋露出','抜け落ち','欠損','欠損・損傷','破断','折損','止水板の破断','スケーリング','剥離・剥落・スケーリング','ポップアウト','摩耗','風化','摩耗・風化','骨材露出'],
  water:['漏水','漏水箇所','漏水跡','漏水・遊離石灰','漏水・滞水','滞水','遊離石灰','エフロレッセンス','ゲルの滲出','目地からの漏水','床版・エプロン下からの噴水','ゲート底部からの漏水','湧水'],
  corrosion:['腐食','錆汁','防食機能の劣化','塗装損傷・劣化'],
  movement:['変形','変形・歪み','沈下','不同沈下','移動','傾斜','沈下・移動・傾斜','異常なたわみ','目地の開き','目地の段差','遊間の異常','片吊り'],
  other:['ゆるみ・脱落','ボルトのゆるみ','ボルトの脱落','補修・補強材の損傷','コンクリート補強材の損傷','路面の凹凸','舗装の異常','支承部の機能障害','その他','定着部の異常','変色・劣化','変色','異常な音・振動','変形・欠損','土砂詰まり','洗掘','床版・エプロン下の空洞','背面土の空洞化','陥没','護床ブロックの流失','下流河床低下','土砂堆積','流木・塵芥の堆積','ミオ筋の変化','上流側の吸込み','噴砂','ローラ・シーブの作動不良','開閉装置の作動不良','給油不良','異常な過熱','異臭','計器類の作動不良']
 };
 const byName=new Map();
 for(const [key,list] of Object.entries(names))for(const name of list){
  if(byName.has(name))throw Error('Duplicate display mapping: '+name);
  byName.set(name,key);
 }
 const modes=Object.freeze({hatch:'色＋ハッチング',color:'色のみ',mono:'モノクロ＋模様',original:'従来の単色'});
 const validGroup=g=>typeof g==='string'&&own(groups,g);
 function resolve(name,project){
  let canonical=name,key=byName.get(name);
  if(!key){
   const custom=(Array.isArray(project?.damageNamesV1)?project.damageNamesV1:[]).find(e=>e?.name===name);
   if(custom)return {key:validGroup(custom.displayGroup)?custom.displayGroup:'other',pattern:groups[validGroup(custom.displayGroup)?custom.displayGroup:'other'].pattern,custom:true};
   const entry=root.SentlogDamageCatalog?.matchName(root.SentlogDamageCatalog.entries,name);
   canonical=entry?.name||name;key=byName.get(canonical)||'other';
  }
  return {key,pattern:canonical==='浮き'?'rise':groups[key].pattern,custom:false};
 }
 function styleFor(name,project,mode='hatch'){
  const r=resolve(name,project),g=groups[r.key];
  return {...r,color:mode==='mono'?'#333333':g.color,dash:g.dash,hatched:mode==='hatch'||mode==='mono'};
 }
 const zoom=z=>Number.isFinite(z)&&z>0?Math.max(.001,z):1;
 const api={groups,names,modes,resolve,styleFor,validGroup,zoom};
 root.SentlogDamageStyles=api;
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(typeof document==='undefined'||!document.getElementById('damageType'))return;
 const catalog=root.SentlogDamageCatalog;if(!catalog)throw Error('変状名称集が未読込です。');
 const make=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const makeSvg=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
 const KEY='sentlogDamageDisplayV1';
 let mode='hatch';try{const stored=localStorage.getItem(KEY);if(own(modes,stored))mode=stored;}catch{}
 function pattern(defs,id,kind,color,z=1){
  const tile=kind==='sparse'?18:12;
  const p=makeSvg('pattern',{id,patternUnits:'userSpaceOnUse',patternContentUnits:'userSpaceOnUse',width:tile,height:tile,patternTransform:'scale('+(1/zoom(z))+')'});
  p.append(makeSvg('rect',{width:tile,height:tile,fill:color,'fill-opacity':'.025'}));
  const paths={rise:'M-3 3L3 -3M0 12L12 0M9 15L15 9',fall:'M-3 9L3 15M0 0L12 12M9 -3L15 3',cross:'M-3 3L3 -3M0 12L12 0M9 15L15 9M-3 9L3 15M0 0L12 12M9 -3L15 3',horizontal:'M0 6H12',vertical:'M6 0V12',sparse:'M7 9H11M9 7V11'};
  if(kind==='dots')p.append(makeSvg('circle',{cx:6,cy:6,r:1,fill:color,'fill-opacity':'.55'}));
  else p.append(makeSvg('path',{d:paths[kind]||paths.sparse,fill:'none',stroke:color,'stroke-width':'.7','stroke-opacity':'.5'}));
  defs.append(p);return 'url(#'+id+')';
 }
 function outline(s){
  if(Array.isArray(s.points)&&s.points.length)return 'M'+s.points.map(p=>p.x+' '+p.y).join('L')+(['polygon','freehand','freehand-area'].includes(s.kind)?'Z':'');
  if(s.kind==='rect')return 'M'+s.x+' '+s.y+'h'+s.w+'v'+s.h+'h'+(-s.w)+'Z';
  return '';
 }
 function paint(){
  svg.classList.toggle('sl-damage-mono',mode==='mono');
  if(mode==='original')return;
  const z=zoom(scale),project=getProject(),records=new Map(currentShapes().map(s=>[s.id,s]));
  const defs=makeSvg('defs',{'data-damage-patterns':'true'}),fills=new Map(),resolved=new Map();
  // Direct visible geometry only: never recolor hit targets, leaders, badges,
  // scale dimensions, draft preview, or the shape-move handle.
  for(const e of [...svg.children]){
   const s=records.get(e.dataset?.id);
   if(!s||!['polygon','polyline','rect'].includes(e.localName)||e.style.pointerEvents!=='none')continue;
   if(!resolved.has(s.type))resolved.set(s.type,styleFor(s.type,project,mode));
   const st=resolved.get(s.type),area=['polygon','rect','freehand','freehand-area'].includes(s.kind);
   e.dataset.damageGroup=st.key;e.dataset.damagePattern=area&&st.hatched?st.pattern:'none';
   e.setAttribute('stroke',st.color);
   if(!area){
    e.setAttribute('fill','none');
    if(st.dash.length)e.setAttribute('stroke-dasharray',st.dash.map(n=>n/z).join(' '));
   }else if(st.hatched){
    const key=st.key+'-'+st.pattern;
    if(!fills.has(key))fills.set(key,pattern(defs,'sl-damage-'+key,st.pattern,st.color,z));
    e.setAttribute('fill',fills.get(key));
   }else{
    e.setAttribute('fill',st.color);e.setAttribute('fill-opacity','.06');
   }
   if(selected===s.id){
    const d=outline(s);if(!d)continue;
    const halo=makeSvg('path',{d,fill:'none',stroke:mode==='mono'?'#333333':'#2563eb','stroke-width':(Number(s.strokeWidth||1.2)+3)/z,'stroke-opacity':'.55','stroke-dasharray':6/z+' '+4/z,'pointer-events':'none','aria-hidden':'true','data-damage-selection':'true'});
    // This outline is display-only: no shape ID, event handler or stored geometry.
    e.before(halo);
   }
  }
  if(defs.children.length)svg.prepend(defs);
 }
 // Settings belong in the existing drawing sidebar, never another toolbar row.
 const box=make('details');box.id='sentlogDamageStyleSettings';
 const title=make('summary','変状の色・模様');const label=make('label','表示方法');label.htmlFor='damageDisplayMode';
 const select=make('select');select.id='damageDisplayMode';
 for(const [value,text] of Object.entries(modes)){const o=make('option',text);o.value=value;select.append(o);}select.value=mode;
 const note=make('p','色は変状の種類を示します。重症度・健全度や、要領の正式区分を示す色ではありません。');note.className='meta';
 const legend=make('div');legend.id='damageDisplayLegend';
 const message=make('div');message.id='damageStyleStatus';message.setAttribute('role','status');
 box.append(title,label,select,note,legend,message);
 const labelSize=document.getElementById('sentlogLabelSize');if(labelSize)labelSize.after(box);else document.getElementById('sidebar').append(box);
 const css=make('style');css.textContent=`
 #sentlogDamageStyleSettings{margin:8px 0;padding:8px 0;border-top:1px solid var(--line);font-size:12px;line-height:1.5}#sentlogDamageStyleSettings summary{font-weight:700;cursor:pointer;min-height:36px;display:flex;align-items:center}#sentlogDamageStyleSettings label{display:block;margin-top:6px}#damageDisplayMode,#damageNameDisplayGroup,#damageCustomDisplayGroup{min-height:44px;max-width:100%;width:100%;font-size:14px;box-sizing:border-box}#damageDisplayLegend{display:grid;gap:6px}#damageDisplayLegend>div{display:flex;align-items:center;gap:8px}#damageDisplayLegend svg{flex:none}#damageStyleStatus,#damageCustomStyleStatus{font-size:12px;line-height:1.5;overflow-wrap:anywhere}#damageCustomStyleBox{margin-top:8px;border-top:1px solid #d1d5db;padding-top:8px}#damageCustomStyleBox[hidden]{display:none}#damageCustomStyleApply{min-height:44px;width:100%;margin-top:4px}#damageNameGroupRow label{display:block}#damageNameGroupRow small{display:block}#svg.sl-damage-mono{filter:grayscale(1)}
 `;document.head.append(css);
 function legendRow(key,kind,text,index){
  const row=make('div'),s=makeSvg('svg',{width:42,height:24,viewBox:'0 0 42 24','aria-hidden':'true'}),g=groups[key],color=mode==='mono'?'#333333':g.color;
  const defs=makeSvg('defs',{}),fill=(mode==='color')?color:pattern(defs,'sl-legend-'+index,kind,color);
  s.append(defs,makeSvg('rect',{x:2,y:2,width:38,height:20,rx:2,fill,'fill-opacity':mode==='color'?'.08':'1',stroke:color,'stroke-width':1.2}));
  row.append(s,make('span',text));return row;
 }
 function updateLegend(){
  legend.replaceChildren();
  if(mode==='original'){legend.append(make('p','従来どおりの単色で表示します。記録内容は変わりません。'));return;}
  let i=0;for(const [key,g] of Object.entries(groups))legend.append(legendRow(key,g.pattern,g.name,i++));
  if(mode!=='color'){
   legend.append(legendRow('loss','rise','浮き：右上がりの斜線',i++));
   legend.append(legendRow('loss','fall','剥離：左上がりの斜線',i++));
  }
  legend.append(make('p','線は線種、範囲は模様で区別。詳しい種類は名称で確認します。表示設定はこの端末だけに保存します。'));
 }
 select.onchange=()=>{
  if(!own(modes,select.value))return;mode=select.value;message.textContent='';
  try{localStorage.setItem(KEY,mode);}catch{message.textContent='表示は変更しましたが、設定の保存ができません。今回はこの表示で使用できます。';}
  updateLegend();render();
 };
 function groupSelect(id){
  const s=make('select');s.id=id;
  for(const [value,g] of Object.entries(groups)){const o=make('option',g.name+(value==='other'?'（未指定）':''));o.value=value;s.append(o);}
  s.value='other';return s;
 }
 const customInput=groupSelect('damageNameDisplayGroup'),customRow=make('div');customRow.id='damageNameGroupRow';
 const customLabel=make('label','色・模様のグループ（任意）');customLabel.htmlFor=customInput.id;
 customRow.append(customLabel,customInput,make('small','この案件の同じ名称に適用。未指定は灰色です。'));
 document.getElementById('damageNameSave').before(customRow);
 document.getElementById('damageNameSearch').addEventListener('click',()=>{customInput.value='other';});
 api.newNameGroup=()=>validGroup(customInput.value)?customInput.value:'other';
 // Existing user-added names can also be classified once, explicitly.
 const customBox=make('div');customBox.id='damageCustomStyleBox';customBox.hidden=true;
 const editLabel=make('label','この追加名称の色・模様');editLabel.htmlFor='damageCustomDisplayGroup';
 const editGroup=groupSelect('damageCustomDisplayGroup'),save=make('button','この案件の同じ名称に適用');save.type='button';save.id='damageCustomStyleApply';
 const saved=make('div');saved.id='damageCustomStyleStatus';saved.setAttribute('role','status');
 customBox.append(editLabel,editGroup,save,saved);document.querySelector('.damage-name-details').append(customBox);
 let editedName=null,editedProject=null,saving=false;
 function updateCustom(){
  const p=getProject(),name=document.getElementById('damageType').value;
  const custom=!byName.has(name)&&(Array.isArray(p?.damageNamesV1)?p.damageNamesV1:[]).find(e=>e?.name===name);
  customBox.hidden=!custom;
  if(!custom){editedName=null;editedProject=null;return;}
  if(editedName!==name||editedProject!==p.id||document.activeElement!==editGroup){editGroup.value=validGroup(custom.displayGroup)?custom.displayGroup:'other';}
  if(editedName!==name||editedProject!==p.id)saved.textContent='';editedName=name;editedProject=p.id;
 }
 save.onclick=async()=>{
  if(saving)return;
  const p=getProject(),name=editedName,value=editGroup.value;
  if(!p||p.id!==editedProject||!validGroup(value)||!Array.isArray(p.damageNamesV1))return;
  const index=p.damageNamesV1.findIndex(e=>e?.name===name);if(index<0||byName.has(name))return;
  if(p.damageNamesV1[index].displayGroup===value)return;
  saving=true;save.disabled=true;saved.textContent='端末内に保存中…';
  try{
   root.SentlogRecords.assertSafe();
   p.damageNamesV1=p.damageNamesV1.map((e,i)=>i===index?{...e,displayGroup:value}:e);
   p.updatedAt=Math.max(Date.now(),Number(p.updatedAt||0)+1);saveWorkspace();
   await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();
   render();saved.textContent='この案件の「'+name+'」の表示を保存しました。';
  }catch(e){saved.textContent='保存を確認できません。画面を閉じずに確認してください。 '+(e?.message||e);}
  finally{saving=false;save.disabled=false;}
 };
 document.getElementById('damageType').addEventListener('change',updateCustom);
 const oldRender=render;
 render=function(){const result=oldRender.apply(this,arguments);paint();updateCustom();return result;};
 Object.assign(api,{getMode:()=>mode,paint,isEditing:()=>saving});
 updateLegend();updateCustom();if(currentView==='editor')render();
})(typeof window==='object'?window:globalThis);

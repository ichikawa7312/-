/* Sentlog v1.50: material-based names; reference labels, not assessment rules.
   Existing shape.type strings are never migrated. Custom names live in project
   snapshots/backups, not an external dictionary. No network access is required. */
(function(root){
  'use strict';
  const VERSION='2026-10-15.1';
  const MATERIALS={all:'すべて',steel:'鋼材',concrete:'コンクリート',common:'共通',other:'その他・設備'};
  const SOURCES={
    bridge:{title:'国土交通省 橋梁定期点検要領',edition:'平成31年3月',section:'付録2・損傷程度の評価要領（名称の参照）',url:'https://www.mlit.go.jp/road/sisaku/yobohozen/tenken/yobo3_1_6.pdf#page=109'},
    shizuoka:{title:'静岡県 橋梁点検マニュアル',edition:'令和7年度版（令和8年3月）',section:'表2.2.1・本文p.16',url:'https://www.pref.shizuoka.jp/_res/projects/default_project/_page_/001/028/665/mn_bridge1.pdf#page=19'},
    headworks:{title:'農林水産省 農業水利施設の機能保全の手引き「頭首工」',edition:'令和7年6月',section:'表4-10・本文p.52／表4-12〜4-14・p.54〜56',url:'https://www.maff.go.jp/j/nousin/mizu/sutomane/attach/pdf/kinouhozen-205.pdf#page=30'},
    surroundings:{title:'農林水産省 同手引き「頭首工」',edition:'令和7年6月',section:'表4-6・4-7・本文p.36〜37／表4-10・p.52',url:'https://www.maff.go.jp/j/nousin/mizu/sutomane/attach/pdf/kinouhozen-205.pdf#page=14'},
    gate:{title:'農林水産省 同手引き「頭首工」',edition:'令和7年6月',section:'表4-4・本文p.33（ゲート設備の問診項目から名称化）',url:'https://www.maff.go.jp/j/nousin/mizu/sutomane/attach/pdf/kinouhozen-205.pdf#page=11'}
  };
  const entries=[];
  function add(name,group,refs,aliases=[],note='',related=[]){
    entries.push({id:'sl-name-'+String(entries.length+1).padStart(3,'0'),name,group,refs,aliases,note,related});
  }
  const B=(n,item)=>({source:'bridge',item:String(n).padStart(2,'0')+' '+item});
  const H=item=>({source:'headworks',item});
  const S=item=>({source:'surroundings',item});
  const G=item=>({source:'gate',item});
  const split='原典の複合項目・調査内容を現場記録用に細分化した名称。';
  const bridgeNames=[
    ['腐食','steel'],['亀裂','steel'],['ゆるみ・脱落','steel'],['破断','steel'],['防食機能の劣化','steel'],
    ['ひび割れ','concrete','ひびわれ'],['剥離・鉄筋露出','concrete'],['漏水・遊離石灰','concrete'],['抜け落ち','concrete'],
    ['補修・補強材の損傷','common'],['床版ひび割れ','concrete','床版ひびわれ'],['浮き','concrete','うき'],
    ['遊間の異常','other'],['路面の凹凸','other'],['舗装の異常','other'],['支承部の機能障害','other'],['その他','common'],
    ['定着部の異常','common'],['変色・劣化','common'],['漏水・滞水','common'],['異常な音・振動','common'],
    ['異常なたわみ','common'],['変形・欠損','common'],['土砂詰まり','common'],['沈下・移動・傾斜','common'],['洗掘','common']
  ];
  bridgeNames.forEach(([name,group,official],i)=>{
    const refs=[B(i+1,official||name)];
    // Shizuoka item 10 has a different name/scope: do NOT assert equivalence.
    if(i!==9)refs.push({source:'shizuoka',item:String(i+1).padStart(2,'0')+' '+(i===15?'支承の機能障害':i===25?'洗堀':official||name)});
    add(name,group,refs,official?[official]:[],official?'表示表記のみ統一。原典表記は出典欄に保持。':'',group==='common'?['steel','concrete']:[]);
  });
  const named=n=>entries.find(e=>e.name===n);
  named('ひび割れ').refs.push(H('ひび割れ'));
  named('浮き').refs.push(H('浮き'));
  named('腐食').refs.push(G('発錆'));
  named('腐食').aliases.push('発錆','さび','錆');
  named('洗掘').refs.push(S('洗掘（表4-10の表記は洗堀）'));
  named('洗掘').aliases.push('洗堀');
  named('支承部の機能障害').aliases.push('支承の機能障害');
  add('剥離','concrete',[B(7,'剥離・鉄筋露出'),H('剥離・剥落・スケーリング')],[],split);
  add('剥落','concrete',[H('剥離・剥落・スケーリング')],[],split);
  add('鉄筋露出','concrete',[B(7,'剥離・鉄筋露出'),H('鉄筋露出')],[],split);
  add('スケーリング','concrete',[H('剥離・剥落・スケーリング')],[],split);
  add('剥離・剥落・スケーリング','concrete',[H('剥離・剥落・スケーリング')]);
  add('ポップアウト','concrete',[H('ポップアウト')]);
  add('遊離石灰','concrete',[B(8,'漏水・遊離石灰')],['白華'],split+' 析出物の種類は必要に応じ確認。');
  add('エフロレッセンス','concrete',[H('（析出物）エフロレッセンス')],['析出物'],'原典名を保持。析出物の性状・確認方法をメモに残す。');
  add('ゲルの滲出','concrete',[H('（析出物）ゲルの滲出')],['ゲルの浸出'],'外観だけでASRなどの原因を断定しない。');
  add('錆汁','concrete',[H('錆汁')],['さび汁','錆び汁']);
  add('摩耗・風化','concrete',[H('摩耗・風化')]);
  add('摩耗','common',[H('摩耗・風化'),G('摩耗')],['すりへり'],split,['steel','concrete']);
  add('風化','concrete',[H('摩耗・風化')],[],split);
  add('骨材露出','concrete',[S('摩耗・骨材の露出等')],['骨材の露出'],split);
  add('変形・歪み','common',[H('変形・歪み')],['ひずみ'], '',['steel','concrete']);
  add('変形','common',[B(23,'変形・欠損'),H('変形・歪み')],[],split,['steel','concrete']);
  add('欠損','common',[B(23,'変形・欠損'),H('欠損・損傷')],[],split,['steel','concrete']);
  add('欠損・損傷','concrete',[H('戸当たり周辺、巻き上げ機周辺の欠損・損傷')]);
  add('変色','common',[B(19,'変色・劣化'),H('変色')],[],split,['steel','concrete']);
  add('コンクリート補強材の損傷','concrete',[{source:'shizuoka',item:'10 コンクリート補強材の損傷'}],[], '国交省の「補修・補強材の損傷」と同一項目として自動集約しない。');
  add('漏水','common',[B(8,'漏水・遊離石灰'),B(20,'漏水・滞水'),H('漏水状況')],[],split+' 対応する区分は対象部位により異なる。',['steel','concrete']);
  add('漏水跡','common',[H('目地の変状に伴う漏水状況／表4-14 漏水跡')],[], '現在の漏水とは区別して記録。',['steel','concrete']);
  add('滞水','common',[B(20,'漏水・滞水')],[],split,['steel','concrete']);
  add('目地の開き','concrete',[H('目地の開き')]);
  add('目地の段差','concrete',[H('目地の変状・段差')],[],split);
  add('目地からの漏水','concrete',[H('目地の変状に伴う漏水状況')],[],split);
  add('止水板の破断','concrete',[H('止水板の破断')]);
  add('床版・エプロン下の空洞','concrete',[H('床版・エプロン下の空洞')],['床版下の空洞'],'確認方法と範囲をメモに残す。推定だけの場合はその旨を明記。');
  add('床版・エプロン下からの噴水','concrete',[H('床版・エプロン下からの噴水')]);
  add('背面土の空洞化','common',[H('背面土の空洞化')],[], '確認方法と範囲をメモに残す。',['concrete']);
  add('不同沈下','common',[H('不同沈下')],[], '',['steel','concrete']);
  add('沈下','common',[B(25,'沈下・移動・傾斜'),S('沈下')],[],split,['steel','concrete']);
  add('移動','common',[B(25,'沈下・移動・傾斜'),S('移動')],[],split,['steel','concrete']);
  add('傾斜','common',[B(25,'沈下・移動・傾斜'),H('構造物の沈下・傾倒')],['傾倒'],split,['steel','concrete']);
  add('陥没','common',[H('折損・陥没等／周辺地盤の陥没')],[],split,['concrete']);
  add('折損','concrete',[H('折損・陥没等')],[],split);
  add('護床ブロックの流失','common',[S('ブロックの流失／下流側護床工の消失')],['護床工の消失'],split,['concrete']);
  add('下流河床低下','common',[H('下流河床低下など')],[], '',['concrete']);
  add('土砂堆積','common',[S('上流河床の堆砂進行'),G('土砂の堆積')],['堆砂','堆積'],split,['steel','concrete']);
  add('流木・塵芥の堆積','common',[S('河川内の流木・塵芥等'),G('ごみ、流木、土砂の堆積等')],['ごみ','ゴミ'],split,['steel','concrete']);
  add('ミオ筋の変化','common',[S('ミオ筋の変化')],['澪筋の変化']);
  add('上流側の吸込み','common',[H('上流側の吸込み')],['吸い込み'], '',['concrete']);
  add('湧水','common',[S('下流側の湧水・噴砂')],[],split,['concrete']);
  add('噴砂','common',[S('下流側の湧水・噴砂')],[],split,['concrete']);
  add('周辺地盤のひび割れ','common',[H('周辺地盤の沈下、陥没、ひび割れ')],[],split,['concrete']);
  add('ボルトのゆるみ','steel',[B(3,'ゆるみ・脱落'),G('ボルト・ナットのゆるみ・脱落')],['ボルト緩み'],split);
  add('ボルトの脱落','steel',[B(3,'ゆるみ・脱落'),G('ボルト・ナットのゆるみ・脱落')],[],split);
  add('塗装損傷・劣化','steel',[G('塗装損傷・劣化')]);
  add('片吊り','other',[G('片吊り')],[], '',['steel']);
  add('ローラ・シーブの作動不良','other',[G('ローラ・シーブ等の作動不良')],[],split,['steel']);
  add('開閉装置の作動不良','other',[G('開閉操作ができない等')],[],split,['steel']);
  add('給油不良','other',[G('給油不良')],[], '',['steel']);
  add('ゲート底部からの漏水','other',[G('ゲート底部からの漏水')],[], '',['steel']);
  add('異常な過熱','other',[G('異常な過熱')]);
  add('異臭','other',[G('異臭')]);
  add('計器類の作動不良','other',[G('計器類が正常に作動しない')],[],split);
  // Keep the former built-in label usable, but do not describe it as an official term.
  add('漏水箇所','common',[],[], '旧版の名称を互換性のため保持。新規記録では「漏水」も選べます。',['steel','concrete']);
  named('漏水箇所').legacy=true;
  const norm=s=>String(s??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'');
  const validName=raw=>{
    const name=String(raw??'').trim();
    if(!name)throw Error('変状名称を入力してください。');
    if([...name].length>40)throw Error('名称は40文字以内で入力してください。');
    if(/[\u0000-\u001f\u007f]/.test(name))throw Error('名称に改行や制御文字は使用できません。');
    if(['__proto__','prototype','constructor','tostring','valueof','hasownproperty','isprototypeof','propertyisenumerable','tolocalestring','__definegetter__','__definesetter__','__lookupgetter__','__lookupsetter__'].includes(norm(name)))throw Error('この名称は使用できません。別の名称を入力してください。');
    return name;
  };
  function forProject(project,shapes=[]){
    const out=entries.slice(),seen=new Set(out.map(e=>e.name));
    for(const e of Array.isArray(project?.damageNamesV1)?project.damageNamesV1:[]){
      if(!e||typeof e.name!=='string'||!e.name||seen.has(e.name))continue;
      const group=Object.hasOwn(MATERIALS,e.material)&&e.material!=='all'?e.material:'common';
      out.push({id:e.id||'custom:'+e.name,name:e.name,group,related:group==='common'?['steel','concrete']:[],refs:[],aliases:[],custom:true,note:'この案件で追加した名称（公式資料の名称ではありません）。'});seen.add(e.name);
    }
    for(const s of shapes){
      if(typeof s.type!=='string'||!s.type||seen.has(s.type))continue;
      out.push({id:'existing:'+s.type,name:s.type,group:'common',related:['steel','concrete'],refs:[],aliases:[],legacy:true,note:'保存済み記録の名称をそのまま表示しています。自動的な名称統一はしません。'});seen.add(s.type);
    }
    return out;
  }
  function filter(list,material='all',query=''){
    const q=norm(query);
    return list.filter(e=>(material==='all'||e.group===material||e.related?.includes(material))&&(!q||[e.name,...(e.aliases||[])].some(v=>norm(v).includes(q))));
  }
  function matchName(list,raw){
    const exact=list.find(e=>e.name===raw);if(exact)return exact;
    const n=norm(raw);
    return list.find(e=>norm(e.name)===n)||list.find(e=>e.aliases?.some(a=>norm(a)===n))||null;
  }
  const api={version:VERSION,entries,sources:SOURCES,materials:MATERIALS,forProject,filter,matchName,validName};
  root.SentlogDamageCatalog=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined'||!document.getElementById('damageType'))return;

  const typeEl=document.getElementById('damageType'),host=typeEl.parentElement;
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  const button=(text,id)=>{const b=el('button',text);b.type='button';if(id)b.id=id;return b;};
  const material=el('select');material.id='damageMaterial';material.setAttribute('aria-label','変状の材料分類');
  for(const [v,label] of Object.entries(MATERIALS)){const o=el('option',label);o.value=v;material.append(o);}
  const materialLabel=el('label','材料・対象');materialLabel.htmlFor=material.id;
  host.prepend(materialLabel,material);
  const row=el('div',null,'damage-name-row');typeEl.before(row);row.append(typeEl);
  const findBtn=button('検索・追加','damageNameSearch');row.append(findBtn);
  const details=el('details',null,'damage-name-details'),summary=el('summary','名称の説明・出典'),info=el('div');details.append(summary,info);host.append(details);
  const status=el('div',null,'damage-name-status');status.id='damageNameStatus';status.setAttribute('role','status');host.append(status);
  const style=el('style');style.textContent=`
    #damageMaterial{margin-bottom:6px;width:100%}.damage-name-row{display:flex;gap:5px;min-width:0}.damage-name-row #damageType{flex:1;min-width:0}.damage-name-row button{flex:none;font-size:12px;padding:8px 7px}.damage-name-details{font-size:11px;line-height:1.6;margin-top:6px;overflow-wrap:anywhere}.damage-name-details summary{cursor:pointer}.damage-name-details p{margin:5px 0}.damage-name-status{font-size:12px;line-height:1.5;overflow-wrap:anywhere}
    #damageNameModal{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}#damageNameModal.open{display:flex}#damageNameModal .dn-card{background:#fff;color:#111827;border-radius:12px;padding:14px;width:560px;max-width:100%;max-height:calc(100dvh - 24px);overflow:auto;box-sizing:border-box;overscroll-behavior:contain}#damageNameModal .dn-head{display:flex;align-items:center;justify-content:space-between;gap:8px}#damageNameModal h2{font-size:17px;margin:0}#damageNameModal .dn-target{font-size:12px;line-height:1.5;margin:8px 0;overflow-wrap:anywhere}#damageNameModal input,#damageNameModal select{width:100%;box-sizing:border-box;font-size:16px;margin:4px 0 8px}#damageNameResults{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:32vh;overflow:auto;overscroll-behavior:contain}#damageNameResults button{min-height:44px;text-align:left;white-space:normal;overflow-wrap:anywhere;padding:8px;font-size:13px}#damageNameModal small{display:block;font-size:11px;line-height:1.5}#damageNameModal form{border-top:1px solid #d1d5db;margin-top:12px;padding-top:10px}#damageNameModal form label{display:block}#damageNameError{font-size:13px;line-height:1.5;margin-top:8px;white-space:pre-wrap}#damageNameSave{width:100%;min-height:44px}#damageNameModal [hidden]{display:none!important}@media(max-width:480px){#damageNameModal{padding:8px}#damageNameModal .dn-card{max-height:calc(100dvh - 16px);padding:12px}#damageNameResults{max-height:27vh}}`;
  document.head.append(style);
  let projectId=null,prefs={material:'all',lastType:'腐食',recent:[]},list=entries.slice(),lastInfo='';
  const prefKey=id=>'sentlogDamageViewV1:'+id;
  function loadPrefs(id){try{const p=JSON.parse(localStorage.getItem(prefKey(id))||'{}');return {material:Object.hasOwn(MATERIALS,p.material)?p.material:'all',lastType:typeof p.lastType==='string'?p.lastType:'腐食',recent:Array.isArray(p.recent)?p.recent.filter(x=>typeof x==='string').slice(0,8):[]};}catch{return {material:'all',lastType:'腐食',recent:[]};}}
  function savePrefs(){if(!projectId)return;try{localStorage.setItem(prefKey(projectId),JSON.stringify(prefs));}catch{/* View preferences must never prevent recording. */}}
  function currentList(){return forProject(getProject(),state.shapes||[]);}
  function showInfo(){
    const name=typeEl.value,e=list.find(x=>x.name===name);const signature=name+':'+(e?.id||'');if(signature===lastInfo)return;lastInfo=signature;info.replaceChildren();
    if(!e)return;
    if(e.note)info.append(el('p',e.note));
    for(const ref of e.refs){const source=SOURCES[ref.source],p=el('p'),a=el('a',source.title+' '+source.edition);a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';p.append(a,document.createTextNode('／'+source.section+'／'+ref.item));info.append(p);}
    info.append(el('p','名称・対応候補の参照です。施設間の判定基準や区分番号を共通化するものではありません。'));
  }
  function ensureOption(name){if(!name)return;if(![...typeEl.options].some(o=>o.value===name)){const o=el('option',name);o.value=name;typeEl.append(o);}}
  function refresh(wanted){
    const p=getProject(),changed=projectId!==(p?.id||null);if(changed){projectId=p?.id||null;prefs=loadPrefs(projectId);status.textContent='';}
    list=currentList();material.value=prefs.material;
    const keep=wanted||(changed?prefs.lastType:typeEl.value)||'腐食';
    const visible=filter(list,prefs.material),allowed=new Set(visible.map(e=>e.name));typeEl.replaceChildren();
    const appendGroup=(title,names)=>{if(!names.length)return;const g=el('optgroup');g.label=title;for(const e of names){const o=el('option',e.name);o.value=e.name;g.append(o);}typeEl.append(g);};
    if(!allowed.has(keep))appendGroup('現在の名称（変更は名称を選択）',[{name:keep}]);
    const recent=prefs.recent.map(n=>visible.find(e=>e.name===n)).filter(Boolean);appendGroup('最近使用',recent);const recentSet=new Set(recent.map(e=>e.name));
    appendGroup('標準名称',visible.filter(e=>!recentSet.has(e.name)&&!e.custom&&!e.legacy));
    appendGroup('この案件の追加名称・既存名称',visible.filter(e=>!recentSet.has(e.name)&&(e.custom||e.legacy)));
    ensureOption(keep);typeEl.value=keep;lastInfo='';showInfo();
  }
  function remember(){prefs.lastType=typeEl.value;prefs.recent=[typeEl.value,...prefs.recent.filter(n=>n!==typeEl.value)].slice(0,8);savePrefs();lastInfo='';showInfo();}
  material.onchange=()=>{prefs.material=material.value;savePrefs();refresh(typeEl.value);};
  typeEl.addEventListener('change',remember);
  const oldSelect=selectShape;
  selectShape=function(id){const s=state.shapes.find(x=>x.id===id);if(s)refresh(s.type||'腐食');const result=oldSelect.apply(this,arguments);showInfo();return result;};
  const oldShowEditor=showEditor;
  showEditor=function(){const result=oldShowEditor.apply(this,arguments);refresh();return result;};

  const modal=el('div');modal.id='damageNameModal';modal.className='modal-backdrop';modal.setAttribute('aria-hidden','true');
  const card=el('div',null,'dn-card');card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');card.setAttribute('aria-labelledby','damageNameTitle');
  const head=el('div',null,'dn-head'),title=el('h2','変状名称を選ぶ');title.id='damageNameTitle';const closeBtn=button('閉じる','damageNameClose');head.append(title,closeBtn);
  const target=el('p',null,'dn-target');const search=el('input');search.type='search';search.id='damageNameQuery';search.placeholder='名称・別名で検索（例：錆汁、うき）';search.setAttribute('aria-label','すべての変状名称を検索');
  const scope=material.cloneNode(true);scope.id='damageNameScope';scope.setAttribute('aria-label','検索する材料分類');
  const results=el('div');results.id='damageNameResults';
  const form=el('form');form.noValidate=true;const customLabel=el('label','候補にない場合は、この案件に名称を追加');customLabel.htmlFor='damageNameInput';
  const input=el('input');input.id='damageNameInput';input.type='text';input.placeholder='例：補修材の再剥離';input.autocomplete='off';
  const customMaterial=material.cloneNode(true);customMaterial.id='damageNameCustomMaterial';customMaterial.setAttribute('aria-label','追加名称の材料分類');customMaterial.querySelector('option[value="all"]').remove();
  const saveBtn=button('追加して使用','damageNameSave');saveBtn.type='submit';const err=el('div');err.id='damageNameError';err.setAttribute('role','status');
  form.append(customLabel,input,customMaterial,el('small','40文字以内。端末内に保存し、この案件の次の記録でも選べます。'),saveBtn,err);
  card.append(head,target,search,scope,results,form);modal.append(card);document.body.append(modal);
  let captured=null,saving=false,returnFocus=null;
  const isOpen=()=>modal.classList.contains('open');
  function sameTarget(){return captured&&activeProjectId===captured.project&&activeDrawingId===captured.drawing&&state.currentPage===captured.page&&selected===captured.shape&&currentView==='editor';}
  function close(){if(saving)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');captured=null;returnFocus?.focus();}
  function choose(name){
    if(!sameTarget())throw Error('編集中の図面が変わりました。閉じてからもう一度開いてください。');
    refresh(name);typeEl.dispatchEvent(new Event('change',{bubbles:true}));remember();
  }
  async function applyName(name){
    if(saving)return;saving=true;saveBtn.disabled=true;err.textContent='端末内に保存中…';
    try{choose(name);await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();saving=false;close();status.textContent='名称「'+name+'」を選択しました。';}
    catch(e){err.textContent='保存を確認できません。画面を閉じずに確認してください。\n'+(e?.message||e);}
    finally{saving=false;saveBtn.disabled=false;}
  }
  function renderResults(){
    const found=filter(currentList(),scope.value,search.value);results.replaceChildren();
    if(!found.length)results.append(el('p','候補がありません。「すべて」で検索するか、下から名称を追加してください。'));
    for(const e of found){const b=button(e.name);b.dataset.damageName=e.name;if(e.custom)b.append(el('small','この案件の追加名称'));b.onclick=()=>applyName(e.name);results.append(b);}
  }
  function open(){
    if(currentView!=='editor'||!getProject()||!activeDrawingId)return;
    refresh(typeEl.value);captured={project:activeProjectId,drawing:activeDrawingId,page:state.currentPage,shape:selected};returnFocus=document.activeElement;
    const shape=state.shapes.find(s=>s.id===selected);target.textContent=shape?'選択中の「'+(shape.autoLabel||shape.type)+'」の名称を変更します。':'次に描く変状の名称を選びます。';
    search.value='';input.value='';err.textContent='';scope.value=prefs.material;customMaterial.value=prefs.material==='all'?'common':prefs.material;renderResults();
    modal.classList.add('open');modal.setAttribute('aria-hidden','false');closeBtn.focus();
  }
  findBtn.onclick=open;closeBtn.onclick=close;search.oninput=renderResults;scope.onchange=renderResults;
  form.onsubmit=async event=>{
    event.preventDefault();if(saving)return;
    let name;try{name=validName(input.value);if(!sameTarget())throw Error('編集中の図面が変わりました。もう一度開いてください。');root.SentlogRecords.assertSafe();}catch(e){err.textContent=e.message;return;}
    const p=getProject(),known=matchName(currentList(),name);
    if(known){input.value=known.name;await applyName(known.name);return;}
    const oldNames=p.damageNamesV1,oldUpdated=p.updatedAt;
    try{
      p.damageNamesV1=[...(Array.isArray(oldNames)?oldNames:[]),{id:'custom-'+uid(),name,material:customMaterial.value,createdAt:Date.now()}];
      p.updatedAt=Math.max(Date.now(),Number(oldUpdated||0)+1);
      saveWorkspace();
    }catch(e){p.damageNamesV1=oldNames;p.updatedAt=oldUpdated;err.textContent='名称を保存できません。'+(e?.message||e);return;}
    await applyName(name);
  };
  modal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key!=='Tab')return;
    const focusables=[...card.querySelectorAll('button,input,select,a[href]')].filter(e=>!e.disabled&&!e.hidden&&e.getClientRects().length);
    if(!focusables.length)return;const first=focusables[0],last=focusables[focusables.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
  Object.assign(api,{refresh,ensureOption,open,isEditing:isOpen});
  refresh();
})(typeof window==='object'?window:globalThis);

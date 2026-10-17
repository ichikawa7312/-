/* Sentlog v1.64: field photo points and grouped survey records.
 * Records live in state.shapes so existing persistence, sync, backup and photo storage keep working.
 */
(function(root){
  'use strict';

  const PHOTO_TYPE='全景';
  const SURVEY_TYPE='調査';
  const SURVEY_ITEMS=['写真記録','鉄筋探査','中性化','コア採取','塩化物','はつり','自然電位','圧縮強度','板厚測定','その他'];
  const PHOTO_SCREEN_LENGTH=68;
  const PHOTO_CIRCLE_RADIUS=5;
  const SURVEY_POINT_RADIUS=7;
  const SURVEY_ARROW_SHAFT=6;
  const SURVEY_ARROW_HEAD_LENGTH=20;
  const SURVEY_ARROW_HEAD_HALF=14;

  function isFieldRecord(s){return !!s&&s.recordKind==='field-record'&&(s.recordType==='photo'||s.recordType==='survey');}
  function recordLabel(s){
    if(!isFieldRecord(s))return '';
    const prefix=s.recordType==='photo'?PHOTO_TYPE:SURVEY_TYPE;
    const n=Number(s.typeNo)||Number(s.recordNo)||1;
    return prefix+'-'+n;
  }
  function normPoint(p){return {x:Number(p?.x)||0,y:Number(p?.y)||0};}
  function angleFrom(a,b){const p=normPoint(a),q=normPoint(b);return Math.atan2(q.y-p.y,q.x-p.x);}
  function photoEnd(origin,angle,scale=1){
    const z=Math.max(.001,Number(scale)||1),p=normPoint(origin),len=PHOTO_SCREEN_LENGTH/z;
    return {x:p.x+Math.cos(Number(angle)||0)*len,y:p.y+Math.sin(Number(angle)||0)*len};
  }
  function surveyArrowPolygon(tail,tip,scale=1){
    const a=normPoint(tail),b=normPoint(tip),z=Math.max(.001,Number(scale)||1);
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
    if(len<1e-7)return [];
    const ux=dx/len,uy=dy/len,px=-uy,py=ux;
    const shaft=SURVEY_ARROW_SHAFT/z,headLen=Math.min(len*.55,SURVEY_ARROW_HEAD_LENGTH/z),headHalf=SURVEY_ARROW_HEAD_HALF/z;
    const neck={x:b.x-ux*headLen,y:b.y-uy*headLen};
    return [
      {x:a.x+px*shaft,y:a.y+py*shaft},
      {x:neck.x+px*shaft,y:neck.y+py*shaft},
      {x:neck.x+px*headHalf,y:neck.y+py*headHalf},
      {x:b.x,y:b.y},
      {x:neck.x-px*headHalf,y:neck.y-py*headHalf},
      {x:neck.x-px*shaft,y:neck.y-py*shaft},
      {x:a.x-px*shaft,y:a.y-py*shaft},
    ];
  }
  function nextRecordNumber(shapes,type){
    return (Array.isArray(shapes)?shapes:[]).filter(s=>isFieldRecord(s)&&s.recordType===type).length+1;
  }
  function surveyPointFrom(s){
    if(!isFieldRecord(s)||s.recordType!=='survey')return null;
    if(s.displayKind==='arrow'&&Array.isArray(s.points)&&s.points[1])return normPoint(s.points[1]);
    return normPoint(s.point||s.points?.[0]);
  }
  const pure={PHOTO_TYPE,SURVEY_TYPE,SURVEY_ITEMS,PHOTO_SCREEN_LENGTH,isFieldRecord,recordLabel,angleFrom,photoEnd,surveyArrowPolygon,nextRecordNumber,surveyPointFrom};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogFieldRecords)return;

  const $=id=>document.getElementById(id);
  const stageWrap=$('stageWrap'),toolbar=document.querySelector('.toolbar'),inspector=$('inspector'),svg=$('svg');
  if(!stageWrap||!toolbar||!inspector||!svg)return;

  let recordDraft=null,recordPanel=null,recordModeModal=null,recordBtn=null;
  const standard={};
  const defaultDeleteText=$('deleteBtn')?.textContent||'選択変状を削除';

  function currentRecord(){const s=state?.shapes?.find(x=>x.id===selected);return isFieldRecord(s)?s:null;}
  function z(){return Math.max(.001,Number(scale)||1);}
  function svgEl(tag,attrs={}){
    const e=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));
    return e;
  }
  function setTool(next,button){
    document.querySelectorAll('[data-tool], [data-field-record-tool]').forEach(b=>b.classList.remove('active'));
    drawing=null;
    if(typeof polygonDraftCursor!=='undefined')polygonDraftCursor=null;
    if(typeof polygonTouch!=='undefined')polygonTouch=null;
    recordDraft=null;
    if(tool===next){tool='pan';render();return;}
    tool=next;if(button)button.classList.add('active');render();
  }
  function installStyle(){
    if(document.getElementById('fieldRecordStyle'))return;
    const style=document.createElement('style');style.id='fieldRecordStyle';style.textContent=`
#fieldRecordModeModal{position:fixed;inset:0;z-index:1160;background:rgba(0,0,0,.46);display:none;align-items:center;justify-content:center;padding:14px;box-sizing:border-box}#fieldRecordModeModal.open{display:flex}
#fieldRecordModeModal .fr-mode-card{width:min(420px,100%);background:#fff;color:#111827;border-radius:16px;padding:16px;box-sizing:border-box;box-shadow:0 20px 60px #0005}
#fieldRecordModeModal h2{font-size:18px;margin:0 0 5px}#fieldRecordModeModal p{font-size:12px;color:#64748b;margin:0 0 12px}
#fieldRecordModeModal button{display:block;width:100%;min-height:52px;margin:8px 0;text-align:left;padding:9px 12px}#fieldRecordModeModal button strong{display:block;font-size:14px}#fieldRecordModeModal button small{display:block;margin-top:3px;color:#64748b}
#fieldRecordPanel{padding:10px;border:1px solid #dbe2ea;border-radius:10px;background:#f8fafc;color:#111827}#fieldRecordPanel[hidden]{display:none!important}
#fieldRecordPanel .fr-title{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}#fieldRecordPanel .fr-title strong{font-size:15px}#fieldRecordPanel .fr-title span{font-size:11px;color:#64748b}
#fieldRecordPanel .fr-label{display:block;font-size:12px;font-weight:700;margin:9px 0 5px}#fieldRecordPanel .fr-help{font-size:11px;line-height:1.55;color:#64748b;margin:5px 0}
#fieldRecordPanel .fr-checks{display:grid;grid-template-columns:1fr 1fr;gap:5px 8px}#fieldRecordPanel .fr-checks label{display:flex;align-items:center;gap:5px;font-size:12px;min-width:0}
#fieldRecordPanel .fr-checks input{width:auto;margin:0;flex:none}#fieldRecordPanel select,#fieldRecordPanel textarea{width:100%;box-sizing:border-box}#fieldRecordPanel textarea{min-height:70px;resize:vertical}
@media(max-width:899px){#fieldRecordModeModal{align-items:flex-end}#fieldRecordModeModal .fr-mode-card{border-radius:16px 16px 10px 10px}#fieldRecordPanel .fr-checks{grid-template-columns:1fr 1fr}}
`;
    document.head.appendChild(style);
  }
  function installToolbar(){
    if(recordBtn)return;
    recordBtn=document.createElement('button');recordBtn.type='button';recordBtn.dataset.fieldRecordTool='record';
    recordBtn.classList.add('sl-tool-button');recordBtn.setAttribute('aria-label','写真・調査記録');recordBtn.setAttribute('aria-haspopup','dialog');
    recordBtn.style.setProperty('--sl-named-width','44px');
    recordBtn.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M4 7h4l1.4-2h5.2L16 7h4v11H4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M18.5 3v4M16.5 5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="sl-tool-label" aria-hidden="true">記録</span>';
    const settle=()=>{
      const drawGroup=toolbar.querySelector('.sl-tool-group:not(.sl-tool-history)');
      if(drawGroup&&!drawGroup.contains(recordBtn))drawGroup.append(recordBtn);
    };
    const drawGroup=toolbar.querySelector('.sl-tool-group:not(.sl-tool-history)');
    if(drawGroup)drawGroup.append(recordBtn);
    else{const anchor=$('undoBtn');if(anchor?.parentElement===toolbar)toolbar.insertBefore(recordBtn,anchor);else toolbar.append(recordBtn);}
    toolbar.classList.add('sl-has-record-tool');
    new MutationObserver(settle).observe(toolbar,{childList:true,subtree:true});
    setTimeout(()=>{settle();root.SentlogToolbarIcons?.layout?.();},0);
    recordBtn.onclick=()=>{
      if(String(tool).startsWith('field-')){setTool(tool,recordBtn);return;}
      openRecordMode();
    };
  }
  function installModeModal(){
    if(recordModeModal)return;
    recordModeModal=document.createElement('div');recordModeModal.id='fieldRecordModeModal';recordModeModal.setAttribute('aria-hidden','true');
    recordModeModal.innerHTML='<div class="fr-mode-card" role="dialog" aria-modal="true" aria-labelledby="frModeTitle"><h2 id="frModeTitle">記録を追加</h2><p>図面に追加する記録を選んでください。</p><button type="button" data-mode="photo"><strong>○→ 全景撮影</strong><small>○を撮影位置、固定長の矢印を撮影方向として記録</small></button><button type="button" data-mode="point"><strong>◎ 調査ポイント</strong><small>調査した場所を1点で示す</small></button><button type="button" data-mode="arrow"><strong>⇢ 調査・枠付き太矢印</strong><small>白抜き太矢印の先端を調査位置として示す</small></button><button type="button" id="frModeCancel">キャンセル</button></div>';
    document.body.append(recordModeModal);
    recordModeModal.querySelector('[data-mode="photo"]').onclick=()=>{closeRecordMode();setTool('field-photo',recordBtn);};
    recordModeModal.querySelector('[data-mode="point"]').onclick=()=>{closeRecordMode();setTool('field-survey-point',recordBtn);};
    recordModeModal.querySelector('[data-mode="arrow"]').onclick=()=>{closeRecordMode();setTool('field-survey-arrow',recordBtn);};
    recordModeModal.querySelector('#frModeCancel').onclick=closeRecordMode;
    recordModeModal.addEventListener('pointerdown',e=>{if(e.target===recordModeModal)closeRecordMode();});
  }
  function openRecordMode(){installModeModal();recordModeModal.classList.add('open');recordModeModal.setAttribute('aria-hidden','false');}
  function closeRecordMode(){recordModeModal?.classList.remove('open');recordModeModal?.setAttribute('aria-hidden','true');}

  function rememberStandardNodes(){
    if(standard.ready)return;standard.ready=true;
    const damageHost=$('damageMaterial')?.parentElement||$('damageType')?.parentElement;
    const globalRow=$('typeNo')?.closest('.row');
    Object.assign(standard,{
      damageHost,globalRow,
      member:$('member')?.parentElement,
      lineWidth:$('lineWidth')?.parentElement,
      measure:$('measureResult')?.parentElement,
      memo:$('memo')?.parentElement,
      apply:$('applyBtn')
    });
  }
  function showStandard(show){
    rememberStandardNodes();
    for(const node of Object.values(standard)){
      if(!node||node===true)continue;
      node.hidden=!show;
    }
  }
  function installInspector(){
    if(recordPanel)return;
    const photoPanel=inspector.querySelector('.photo-panel');
    recordPanel=document.createElement('div');recordPanel.id='fieldRecordPanel';recordPanel.hidden=true;
    recordPanel.innerHTML=`
      <div class="fr-title"><strong id="frRecordTitle">調査-1</strong><span id="frRecordKind"></span></div>
      <div id="frPhotoHelp" class="fr-help" hidden>○が撮影位置、細い矢印が撮影方向です。矢印の長さは図面上で一定です。</div>
      <div id="frSurveyFields" hidden>
        <div class="fr-label">実施内容（複数選択可）</div>
        <div id="frSurveyChecks" class="fr-checks"></div>
        <div class="fr-label">表示</div>
        <select id="frSurveyDisplay"><option value="point">◎ ポイント</option><option value="arrow">枠付き太矢印</option></select>
        <div class="fr-help">太矢印は先端が調査位置です。白抜き＋太い枠で表示します。</div>
      </div>
      <label class="fr-label" for="frRecordMemo">記録メモ</label>
      <textarea id="frRecordMemo" placeholder="調査内容、位置の補足、結果など"></textarea>
    `;
    for(const item of SURVEY_ITEMS){
      const label=document.createElement('label'),cb=document.createElement('input');cb.type='checkbox';cb.value=item;
      label.append(cb,document.createTextNode(item));recordPanel.querySelector('#frSurveyChecks').append(label);
      cb.onchange=()=>updateSurveyItems();
    }
    photoPanel?.insertAdjacentElement('beforebegin',recordPanel);
    recordPanel.querySelector('#frRecordMemo').addEventListener('change',()=>{
      const s=currentRecord();if(!s)return;const next=recordPanel.querySelector('#frRecordMemo').value;
      if((s.memo||'')===next)return;pushHistory();s.memo=next;persist();
    });
    recordPanel.querySelector('#frSurveyDisplay').onchange=e=>changeSurveyDisplay(e.target.value);
  }
  function syncInspector(){
    installInspector();const s=currentRecord(),custom=!!s;showStandard(!custom);
    recordPanel.hidden=!custom;
    if($('deleteBtn')){$('deleteBtn').textContent=custom?'記録を削除':defaultDeleteText;$('deleteBtn').disabled=!selected;}
    if($('cameraBtn'))$('cameraBtn').disabled=!selected;
    if($('photoAddBtn'))$('photoAddBtn').disabled=!selected;
    if(!custom)return;
    $('frRecordTitle').textContent=recordLabel(s);
    $('frRecordKind').textContent=s.recordType==='photo'?'全景撮影':'調査記録';
    $('frPhotoHelp').hidden=s.recordType!=='photo';
    $('frSurveyFields').hidden=s.recordType!=='survey';
    $('frRecordMemo').value=s.memo||'';
    if(s.recordType==='survey'){
      const chosen=new Set(Array.isArray(s.surveyItems)?s.surveyItems:[]);
      recordPanel.querySelectorAll('#frSurveyChecks input').forEach(cb=>cb.checked=chosen.has(cb.value));
      $('frSurveyDisplay').value=s.displayKind==='arrow'?'arrow':'point';
    }
  }
  function updateSurveyItems(){
    const s=currentRecord();if(!s||s.recordType!=='survey')return;
    const next=[...recordPanel.querySelectorAll('#frSurveyChecks input:checked')].map(x=>x.value);
    if(JSON.stringify(next)===JSON.stringify(s.surveyItems||[]))return;
    pushHistory();s.surveyItems=next;persist();
  }
  function changeSurveyDisplay(mode){
    const s=currentRecord();if(!s||s.recordType!=='survey'||!['point','arrow'].includes(mode)||s.displayKind===mode)return;
    pushHistory();
    const target=surveyPointFrom(s)||{x:0,y:0};
    if(mode==='point'){
      s.displayKind='point';s.point=target;s.points=[target,target];
    }else{
      const len=85/z();const tail={x:target.x-len,y:target.y};
      s.displayKind='arrow';s.points=[tail,target];delete s.point;
    }
    persist();render();
  }

  function createRecord(data){
    pushHistory();
    const id=crypto.randomUUID?crypto.randomUUID():'fr-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    const recordType=data.recordType;
    const s={
      id,page:state.currentPage,kind:'field-record',recordKind:'field-record',recordType,
      type:recordType==='photo'?PHOTO_TYPE:SURVEY_TYPE,
      recordNo:nextRecordNumber(state.shapes,recordType),
      photos:[],memo:'',surveyItems:[],...data
    };
    state.shapes.push(s);rebuildNumberingState();s.recordNo=s.typeNo;s.autoLabel=recordLabel(s);
    selected=s.id;persist();render();renderSelectedPhotos();syncInspector();
    if(innerWidth<900)$('inspector')?.classList.add('open');
    return s;
  }
  function selectRecord(id){
    const s=state.shapes.find(x=>x.id===id);if(!isFieldRecord(s))return;
    selected=id;render();renderSelectedPhotos();syncInspector();updateMeasureResult?.();
    if(innerWidth<900)$('inspector')?.classList.add('open');
  }
  function bindRecordHit(hit,id){
    hit.style.cursor='pointer';hit.dataset.fieldRecordId=id;
    hit.addEventListener('pointerdown',e=>{
      if(tool!=='pan')return;e.preventDefault();e.stopPropagation();selectRecord(id);
    });
  }

  function drawText(text,x,y,selectedNow){
    const fs=Math.max(11,14/z()),t=svgEl('text',{x,y,'font-size':fs,'text-anchor':'middle','dominant-baseline':'middle',
      fill:selectedNow?'#1d4ed8':'#111827','font-weight':'700','paint-order':'stroke fill',stroke:'#fff','stroke-width':3/z(),'pointer-events':'none'});
    t.textContent=text;svg.appendChild(t);return t;
  }
  function drawPhotoRecord(s){
    const p=normPoint(s.point||s.points?.[0]),end=photoEnd(p,s.angle,z()),selectedNow=s.id===selected;
    const color=selectedNow?'#2563eb':'#111827',r=PHOTO_CIRCLE_RADIUS/z(),head=8/z(),wing=5/z();
    const ux=Math.cos(s.angle||0),uy=Math.sin(s.angle||0),px=-uy,py=ux;
    const start={x:p.x+ux*(r+2/z()),y:p.y+uy*(r+2/z())};
    const neck={x:end.x-ux*head,y:end.y-uy*head};
    const line=svgEl('line',{x1:start.x,y1:start.y,x2:neck.x,y2:neck.y,stroke:color,'stroke-width':1.7/z(),'stroke-linecap':'round'});
    const tri=svgEl('polygon',{points:`${end.x},${end.y} ${neck.x+px*wing},${neck.y+py*wing} ${neck.x-px*wing},${neck.y-py*wing}`,fill:color});
    const circle=svgEl('circle',{cx:p.x,cy:p.y,r,fill:'#fff',stroke:color,'stroke-width':1.8/z()});
    for(const e of [line,tri,circle]){e.style.pointerEvents='none';svg.appendChild(e);}
    drawText(recordLabel(s),p.x,p.y-13/z(),selectedNow);
    if(tool==='pan'){
      const hit=svgEl('line',{x1:p.x,y1:p.y,x2:end.x,y2:end.y,stroke:'rgba(0,0,0,.001)','stroke-width':24/z(),'pointer-events':'stroke'});
      bindRecordHit(hit,s.id);svg.appendChild(hit);
      const dotHit=svgEl('circle',{cx:p.x,cy:p.y,r:14/z(),fill:'rgba(0,0,0,.001)','pointer-events':'all'});
      bindRecordHit(dotHit,s.id);svg.appendChild(dotHit);
    }
  }
  function drawSurveyPoint(s){
    const p=surveyPointFrom(s),selectedNow=s.id===selected,color=selectedNow?'#2563eb':'#334155',r=SURVEY_POINT_RADIUS/z();
    const outer=svgEl('circle',{cx:p.x,cy:p.y,r,fill:'#fff',stroke:color,'stroke-width':2.2/z()});
    const inner=svgEl('circle',{cx:p.x,cy:p.y,r:r*.35,fill:color,stroke:'none'});outer.style.pointerEvents=inner.style.pointerEvents='none';svg.append(outer,inner);
    drawText(recordLabel(s),p.x+30/z(),p.y,selectedNow);
    if(tool==='pan'){
      const hit=svgEl('circle',{cx:p.x,cy:p.y,r:16/z(),fill:'rgba(0,0,0,.001)','pointer-events':'all'});bindRecordHit(hit,s.id);svg.appendChild(hit);
    }
  }
  function drawSurveyArrow(s){
    const tail=normPoint(s.points?.[0]),tip=normPoint(s.points?.[1]),poly=surveyArrowPolygon(tail,tip,z());if(!poly.length)return;
    const selectedNow=s.id===selected,color=selectedNow?'#2563eb':'#334155';
    const arrow=svgEl('polygon',{points:poly.map(p=>p.x+','+p.y).join(' '),fill:'#fff',stroke:color,'stroke-width':2.4/z(),'stroke-linejoin':'round'});
    arrow.style.pointerEvents='none';svg.appendChild(arrow);
    const dx=tip.x-tail.x,dy=tip.y-tail.y,len=Math.hypot(dx,dy)||1,px=-dy/len,py=dx/len;
    drawText(recordLabel(s),tail.x+px*15/z(),tail.y+py*15/z(),selectedNow);
    if(tool==='pan'){
      const hit=svgEl('line',{x1:tail.x,y1:tail.y,x2:tip.x,y2:tip.y,stroke:'rgba(0,0,0,.001)','stroke-width':30/z(),'pointer-events':'stroke'});bindRecordHit(hit,s.id);svg.appendChild(hit);
    }
  }
  function drawRecords(records){
    for(const s of records){
      if((s.page||1)!==state.currentPage)continue;
      if(s.recordType==='photo')drawPhotoRecord(s);
      else if(s.displayKind==='arrow')drawSurveyArrow(s);
      else drawSurveyPoint(s);
    }
  }

  function renderRecordPreview(){
    render();if(!recordDraft)return;
    const a=recordDraft.start,b=recordDraft.current||a;
    if(recordDraft.tool==='field-photo'){
      const ang=angleFrom(a,b),end=photoEnd(a,ang,z()),color='#2563eb',r=PHOTO_CIRCLE_RADIUS/z();
      const c=svgEl('circle',{cx:a.x,cy:a.y,r,fill:'#fff',stroke:color,'stroke-width':1.8/z()});
      const l=svgEl('line',{x1:a.x,y1:a.y,x2:end.x,y2:end.y,stroke:color,'stroke-width':1.7/z(),'stroke-dasharray':`${5/z()} ${3/z()}`});svg.append(c,l);
    }else if(recordDraft.tool==='field-survey-point'){
      const c=svgEl('circle',{cx:a.x,cy:a.y,r:SURVEY_POINT_RADIUS/z(),fill:'#fff',stroke:'#2563eb','stroke-width':2.2/z()});svg.appendChild(c);
    }else if(recordDraft.tool==='field-survey-arrow'){
      const poly=surveyArrowPolygon(a,b,z());if(poly.length){const p=svgEl('polygon',{points:poly.map(q=>q.x+','+q.y).join(' '),fill:'#fff',stroke:'#2563eb','stroke-width':2.4/z(),'stroke-linejoin':'round'});svg.appendChild(p);}
    }
  }

  function pointerDown(e){
    if(!String(tool).startsWith('field-')||!state.sourceType||gestureLock)return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    const p=point(e);recordDraft={tool,pointerId:e.pointerId,start:p,current:p};
    try{stageWrap.setPointerCapture(e.pointerId)}catch{}
    e.preventDefault();e.stopImmediatePropagation();renderRecordPreview();
  }
  function pointerMove(e){
    if(!recordDraft||e.pointerId!==recordDraft.pointerId)return;
    if(gestureLock){recordDraft=null;return;}
    recordDraft.current=point(e);e.preventDefault();e.stopImmediatePropagation();renderRecordPreview();
  }
  function pointerUp(e){
    if(!recordDraft||e.pointerId!==recordDraft.pointerId)return;
    const d=recordDraft;recordDraft=null;const end=point(e),dist=Math.hypot(end.x-d.start.x,end.y-d.start.y);
    try{stageWrap.releasePointerCapture(e.pointerId)}catch{}
    e.preventDefault();e.stopImmediatePropagation();
    let s=null;
    if(d.tool==='field-photo'){
      if(dist<10/z()){render();alert('撮影位置から、写真を向けた方向へ少しドラッグしてください。');return;}
      s=createRecord({recordType:'photo',displayKind:'direction',point:d.start,points:[d.start,end],angle:angleFrom(d.start,end)});
      $('cameraInput')?.click();
    }else if(d.tool==='field-survey-point'){
      s=createRecord({recordType:'survey',displayKind:'point',point:d.start,points:[d.start,d.start]});
    }else if(d.tool==='field-survey-arrow'){
      if(dist<28/z()){render();alert('太矢印は、矢印の根元から調査位置（先端）までドラッグしてください。');return;}
      s=createRecord({recordType:'survey',displayKind:'arrow',points:[d.start,end]});
    }
    if(s)syncInspector();
  }

  function installEvents(){
    stageWrap.addEventListener('pointerdown',pointerDown,{capture:true,passive:false});
    stageWrap.addEventListener('pointermove',pointerMove,{capture:true,passive:false});
    stageWrap.addEventListener('pointerup',pointerUp,{capture:true,passive:false});
    stageWrap.addEventListener('pointercancel',e=>{if(recordDraft?.pointerId===e.pointerId){recordDraft=null;render();}},{capture:true});
    window.addEventListener('pointerdown',e=>{
      if(recordDraft&&e.pointerType==='touch'&&e.pointerId!==recordDraft.pointerId){recordDraft=null;render();}
    },{capture:true});
  }

  installStyle();installToolbar();installModeModal();installInspector();installEvents();

  const oldRender=render;
  render=function(){
    const all=state.shapes||[],records=all.filter(isFieldRecord),normal=all.filter(s=>!isFieldRecord(s));
    let result;
    state.shapes=normal;
    try{result=oldRender.apply(this,arguments);}
    finally{state.shapes=all;}
    drawRecords(records);syncInspector();
    return result;
  };

  const oldSelect=selectShape;
  selectShape=function(id){
    const s=state.shapes.find(x=>x.id===id);
    if(isFieldRecord(s)){selectRecord(id);return;}
    const result=oldSelect.apply(this,arguments);syncInspector();return result;
  };

  root.SentlogFieldRecords={...pure,selectRecord,syncInspector};
  if(typeof currentView!=='undefined'&&currentView==='editor')render();else syncInspector();
})(typeof window==='object'?window:globalThis);

/* SentlogPageManagement v1.93: reversible per-page visibility without modifying source PDFs. */
(function(root){
  'use strict';

  const VERSION=1;

  function normalizeEntry(value){
    const v=value&&typeof value==='object'?value:{};
    const revision=Number.isSafeInteger(Number(v.revision))&&Number(v.revision)>=0?Number(v.revision):0;
    const updatedAt=Number.isFinite(Number(v.updatedAt))&&Number(v.updatedAt)>=0?Number(v.updatedAt):0;
    return {hidden:v.hidden===true,revision,updatedAt};
  }
  function normalizePageStates(value,pageCount=Infinity){
    const out={};
    if(!value||typeof value!=='object'||Array.isArray(value))return out;
    for(const [key,raw] of Object.entries(value)){
      const page=Number(key);
      if(!Number.isSafeInteger(page)||page<1||page>pageCount)continue;
      const item=normalizeEntry(raw);
      if(item.revision>0||item.hidden)out[String(page)]=item;
    }
    return out;
  }
  function pageState(states,page){return normalizeEntry(states?.[String(page)]);}
  function isHidden(states,page){return pageState(states,page).hidden;}
  function visiblePages(pageCount,states){
    const count=Math.max(1,Number(pageCount)||1),out=[];
    for(let page=1;page<=count;page++)if(!isHidden(states,page))out.push(page);
    return out;
  }
  function setHidden(states,page,hidden,now=Date.now()){
    const key=String(page),out={...normalizePageStates(states)};
    const old=pageState(out,page);
    if(old.hidden===!!hidden && old.revision>0)return out;
    out[key]={hidden:!!hidden,revision:old.revision+1,updatedAt:Number(now)||Date.now()};
    return out;
  }
  function nearestVisible(pageCount,states,page){
    const pages=visiblePages(pageCount,states);
    if(!pages.length)return null;
    const current=Number(page)||1;
    return pages.find(p=>p>current)??[...pages].reverse().find(p=>p<current)??pages[0];
  }
  function pageRecordStats(shapes,page){
    const list=(shapes||[]).filter(s=>(Number(s?.page)||1)===Number(page));
    let damage=0,dimensions=0,memos=0,photos=0;
    for(const s of list){
      photos+=Array.isArray(s?.photos)?s.photos.length:0;
      if(s?.recordKind==='drawing-memo')memos++;
      else if(s?.recordKind==='dimension-line'||s?.kind==='dimension')dimensions++;
      else damage++;
    }
    return {damage,dimensions,memos,photos,total:list.length};
  }
  function replacementRecordSummary(value){
    const shapes=value?.shapes||[],photos=shapes.reduce((n,s)=>n+(s?.photos?.length||0),0);
    return {shapes:shapes.length,photos,pages:new Set(shapes.map(s=>Number(s?.page)||1))};
  }
  function replacementFrameCompatible(previous,probe){
    if(previous?.sourceType!==probe?.sourceType)return {ok:false,reason:'図面の種類（PDF／画像）が変わります。'};
    if(Number(previous?.pageCount||1)!==Number(probe?.pageCount||1))return {ok:false,reason:'ページ数が '+(previous?.pageCount||1)+' → '+probe.pageCount+' に変わります。'};
    if(previous?.sourceType==='pdf'){
      const records=replacementRecordSummary(previous);
      for(const page of records.pages){
        const a=previous?.pdfPageInfo?.[String(page)],b=probe?.pdfPageInfo?.[String(page)];
        if(!a||!b)continue;
        if(Math.abs(Number(a.wMm)-Number(b.wMm))>1||Math.abs(Number(a.hMm)-Number(b.hMm))>1)
          return {ok:false,reason:page+'ページ目の用紙寸法が変わります。'};
      }
    }else if(Number(previous?.width)>0&&Number(previous?.height)>0&&
      (Math.abs(Number(previous.width)-Number(probe?.width))>1||Math.abs(Number(previous.height)-Number(probe?.height))>1)){
      return {ok:false,reason:'画像サイズが変わります。'};
    }
    return {ok:true};
  }

  const pure={VERSION,normalizeEntry,normalizePageStates,pageState,isHidden,visiblePages,setHidden,nearestVisible,pageRecordStats,replacementRecordSummary,replacementFrameCompatible};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogPageManagement)return;

  let modal=null,thumbObserver=null,navigationQueued=false;
  const byId=id=>document.getElementById(id);

  function ensure(){
    if(!state||state.sourceType!=='pdf')return [];
    state.pageStates=normalizePageStates(state.pageStates,state.pageCount||1);
    return visiblePages(state.pageCount||1,state.pageStates);
  }
  function hidden(page){return isHidden(state?.pageStates,page);}
  function currentIndex(pages=ensure()){return pages.indexOf(Number(state.currentPage)||1);}
  function updateButtons(){
    const pages=ensure(),isPdf=state?.sourceType==='pdf',idx=currentIndex(pages);
    const box=byId('sentlogPageManagementActions'),manage=byId('sentlogPageManageBtn'),hide=byId('sentlogPageHideBtn');
    if(box)box.style.display=isPdf?'grid':'none';
    if(manage)manage.textContent='ページ管理'+((state?.pageStates&&Object.values(state.pageStates).some(x=>x?.hidden))?'（非表示あり）':'');
    if(hide)hide.disabled=!isPdf||pages.length<=1||idx<0;
  }
  function scheduleVisiblePage(){
    if(navigationQueued||state?.sourceType!=='pdf'||!pdfDoc||!hidden(state.currentPage))return;
    const target=nearestVisible(state.pageCount,state.pageStates,state.currentPage);
    if(!target)return;
    navigationQueued=true;
    queueMicrotask(async()=>{try{if(pdfDoc&&state.sourceType==='pdf'&&hidden(state.currentPage))await renderPdfPage(target);}catch(e){console.warn('page visibility navigation',e);}finally{navigationQueued=false;}});
  }

  const baseUpdatePageUI=updatePageUI;
  updatePageUI=function(){
    const result=baseUpdatePageUI.apply(this,arguments);
    if(state?.sourceType==='pdf'){
      const pages=ensure(),idx=currentIndex(pages);
      const indicator=byId('pageIndicator'),mobile=byId('mobilePageInfo');
      if(indicator)indicator.textContent=idx>=0?(idx+1)+' / '+pages.length:'— / '+pages.length;
      if(mobile)mobile.textContent=idx>=0?(idx+1)+'/'+pages.length+'頁':'';
      const prev=byId('prevPageBtn'),next=byId('nextPageBtn');
      if(prev)prev.disabled=idx<=0;
      if(next)next.disabled=idx<0||idx>=pages.length-1;
      scheduleVisiblePage();
    }
    updateButtons();
    return result;
  };

  const baseRenderPdfPage=renderPdfPage;
  renderPdfPage=async function(pageNo){
    if(state?.sourceType==='pdf'){
      ensure();
      if(hidden(pageNo)){
        const target=nearestVisible(state.pageCount,state.pageStates,pageNo);
        if(target)pageNo=target;
      }
    }
    return baseRenderPdfPage.call(this,pageNo);
  };

  async function go(delta){
    const pages=ensure(),idx=currentIndex(pages),target=pages[idx+delta];
    if(target)await renderPdfPage(target);
  }

  function warning(page){
    const s=pageRecordStats(state.shapes,page),lines=[];
    if(s.damage)lines.push('変状 '+s.damage+'件');
    if(s.dimensions)lines.push('寸法 '+s.dimensions+'件');
    if(s.memos)lines.push('メモ '+s.memos+'件');
    if(s.photos)lines.push('写真 '+s.photos+'枚');
    let text='元PDFの'+page+'ページ目をセントログ上で非表示にします。\n元PDFそのものは変更・削除されません。';
    if(lines.length)text+='\n\nこのページには '+lines.join('、')+' が登録されています。\nページを非表示にしても、これらの記録は削除されません。';
    text+='\n\nページを非表示にしますか？';
    return text;
  }

  async function hidePage(page){
    const pages=ensure();
    if(!pages.includes(Number(page)))return true;
    if(pages.length<=1){alert('最後の1ページは非表示にできません。図面自体が開けなくなるため、1ページ以上残してください。');return false;}
    if(!confirm(warning(page)))return false;
    const wasCurrent=Number(state.currentPage)===Number(page);
    state.pageStates=setHidden(state.pageStates,page,true);
    persist();
    if(wasCurrent){
      const target=nearestVisible(state.pageCount,state.pageStates,page);
      if(target)await renderPdfPage(target);
    }else updatePageUI();
    refreshManager();
    return true;
  }
  async function restorePage(page){
    ensure();
    state.pageStates=setHidden(state.pageStates,page,false);
    persist();updatePageUI();refreshManager();return true;
  }

  function closeManager(){
    if(thumbObserver){thumbObserver.disconnect();thumbObserver=null;}
    modal?.remove();modal=null;
  }
  async function renderThumb(canvas,page){
    if(!pdfDoc||canvas.dataset.loaded)return;
    canvas.dataset.loaded='1';
    try{
      const p=await pdfDoc.getPage(page),base=p.getViewport({scale:1});
      const scale=Math.min(0.28,140/Math.max(1,base.width));
      const viewport=p.getViewport({scale});
      canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height));
      await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    }catch(e){canvas.replaceWith(Object.assign(document.createElement('div'),{className:'sentlog-page-thumb-fallback',textContent:'プレビューなし'}));}
  }
  function observeThumb(canvas,page){
    if('IntersectionObserver' in root){
      if(!thumbObserver)thumbObserver=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){const page=Number(e.target.dataset.page);thumbObserver.unobserve(e.target);renderThumb(e.target,page);}}),{root:modal?.querySelector('.sentlog-page-list')||null,rootMargin:'160px'});
      canvas.dataset.page=String(page);thumbObserver.observe(canvas);
    }else renderThumb(canvas,page);
  }
  function rowFor(page){
    const row=document.createElement('div');row.className='sentlog-page-row';
    const canvas=document.createElement('canvas');canvas.className='sentlog-page-thumb';observeThumb(canvas,page);
    const info=document.createElement('div');info.className='sentlog-page-info';
    const title=document.createElement('strong');title.textContent='元PDF '+page+'ページ目';
    const stats=pageRecordStats(state.shapes,page),status=document.createElement('span');
    const records=[stats.damage&&'変状'+stats.damage,stats.dimensions&&'寸法'+stats.dimensions,stats.memos&&'メモ'+stats.memos,stats.photos&&'写真'+stats.photos].filter(Boolean).join(' / ');
    status.textContent=(hidden(page)?'非表示':'表示中')+(records?' ・ '+records:'');
    info.append(title,status);
    const action=document.createElement('button');action.type='button';action.textContent=hidden(page)?'元に戻す':'非表示';
    action.className=hidden(page)?'sentlog-page-restore':'sentlog-page-hide';
    action.disabled=!hidden(page)&&ensure().length<=1;
    action.onclick=async()=>{action.disabled=true;try{if(hidden(page))await restorePage(page);else if(!await hidePage(page))return;openManager();}finally{action.disabled=false;}};
    row.append(canvas,info,action);return row;
  }
  function openManager(){
    if(state?.sourceType!=='pdf')return;
    closeManager();
    modal=document.createElement('div');modal.className='modal-backdrop open sentlog-page-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    const card=document.createElement('div');card.className='modal-card';
    const head=document.createElement('div');head.className='modal-title';
    const title=document.createElement('h2');title.textContent='ページ管理';
    const close=document.createElement('button');close.type='button';close.textContent='閉じる';close.onclick=closeManager;head.append(title,close);
    const note=document.createElement('div');note.className='hint-box';note.textContent='不要なページはセントログ上で非表示にします。元PDF、PC保管PDF、ページ内の変状・写真・メモは削除されません。';
    const list=document.createElement('div');list.className='sentlog-page-list';
    for(let page=1;page<=Number(state.pageCount||1);page++)list.append(rowFor(page));
    card.append(head,note,list);modal.append(card);
    modal.onclick=e=>{if(e.target===modal)closeManager();};
    document.body.append(modal);
  }
  function refreshManager(){
    if(modal)openManager();
    updateButtons();
  }

  async function inspectReplacementFile(file){
    const isPDF=file.type==='application/pdf'||/\.pdf$/i.test(file.name||'');
    if(isPDF){
      if(!root.pdfjsLib)throw Error('PDF表示エンジンを読み込めません。');
      const buf=await file.arrayBuffer(),doc=await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise,info={};
      try{
        for(let n=1;n<=doc.numPages;n++){
          const page=await doc.getPage(n),intrinsic=normalizeRotation(page.rotate||0),v=page.getViewport({scale:1,rotation:intrinsic});
          info[String(n)]={wMm:v.width*25.4/72,hMm:v.height*25.4/72};
        }
        return {sourceType:'pdf',pageCount:doc.numPages,pdfPageInfo:info};
      }finally{try{await doc.destroy?.()}catch{}}
    }
    const url=URL.createObjectURL(file);
    try{
      const size=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(Error('画像を読み取れません。'));image.src=url;});
      return {sourceType:'image',pageCount:1,...size};
    }finally{URL.revokeObjectURL(url)}
  }
  async function replaceRecordedDrawing(file,input){
    const previous=JSON.parse(JSON.stringify(state)),summary=replacementRecordSummary(previous),probe=await inspectReplacementFile(file);
    const compatible=replacementFrameCompatible(previous,probe);
    if(!compatible.ok){
      alert('この図面には記録があるため、安全に差し替えできません。\n\n'+compatible.reason+'\n\n記録と写真は変更していません。新しいPDFは「この図面No.に追加」から別シートとして登録してください。');
      return;
    }
    if(!confirm('この図面には変状・記録 '+summary.shapes+'件、写真 '+summary.photos+'枚があります。\n\n記録・写真・縮尺設定を残したまま背景PDFだけ差し替えます。\n元の記録は削除しません。\n\n差し替えますか？'))return;
    const backupKey='sentlogReplaceBackupV1:'+activeDrawingId;
    root.SentlogRecords.setItem(backupKey,JSON.stringify({savedAt:new Date().toISOString(),drawingId:activeDrawingId,state:previous}));
    await root.SentlogRecords.flush();
    state.pageStates={};state.pdfPageInfo={};
    state.currentPage=Math.min(Math.max(1,Number(previous.currentPage)||1),probe.pageCount);
    selected=null;drawing=null;clearAllHistory();
    await openFile(file,true);
    rebuildNumberingState();render();renderSelectedPhotos();persist();
  }

  function install(){
    const controls=byId('pageControls');
    if(controls&&!byId('sentlogPageManagementActions')){
      const box=document.createElement('div');box.id='sentlogPageManagementActions';box.className='sentlog-page-actions';
      const manage=document.createElement('button');manage.id='sentlogPageManageBtn';manage.type='button';manage.textContent='ページ管理';manage.onclick=openManager;
      const hide=document.createElement('button');hide.id='sentlogPageHideBtn';hide.type='button';hide.textContent='このページを削除';hide.className='sentlog-page-hide-current';hide.onclick=()=>hidePage(state.currentPage);
      box.append(manage,hide);controls.insertAdjacentElement('afterend',box);
    }
    const prev=byId('prevPageBtn'),next=byId('nextPageBtn');
    if(prev)prev.onclick=()=>go(-1);
    if(next)next.onclick=()=>go(1);

    const input=byId('fileInput');
    if(input?.onchange&&!input.dataset.safeReplacementWrapped){
      const legacy=input.onchange;input.dataset.safeReplacementWrapped='1';
      input.onchange=async function(e){
        const file=e?.target?.files?.[0];
        if(!file)return;
        const summary=replacementRecordSummary(state);
        if(!summary.shapes&&!summary.photos)return legacy.call(this,e);
        try{await replaceRecordedDrawing(file,input);}
        catch(err){console.error('drawing replacement',err);alert('図面の差し替えを中止しました。記録と写真は変更していません。\n'+(err?.message||err));}
        finally{if(e?.target)e.target.value='';}
      };
    }

    if(!byId('sentlogPageManagementStyle')){
      const style=document.createElement('style');style.id='sentlogPageManagementStyle';
      style.textContent='.sentlog-page-actions{display:none;grid-template-columns:1fr 1fr;gap:8px}.sentlog-page-actions button{min-height:40px}.sentlog-page-hide-current,.sentlog-page-hide{color:#b91c1c;border-color:#fecaca;background:#fff}.sentlog-page-list{display:grid;gap:9px;margin-top:12px;max-height:62vh;overflow:auto;padding-right:2px}.sentlog-page-row{display:grid;grid-template-columns:92px minmax(0,1fr) 86px;gap:10px;align-items:center;border:1px solid #e5e7eb;border-radius:10px;padding:9px;background:#fff}.sentlog-page-thumb{width:92px;max-height:74px;object-fit:contain;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px}.sentlog-page-thumb-fallback{width:92px;height:58px;display:grid;place-items:center;background:#f3f4f6;color:#6b7280;font-size:10px;border-radius:6px}.sentlog-page-info{display:grid;gap:4px;min-width:0}.sentlog-page-info strong{font-size:13px}.sentlog-page-info span{font-size:11px;color:#6b7280;line-height:1.45}.sentlog-page-row button{min-height:38px;padding:7px;font-size:12px}@media(max-width:480px){.sentlog-page-row{grid-template-columns:72px minmax(0,1fr);}.sentlog-page-thumb,.sentlog-page-thumb-fallback{width:72px}.sentlog-page-row button{grid-column:1/-1}.sentlog-page-actions{grid-template-columns:1fr}.sentlog-page-actions button{min-height:44px}}';
      document.head.append(style);
    }
    updatePageUI();
  }

  root.SentlogPageManagement={...pure,open:openManager,hidePage,restorePage,visible:()=>ensure()};
  Promise.resolve(root.sentlogAppReady).catch(()=>{}).then(install);
})(typeof globalThis!=='undefined'?globalThis:this);

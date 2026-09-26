(function () {
  'use strict';
  const phone = /iPhone|iPod/i.test(navigator.userAgent) || (matchMedia('(max-width:480px) and (pointer:coarse)').matches && !/iPad/i.test(navigator.userAgent));
  if (phone) document.documentElement.classList.add('sentlog-phone');
  window.SENTLOG_BUILD = 'v1.21';
  const header = document.querySelector('header');
  if (header?.querySelector('.pill')) header.querySelector('.pill').textContent='試作版 v1.21';
  if (phone && header) {
    const measure = () => document.documentElement.style.setProperty('--sl-header-height', header.getBoundingClientRect().height + 'px');
    measure();
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(header);
  }
  ['projectsView','drawingsView'].forEach(id => {
    const host = document.querySelector('#' + id + ' .manager-shell');
    if (host) { const label=document.createElement('small'); label.className='sentlog-build'; label.textContent='セントログ v1.21 · PDF再取得・iPhoneページ送り対応'; host.appendChild(label); }
  });
  window.sentlogRestoreDrawingView = async function (id, file) {
    if (typeof activeDrawingId !== 'undefined' && activeDrawingId === id && typeof pdfDoc !== 'undefined' && !pdfDoc && typeof openFile === 'function') {
      await openFile(file, false);
    }
  };

  // Move the existing page controls, rather than create a second set of page state.
  // Only the phone layout changes; desktop and tablet keep their sidebar controls.
  function installPhonePager() {
    const controls=document.getElementById('pageControls');
    const stage=document.getElementById('stageWrap');
    const prev=document.getElementById('prevPageBtn');
    const next=document.getElementById('nextPageBtn');
    const indicator=document.getElementById('pageIndicator');
    const loader=document.getElementById('loading');
    if (!controls || !stage || !prev || !next || !indicator || controls.dataset.phonePager) return;
    controls.dataset.phonePager='true';
    controls.classList.add('phone-page-controls');
    controls.setAttribute('role','navigation');
    controls.setAttribute('aria-label','PDFのページ切り替え');
    stage.after(controls);
    prev.type='button'; next.type='button';
    prev.textContent='◀ 前のページ'; next.textContent='次のページ ▶';
    prev.setAttribute('aria-label','PDFの前のページ');
    next.setAttribute('aria-label','PDFの次のページ');
    indicator.setAttribute('role','status');
    indicator.setAttribute('aria-live','polite');
    indicator.setAttribute('aria-atomic','true');
    let navigating=false;
    const isLoading=()=>!!loader && loader.style.display==='grid';
    function updateAvailability() {
      const ready=typeof state!=='undefined' && state.sourceType==='pdf' && typeof pdfDoc!=='undefined' && !!pdfDoc;
      const busy=navigating || isLoading();
      const disablePrev=!ready || busy || state.currentPage<=1;
      const disableNext=!ready || busy || state.currentPage>=state.pageCount;
      // Change attributes only when necessary, to keep observer notifications finite.
      if (prev.disabled!==disablePrev) prev.disabled=disablePrev;
      if (next.disabled!==disableNext) next.disabled=disableNext;
      controls.setAttribute('aria-busy',busy?'true':'false');
    }
    // Reserve the pager's height before setupStage()/fit() renders a newly opened PDF.
    if (typeof openFile==='function') {
      const originalOpenFile=openFile;
      openFile=async function(file) {
        const isPdf=file && (file.type==='application/pdf' || /\.pdf$/i.test(file.name||''));
        controls.style.display=isPdf?'flex':'none';
        return originalOpenFile.apply(this,arguments);
      };
    }
    async function turnPage(step) {
      if (navigating || isLoading() || typeof pdfDoc==='undefined' || !pdfDoc || state.sourceType!=='pdf') return;
      const page=Number(state.currentPage)+step;
      if (page<1 || page>Number(state.pageCount)) return;
      navigating=true; updateAvailability();
      document.getElementById('sidebar')?.classList.remove('open');
      document.getElementById('inspector')?.classList.remove('open');
      try {
        await renderPdfPage(page);
      } catch(error) {
        console.error('Sentlog page navigation',error);
        alert('ページを表示できませんでした。もう一度ページを切り替えてください。');
      } finally {
        navigating=false; updateAvailability();
      }
    }
    prev.onclick=()=>turnPage(-1);
    next.onclick=()=>turnPage(1);
    const observer=new MutationObserver(updateAvailability);
    observer.observe(controls,{attributes:true,attributeFilter:['style','disabled'],childList:true,subtree:true});
    if (loader) observer.observe(loader,{attributes:true,attributeFilter:['style']});
    updateAvailability();
  }
  if (phone) installPhonePager();

  // Refresh inside the same Home Screen app, without deleting local files or login data.
  const attach = () => {
    const box = document.getElementById('sentlogCloudMsg');
    if (!box || document.getElementById('sentlogReloadDisplay')) return;
    const note=document.createElement('small'); note.className='sentlog-build'; note.textContent='表示バージョン v1.21';
    const btn=document.createElement('button'); btn.id='sentlogReloadDisplay'; btn.type='button'; btn.textContent='この画面を更新';
    btn.onclick=async()=>{
      if (!navigator.onLine) { note.textContent='通信できる場所で更新してください。'; return; }
      if (!confirm('入力や描画を終えてから更新してください。保存済みの案件・PDF・写真は削除しません。')) return;
      if (typeof persist==='function' && typeof activeDrawingId!=='undefined' && activeDrawingId) persist();
      btn.disabled=true;
      try { const reg=await navigator.serviceWorker?.getRegistration(); if(reg) await reg.update(); } catch (_) {}
      location.reload();
    };
    box.after(note,btn);
  };
  attach(); const timer=setInterval(attach,500); setTimeout(()=>clearInterval(timer),12000);
})();

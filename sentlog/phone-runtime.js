(function () {
  'use strict';
  const phone = /iPhone|iPod/i.test(navigator.userAgent) || (matchMedia('(max-width:480px) and (pointer:coarse)').matches && !/iPad/i.test(navigator.userAgent));
  if (phone) document.documentElement.classList.add('sentlog-phone');
  window.SENTLOG_BUILD = 'v1.19';
  const header = document.querySelector('header');
  if (header?.querySelector('.pill')) header.querySelector('.pill').textContent='試作版 v1.19';
  if (phone && header) {
    const measure = () => document.documentElement.style.setProperty('--sl-header-height', header.getBoundingClientRect().height + 'px');
    measure();
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(header);
  }
  ['projectsView','drawingsView'].forEach(id => {
    const host = document.querySelector('#' + id + ' .manager-shell');
    if (host) { const label=document.createElement('small'); label.className='sentlog-build'; label.textContent='セントログ v1.19 · PDF再取得対応'; host.appendChild(label); }
  });
  window.sentlogRestoreDrawingView = async function (id, file) {
    if (typeof activeDrawingId !== 'undefined' && activeDrawingId === id && typeof pdfDoc !== 'undefined' && !pdfDoc && typeof openFile === 'function') {
      await openFile(file, false);
    }
  };
  // Refresh inside the same Home Screen app, without deleting local files or login data.
  const attach = () => {
    const box = document.getElementById('sentlogCloudMsg');
    if (!box || document.getElementById('sentlogReloadDisplay')) return;
    const note=document.createElement('small'); note.className='sentlog-build'; note.textContent='表示バージョン v1.19';
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

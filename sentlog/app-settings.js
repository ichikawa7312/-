/* v1.29: move the existing backup controls into a secondary settings dialog. */
(function () {
  'use strict';
  const shell=document.querySelector('#projectsView .manager-shell');
  const exportButton=document.getElementById('exportBackupBtn');
  const importButton=document.getElementById('importBackupBtn');
  const input=document.getElementById('importBackupInput');
  const oldBar=exportButton?.closest('.manager-subbar');
  if(!shell || !oldBar || !importButton || !input ||
     !oldBar.contains(importButton) || !oldBar.contains(input) ||
     document.getElementById('sentlogSettingsModal'))return;

  const style=document.createElement('style');
  style.id='sentlogSettingsStyle';
  style.textContent=`
#sentlogSettingsFooter{display:flex;justify-content:flex-end;margin-top:16px;}
#sentlogSettingsBtn{min-width:56px;min-height:44px;padding:8px 12px;border:1px solid transparent;background:transparent;color:#4b5563;font-size:13px;font-weight:500;touch-action:manipulation;}
#sentlogSettingsBtn:hover{background:#e5e7eb;}
#sentlogSettingsBtn:focus-visible,#sentlogSettingsModal :focus-visible{outline:2px solid #2563eb;outline-offset:3px;}
#sentlogSettingsModal{z-index:70;padding:calc(16px + env(safe-area-inset-top,0px)) calc(16px + env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) calc(16px + env(safe-area-inset-left,0px));}
#sentlogSettingsModal .modal-card{width:min(460px,100%);max-height:100%;overflow-y:auto;overscroll-behavior:contain;}
#sentlogSettingsModal .modal-title{align-items:center;margin-bottom:16px;}
#sentlogSettingsModal h2{font-size:18px;margin:0;}
#sentlogSettingsModal button{min-height:44px;touch-action:manipulation;}
#sentlogBackupSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;}
#sentlogBackupSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer;touch-action:manipulation;}
#sentlogBackupSection p{font-size:13px;line-height:1.65;color:#4b5563;margin:0 0 10px;overflow-wrap:anywhere;}
#sentlogBackupSection .sl-backup-action{padding:12px 0 16px;border-top:1px solid #e5e7eb;}
#sentlogBackupSection .sl-backup-action button{width:100%;font-size:13px;}
#sentlogBackupSection .sl-backup-warning{color:#92400e;}
`;
  document.head.appendChild(style);

  const footer=document.createElement('div');footer.id='sentlogSettingsFooter';
  const trigger=document.createElement('button');
  trigger.id='sentlogSettingsBtn';trigger.type='button';trigger.textContent='設定';
  trigger.setAttribute('aria-haspopup','dialog');
  trigger.setAttribute('aria-controls','sentlogSettingsModal');
  footer.appendChild(trigger);
  const build=shell.querySelector('.sentlog-build');
  if(build)build.before(footer);else shell.appendChild(footer);

  const overlay=document.createElement('div');
  overlay.id='sentlogSettingsModal';overlay.className='modal-backdrop';
  overlay.setAttribute('aria-hidden','true');
  overlay.innerHTML=`<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="sentlogSettingsTitle" tabindex="-1">
    <div class="modal-title"><h2 id="sentlogSettingsTitle">設定</h2><button id="sentlogSettingsClose" type="button">閉じる</button></div>
    <details id="sentlogBackupSection">
      <summary>バックアップ</summary>
      <div class="sl-backup-action" id="sentlogBackupExportSlot">
        <p id="sentlogBackupExportHelp">この端末に保存済みの案件・図面・変状・写真を、控えのファイルにまとめます。未受信のPDFや写真は含まれません。</p>
      </div>
      <div class="sl-backup-action" id="sentlogBackupImportSlot">
        <p id="sentlogBackupImportHelp" class="sl-backup-warning">復旧・機種変更のときに使います。現在この端末にある案件データは、読み込むバックアップの内容で丸ごと置き換わります。</p>
      </div>
    </details>
  </div>`;
  document.body.appendChild(overlay);
  // Move, do not clone: keep the original element IDs, event handlers and file picker.
  exportButton.type='button';importButton.type='button';
  exportButton.setAttribute('aria-describedby','sentlogBackupExportHelp');
  importButton.setAttribute('aria-describedby','sentlogBackupImportHelp');
  overlay.querySelector('#sentlogBackupExportSlot').appendChild(exportButton);
  overlay.querySelector('#sentlogBackupImportSlot').append(importButton,input);
  oldBar.remove();

  const closeButton=overlay.querySelector('#sentlogSettingsClose');
  const backup=overlay.querySelector('#sentlogBackupSection');
  const card=overlay.querySelector('[role="dialog"]');
  let opened=false,previousFocus=null;
  const inertState=new Map();
  function open(){
    if(opened)return;
    previousFocus=document.activeElement;opened=true;
    backup.open=false;
    overlay.classList.add('open');overlay.setAttribute('aria-hidden','false');
    // Keep keyboard/screen-reader navigation inside settings, not the project cards below it.
    for(const element of document.body.children){
      if(element===overlay || element.id==='sentlogStorageWarning' || /^(SCRIPT|STYLE)$/.test(element.tagName))continue;
      inertState.set(element,element.inert);element.inert=true;
    }
    closeButton.focus({preventScroll:true});
  }
  function close(){
    if(!opened)return;
    opened=false;overlay.classList.remove('open');overlay.setAttribute('aria-hidden','true');
    for(const [element,value] of inertState)element.inert=value;
    inertState.clear();
    (previousFocus?.isConnected?previousFocus:trigger).focus({preventScroll:true});
  }
  trigger.onclick=open;closeButton.onclick=close;
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  overlay.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key!=='Tab')return;
    const targets=[...card.querySelectorAll('button,input,summary,[href],[tabindex]')]
      .filter(el=>!el.disabled && !el.hidden && el.tabIndex>=0 && el.getClientRects().length);
    const first=targets[0]||closeButton,last=targets.at(-1)||closeButton;
    if(event.shiftKey && (document.activeElement===first || document.activeElement===card)){
      event.preventDefault();last.focus();
    }else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
  });
})();

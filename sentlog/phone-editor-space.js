/* sentlog-phone-editor-space-v1
 * Presentation only: keep the original controls and their listeners. No record,
 * file, history, synchronization or drawing-coordinate changes live here.
 */
(function(root){
  'use strict';
  const doc=root.document;
  if(!doc||root.SentlogPhoneEditorSpace)return;
  const html=doc.documentElement,$=id=>doc.getElementById(id);
  const api={version:'v1.99',enabled:html.classList.contains('sentlog-phone'),installed:false};
  root.SentlogPhoneEditorSpace=api;
  if(!api.enabled)return;

  function install(){
    if(api.installed)return;
    const editor=$('editorView'),bar=$('sentlogDrawingToolbar');
    const row=bar?.querySelector('.sl-memo-switch-row');
    const history=bar?.querySelector('.sl-tool-history');
    const pageActions=$('sentlogPageManagementActions');
    const extraIds=['memoVisibilityBtn','memoEditBtn','memoPdfBtn','slAutoTraceButton','slDisplayFilterBtn'];
    const extras=extraIds.map($);
    if(!editor||!row||!history||!pageActions||extras.some(el=>!el)){
      console.warn('Phone editor controls are not ready; retaining the existing layout.');
      return;
    }

    const make=(tag,id,text)=>{
      const node=doc.createElement(tag);if(id)node.id=id;
      if(text!==undefined)node.textContent=text;return node;
    };
    const more=make('button','sentlogPhoneMoreBtn');more.type='button';
    more.setAttribute('aria-label','その他の操作');more.setAttribute('aria-haspopup','dialog');
    more.setAttribute('aria-controls','sentlogPhoneMorePanel');more.setAttribute('aria-expanded','false');
    const dots=make('span',null,'⋯');dots.setAttribute('aria-hidden','true');
    const moreLabel=make('span','sentlogPhoneMoreLabel','その他');moreLabel.setAttribute('aria-hidden','true');
    more.append(dots,moreLabel);

    const panel=make('dialog','sentlogPhoneMorePanel');
    panel.setAttribute('aria-labelledby','sentlogPhoneMoreTitle');panel.setAttribute('aria-modal','true');
    const panelHead=make('div','sentlogPhoneMoreHead');
    const title=make('h2','sentlogPhoneMoreTitle','その他の操作');
    const closeButton=make('button','sentlogPhoneMoreClose','閉じる');closeButton.type='button';
    panelHead.append(title,closeButton);
    const extraGroup=make('div','sentlogPhoneExtraActions');
    extraGroup.setAttribute('role','group');extraGroup.setAttribute('aria-label','表示と描写');
    extraGroup.append(...extras,...['dxfExportBtn','dxfInfoBtn','dxfRasterBtn'].map($).filter(Boolean));
    const filterStatus=$('slDisplayFilterStatus');
    const pageTitle=make('h3','sentlogPhonePageTitle','ページの操作');
    panel.append(panelHead,extraGroup);
    if(filterStatus)panel.append(filterStatus);
    panel.append(pageTitle,pageActions);doc.body.append(panel);
    row.append(history,more);

    const style=make('style','sentlogPhoneEditorSpaceStyle');
    style.textContent=`
html.sentlog-phone.sl-phone-editor{--sl-handle:44px}
html.sentlog-phone.sl-phone-editor header{display:grid!important;grid-template-columns:auto minmax(0,1fr) 44px auto!important;grid-template-rows:44px!important;gap:4px!important;min-height:0!important;padding:calc(7px + max(54px,env(safe-area-inset-top,0px))) max(8px,env(safe-area-inset-right,0px)) 7px max(8px,env(safe-area-inset-left,0px))!important}
html.sentlog-phone.sl-phone-editor #navBackBtn{grid-row:1;grid-column:1;height:44px;min-width:44px;padding:0 7px;font-size:12px}
html.sentlog-phone.sl-phone-editor header #headerTitle{grid-row:1;grid-column:2;align-self:start;min-width:0;max-width:100%!important;margin-top:4px;padding:0!important;font-size:12px!important;line-height:18px}
html.sentlog-phone.sl-phone-editor header #sentlogToolStatus{grid-row:1;grid-column:2;align-self:end;justify-self:start;min-width:0;max-width:100%;margin:0 0 4px;padding:0;border:0;border-radius:0;font-size:10px;line-height:14px;color:#cbd5e1}
html.sentlog-phone.sl-phone-editor #mobileSidebarBtn{grid-row:1;grid-column:3;min-width:44px;width:44px;height:44px;padding:0;font-size:12px}
html.sentlog-phone.sl-phone-editor #slHomeHeaderTools,html.sentlog-phone.sl-phone-editor #slHomeHeaderLeft{display:contents!important}
html.sentlog-phone.sl-phone-editor header #sentlogCloudStatus{grid-row:1;grid-column:4;position:relative;display:grid!important;grid-template-columns:12px minmax(0,1fr);gap:4px;width:80px!important;min-width:80px!important;height:44px!important;padding:4px!important;font-size:10px!important;line-height:1.2;justify-self:end}
html.sentlog-phone.sl-phone-editor #sentlogCloudStatus .sl-sync-spinner{position:absolute;right:3px;top:3px;width:8px;height:8px}
html.sentlog-phone.sl-phone-editor #editorView{height:auto!important;flex:1 1 0;min-height:0;grid-template-columns:minmax(0,1fr)}
html.sentlog-phone.sl-phone-editor #editorView>.workspace{box-sizing:border-box;height:100%!important;min-height:0}
html.sentlog-phone.sl-phone-editor #stageWrap{padding:0;margin:0 max(4px,env(safe-area-inset-right,0px)) 4px max(4px,env(safe-area-inset-left,0px))}
html.sentlog-phone #sentlogDrawingToolbar{display:flex;flex-wrap:wrap;gap:4px!important;padding:4px max(8px,env(safe-area-inset-right,0px)) 4px max(8px,env(safe-area-inset-left,0px))!important;overflow:visible}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-switch-row{flex:1 1 100%;width:100%;gap:4px;min-height:44px}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-switch{margin-right:auto;flex:0 1 auto;min-width:0}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-switch button{min-width:44px;min-height:44px;height:44px;padding:0 6px;font-size:11px;flex:1 1 auto}
html.sentlog-phone #sentlogDrawingToolbar .sl-tool-history{flex:0 0 auto;gap:4px!important}
html.sentlog-phone #sentlogDrawingToolbar .sl-tool-history:before{content:none}
html.sentlog-phone #sentlogDrawingToolbar>.sl-tool-group,html.sentlog-phone #sentlogDrawingToolbar>.sl-memo-tools{display:flex;flex:1 1 100%;flex-wrap:nowrap;justify-content:space-between;gap:4px!important;min-width:0;max-width:100%}
html.sentlog-phone #sentlogDrawingToolbar .sl-tool-button,html.sentlog-phone #sentlogDrawingToolbar .sl-memo-tool{box-sizing:border-box;width:44px!important;min-width:44px!important;height:44px!important;min-height:44px!important;flex:0 0 44px!important;padding:0!important;gap:0}
html.sentlog-phone #sentlogDrawingToolbar .sl-tool-label{display:none}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-tool{flex-direction:column}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-tool span{font-size:9px}
html.sentlog-phone #sentlogDrawingToolbar #sentlogPhoneMoreBtn{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:0;width:48px;min-width:48px;height:44px;min-height:44px;flex:0 0 48px;padding:0;border-radius:8px;font-size:24px;line-height:18px}
html.sentlog-phone #sentlogDrawingToolbar #sentlogPhoneMoreLabel{font-size:10px;line-height:14px}
html.sentlog-phone #sentlogDrawingToolbar #sentlogPhoneMoreBtn.is-filtered{background:#fff7ed;color:#9a3412;border-color:#fb923c}
html.sentlog-phone #sentlogDrawingToolbar [hidden]{display:none!important}
html.sentlog-phone.sl-phone-editor #pageControls.phone-page-controls{min-height:52px;padding:4px max(8px,env(safe-area-inset-right,0px)) 4px max(8px,env(safe-area-inset-left,0px));gap:4px;flex-wrap:nowrap}
html.sentlog-phone.sl-phone-editor .phone-page-controls .page-indicator{flex:0 0 52px;min-width:52px;padding:0}
html.sentlog-phone.sl-phone-editor .phone-page-controls button{min-height:44px;height:44px}
#sentlogPhoneMorePanel{box-sizing:border-box;position:fixed;inset:max(8px,env(safe-area-inset-top,0px)) max(8px,env(safe-area-inset-right,0px)) max(8px,env(safe-area-inset-bottom,0px)) max(8px,env(safe-area-inset-left,0px));margin:auto;width:min(360px,calc(100vw - 32px));height:max-content;max-height:calc(100dvh - max(8px,env(safe-area-inset-top,0px)) - max(8px,env(safe-area-inset-bottom,0px)));overflow:auto;overscroll-behavior:contain;padding:12px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;color:#172033;box-shadow:0 12px 40px #0004;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#sentlogPhoneMorePanel:not([open]),#sentlogPhoneMorePanel [hidden]{display:none!important}
#sentlogPhoneMorePanel::backdrop{background:rgba(15,23,42,.32)}
#sentlogPhoneMoreHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
#sentlogPhoneMoreTitle{margin:0;font-size:16px}
#sentlogPhoneMorePanel button{box-sizing:border-box;min-height:44px;min-width:44px;padding:7px 8px;font-size:12px;line-height:1.3;touch-action:manipulation}
#sentlogPhoneMorePanel #sentlogPhoneMoreClose{flex:0 0 auto}
#sentlogPhoneExtraActions,#sentlogPhoneMorePanel #sentlogPageManagementActions{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
#sentlogPhoneExtraActions{display:grid}
#sentlogPhoneMorePanel #sentlogPhoneExtraActions button{width:100%!important;min-width:0!important;max-width:100%;height:auto!important;min-height:44px!important;padding:7px 8px!important;font-size:12px!important;white-space:normal!important}
#sentlogPhonePageTitle{margin:14px 0 8px;font-size:12px;color:#64748b}
#sentlogPhoneMorePanel #slDisplayFilterStatus{display:block;margin-top:8px;font-size:12px;line-height:1.5;white-space:normal;color:#9a3412}
#sentlogPhoneMorePanel #slDisplayFilterStatus:empty{display:none}
#sentlogPhoneMorePanel button:focus-visible,html.sentlog-phone #sentlogPhoneMoreBtn:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
@media(orientation:landscape) and (min-width:650px){
html.sentlog-phone #sentlogDrawingToolbar{flex-wrap:nowrap;gap:8px!important}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-switch-row{flex:0 0 auto;width:auto;gap:4px}
html.sentlog-phone #sentlogDrawingToolbar .sl-memo-switch{margin-right:4px}
html.sentlog-phone #sentlogDrawingToolbar>.sl-tool-group,html.sentlog-phone #sentlogDrawingToolbar>.sl-memo-tools{flex:1 1 auto;justify-content:flex-end}
}
`;
    doc.head.append(style);

    function close(){
      if(panel.open)panel.close();more.setAttribute('aria-expanded','false');
    }
    function updateFilter(){
      const filtered=!!filterStatus?.textContent.trim();
      more.classList.toggle('is-filtered',filtered);
      moreLabel.textContent=filtered?'絞込中':'その他';
      more.setAttribute('aria-label',filtered?'その他の操作、表示を絞り込み中（記録は残っています）':'その他の操作');
    }
    function updatePageTitle(){pageTitle.hidden=pageActions.style.display==='none';}
    function refreshView(){
      const editing=!editor.classList.contains('hidden');
      html.classList.toggle('sl-phone-editor',editing);
      if(!editing)close();
      root.SentlogHomeLayout?.measureHeader();
    }
    more.addEventListener('click',()=>{
      if(panel.open){close();return;}
      updatePageTitle();updateFilter();panel.showModal();
      more.setAttribute('aria-expanded','true');closeButton.focus({preventScroll:true});
    });
    closeButton.addEventListener('click',close);
    panel.addEventListener('close',()=>more.setAttribute('aria-expanded','false'));
    panel.addEventListener('cancel',e=>{e.preventDefault();close();});
    panel.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}
    });
    // Close synchronously BEFORE the original action. A camera/file input still
    // runs in the same trusted click, and existing dialogs never sit behind ours.
    panel.addEventListener('click',e=>{
      const button=e.target.closest?.('button');
      if(button&&button!==closeButton&&!button.disabled)close();
    },true);
    const outside=e=>{
      const r=panel.getBoundingClientRect();
      return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;
    };
    let backdropPress=false;
    panel.addEventListener('pointerdown',e=>{backdropPress=e.target===panel&&outside(e);});
    panel.addEventListener('click',e=>{
      if(backdropPress&&e.target===panel&&outside(e))close();backdropPress=false;
    });
    panel.addEventListener('pointercancel',()=>{backdropPress=false;});

    // Apply the editor-only header before the original file loading/fit path
    // measures its stage; opening this menu itself never calls fit or render.
    for(const name of ['showEditor','showProjects','showDrawings']){
      const original=root[name];
      if(typeof original==='function')root[name]=function(){
        close();const result=original.apply(this,arguments);refreshView();return result;
      };
    }
    new MutationObserver(refreshView).observe(editor,{attributes:true,attributeFilter:['class']});
    new MutationObserver(updatePageTitle).observe(pageActions,{attributes:true,attributeFilter:['style']});
    if(filterStatus)new MutationObserver(updateFilter).observe(filterStatus,{childList:true,characterData:true,subtree:true});
    root.addEventListener('resize',close);
    root.addEventListener('orientationchange',close);
    root.visualViewport?.addEventListener('resize',close);
    doc.addEventListener('visibilitychange',()=>{if(doc.hidden)close();});
    api.installed=true;refreshView();updatePageTitle();updateFilter();
  }
  Promise.resolve(root.sentlogAppReady).then(()=>queueMicrotask(install)).catch(e=>console.error('Phone editor layout setup',e));
})(typeof window==='object'?window:globalThis);

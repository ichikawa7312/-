/* Sentlog v1.70: add a new drawing directly from the editor sidebar.
 * Reuses the existing drawingAddInput/createDrawingFromFile flow, so the new drawing
 * belongs to the same project and the current drawing is never replaced.
 */
(function(root){
  'use strict';
  if(!root.document||root.SentlogEditorDrawingAdd)return;

  function install(){
    const replaceInput=document.getElementById('fileInput');
    const addInput=document.getElementById('drawingAddInput');
    if(!replaceInput||!addInput||document.getElementById('editorDrawingAddBtn'))return false;
    const replaceControl=replaceInput.previousElementSibling;
    if(!replaceControl)return false;

    const btn=document.createElement('button');
    btn.id='editorDrawingAddBtn';
    btn.type='button';
    btn.className='btn editor-drawing-add';
    btn.textContent='＋ 図面を追加';
    btn.setAttribute('aria-label','この案件に新しい図面を追加');
    btn.title='現在の図面は残したまま、この案件に別のPDF・図面を追加します';
    btn.addEventListener('click',()=>{
      if(typeof currentView!=='undefined'&&currentView!=='editor')return;
      if(typeof activeProjectId==='undefined'||!activeProjectId)return;
      // Persist the current drawing synchronously into the record mirror before
      // the file picker changes activeDrawingId. The normal save queue then commits it.
      if(typeof activeDrawingId!=='undefined'&&activeDrawingId&&typeof persist==='function')persist();
      addInput.click();
    });

    replaceControl.insertAdjacentElement('beforebegin',btn);

    const style=document.createElement('style');
    style.id='editorDrawingAddStyle';
    style.textContent='.editor-drawing-add{width:100%;background:#111827;color:#fff;border-color:#111827;text-align:center}.editor-drawing-add:active{transform:translateY(1px)}';
    document.head.appendChild(style);
    return true;
  }

  const api={version:'v1.70',install};
  root.SentlogEditorDrawingAdd=api;
  if(!install())setTimeout(install,0);
})(typeof globalThis!=='undefined'?globalThis:this);

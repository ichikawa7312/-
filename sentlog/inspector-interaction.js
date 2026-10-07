/* v1.24: selection and label movement never open the mobile inspector. */
(function () {
  'use strict';
  const panel=document.getElementById('inspector');
  const handle=document.getElementById('mobileHandle');
  if(!panel || !handle || handle.dataset.manualInspector==='true')return;
  handle.dataset.manualInspector='true';

  function updateHandle(){
    const shape=state.shapes.find(s=>s.id===selected);
    const name=shape?(shape.autoLabel || shape.no || autoLabelFor(shape)):'';
    const title=name?name+'の情報':'変状情報';
    const expanded=panel.classList.contains('open');
    const text=title+(expanded?' ▼':' ▲');
    if(handle.textContent!==text)handle.textContent=text;
    handle.setAttribute('aria-expanded',String(expanded));
    handle.setAttribute('aria-label',title+'を'+(expanded?'閉じる':'開く'));
  }

  // Keep the same fields/selection logic as the editor, without opening the sheet.
  // Existing hit targets, addShape(), undo/redo, and sync all call this function.
  selectShape=function(id){
    const s=state.shapes.find(x=>x.id===id);
    if(!s)return;
    selected=id;
    $('damageType').value=s.type||'腐食';
    $('globalNo').value='No.'+formatGlobalNo(s.globalNo);
    $('typeNo').value=s.autoLabel||autoLabelFor(s);
    $('damageNo').value=s.no||'';
    $('member').value=s.member||'';
    $('lineWidth').value=String(s.strokeWidth||1.2);
    $('memo').value=s.memo||'';
    setSelectionControls();updateMeasureResult();render();renderSelectedPhotos();
  };

  const originalSelectionControls=setSelectionControls;
  setSelectionControls=function(){
    const result=originalSelectionControls.apply(this,arguments);
    updateHandle();
    return result;
  };

  // This handle is the only control that opens the collapsed information sheet.
  // A manually opened sheet stays open when the selected damage changes.
  handle.setAttribute('role','button');
  handle.setAttribute('tabindex','0');
  handle.setAttribute('aria-controls','inspector');
  handle.style.touchAction='manipulation';
  handle.onclick=()=>{panel.classList.toggle('open');updateHandle();};
  handle.onkeydown=event=>{
    if(event.key!=='Enter' && event.key!==' ')return;
    event.preventDefault();
    if(!event.repeat)handle.click();
  };

  // Page navigation/sync can close or restore the sheet without clicking its handle.
  new MutationObserver(updateHandle).observe(panel,{attributes:true,attributeFilter:['class']});
  updateHandle();
})();

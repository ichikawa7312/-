/* SentlogDimensionText v1.83: one screen-size policy for all dimension labels.
 * Never derive text size from a record's creation zoom or change saved data. */
(function(root){
'use strict';
function fontSize(){
  const zoom=Math.max(.001,Number(scale)||1);
  const label=typeof labelFontSize==='function'?Number(labelFontSize()):12/zoom;
  return Math.max(8.5/zoom,(Number.isFinite(label)&&label>0?label:12/zoom)*.8);
}
root.SentlogDimensionText={fontSize};
})(typeof window==='object'?window:globalThis);

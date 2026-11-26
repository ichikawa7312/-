/* Read-only photo presentation. Canonical collaboration/SQL order stays intact. */
(function(root){
  'use strict';
  const VERSION='20261126-camera-order-return-1';
  function key(photo,index){
    const order=photo?.captureDisplayOrder;
    if(order&&Number.isFinite(order.at)&&order.at>=0&&
      typeof order.batch==='string'&&order.batch&&
      Number.isSafeInteger(order.index)&&order.index>=0){
      return {photo,index,at:order.at,batch:order.batch,position:order.index};
    }
    const at=photo?.createdAt;
    return {photo,index,at:Number.isFinite(at)&&at>0?at:null,batch:'',position:0};
  }
  function ordered(photos){
    if(!Array.isArray(photos))return [];
    // Undated legacy photos retain their existing relative order before dated
    // additions. Never invent a date from an ID/name or rewrite saved metadata.
    // Equal legacy dates also retain their supplied order. New batches carry an
    // immutable reservation index, so a delayed retry cannot change their order.
    return photos.map(key).sort((a,b)=>{
      if(a.at===null||b.at===null)return a.at===b.at?a.index-b.index:a.at===null?-1:1;
      if(a.at!==b.at)return a.at-b.at;
      if(a.batch!==b.batch)return a.batch<b.batch?-1:1;
      return a.position-b.position||a.index-b.index;
    }).map(item=>item.photo);
  }
  const api={version:VERSION,ordered};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SentlogPhotoDisplayOrder=api;
})(typeof window==='object'?window:globalThis);

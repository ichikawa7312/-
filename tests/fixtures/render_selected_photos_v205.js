async function renderSelectedPhotos(){
  const seq=++photoRenderSeq;revokePhotoThumbUrls();const grid=$('photoGrid'),emptyEl=$('photoEmpty'),count=$('photoCount');if(!grid)return;grid.innerHTML='';const s=selectedShape();const photos=window.SentlogPhotoDisplayOrder?.ordered(s?.photos||[])||(s?.photos||[]).slice();count.textContent=`${photos.length}枚`;
  $('cameraBtn').disabled=!s;$('photoAddBtn').disabled=!s;
  if(!s){emptyEl.textContent='変状を選択すると写真を登録できます。';emptyEl.classList.remove('hidden');return}
  if(!photos.length){emptyEl.textContent='写真はまだありません。';emptyEl.classList.remove('hidden');return}emptyEl.classList.add('hidden');
  for(const meta of photos){
    if(seq!==photoRenderSeq)return;const item=document.createElement('div');item.className='photo-thumb';item.title=meta.name||'変状写真';const img=document.createElement('img');img.alt=meta.name||'変状写真';const del=document.createElement('button');del.type='button';del.className='photo-del';del.textContent='×';del.title='この写真を外す';del.onclick=e=>{e.stopPropagation();removeSelectedPhoto(meta.id)};item.onclick=()=>openPhotoViewer(meta.id,meta.name);item.append(img,del);grid.appendChild(item);
    try{const blob=await getPhotoBlob(meta.id);if(seq!==photoRenderSeq)return;if(blob){const url=URL.createObjectURL(blob);photoThumbUrls.push(url);img.src=url}else{img.alt='写真データなし'}}catch{img.alt='読込エラー'}
  }
}

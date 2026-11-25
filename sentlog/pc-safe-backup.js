/* PC backup file preservation. Never overwrite a different nonempty file.
 * New files use content-versioned names; historical exact copies are reused. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.SentlogPcSafeBackup=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const error=(message,code)=>Object.assign(Error(message),{code});
 function versionedName(name,asset){
  const id=String(asset?.id||'').toLowerCase(),sha=String(asset?.sha256||'').toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||!/^[0-9a-f]{64}$/.test(sha))
   throw error('保存対象の識別情報が不正です。','PC_BACKUP_ID');
  const match=String(name).match(/^(.*)(\.[a-z0-9]{1,12})$/i);
  const stem=(match?match[1]:String(name)).slice(0,64).replace(/[. ]+$/g,'')||'file';
  return stem+'__'+id.replace(/-/g,'')+'_'+sha.slice(0,16)+(match?match[2]:'');
 }
 async function existing(dir,name){
  try{const handle=await dir.getFileHandle(name);return {handle,file:await handle.getFile()};}
  catch(e){if(e?.name==='NotFoundError')return null;throw e;}
 }
 async function save({directory,preferredName,asset,download,hash,locks,assertCurrent=()=>{}}){
  const size=Number(asset?.byte_size),sha=String(asset?.sha256||'').toLowerCase();
  if(!Number.isSafeInteger(size)||size<=0||!/^[0-9a-f]{64}$/.test(sha))
   throw error('保存対象のサイズ・照合値が不正です。','PC_BACKUP_ID');
  if(!locks||typeof locks.request!=='function')throw error('PC保管の排他制御を利用できません。EdgeまたはChromeで開いてください。','PC_BACKUP_LOCK');
  if(typeof preferredName!=='string'||!preferredName||/[\\/:*?"<>|\x00-\x1f]/.test(preferredName)||preferredName==='.'||preferredName==='..')
   throw error('PCの保存名を確認できません。','PC_BACKUP_PATH');
  const name=versionedName(preferredName,asset);
  const matches=async blob=>!!blob&&blob.size===size&&(await hash(blob)).toLowerCase()===sha;
  const result=(name,file)=>({name,file,sha256:sha});
  return locks.request('sentlog-pc-safe-backup-v2',{mode:'exclusive'},async()=>{
   assertCurrent();
   const old=await existing(directory,preferredName);assertCurrent();
   if(old&&await matches(old.file)){assertCurrent();return result(preferredName,old.file);}
   // Do not create or change the historical preferred path when bytes differ.
   const version=await existing(directory,name);assertCurrent();
   if(version&&await matches(version.file)){assertCurrent();return result(name,version.file);}
   if(version&&version.file.size>0)throw error('保存先に異なる内容があります。どちらも変更しません。','PC_BACKUP_COLLISION');
   const blob=await download();assertCurrent();
   if(!await matches(blob))throw error('ダウンロードした内容が登録時のSHA-256・サイズと一致しません。','PC_BACKUP_DOWNLOAD_HASH');
   assertCurrent();
   const handle=await directory.getFileHandle(name,{create:true});assertCurrent();
   const before=await handle.getFile();assertCurrent();
   if(await matches(before)){assertCurrent();return result(name,before);}
   // Zero-byte versioned placeholders may be left by interrupted creation.
   // A nonempty different file is never passed to createWritable.
   if(before.size!==0)throw error('保存先が変更されました。既存ファイルは保持します。','PC_BACKUP_COLLISION');
   assertCurrent();
   let writer;
   try{writer=await handle.createWritable({keepExistingData:false,mode:'exclusive'});assertCurrent();
    await writer.write(blob);assertCurrent();await writer.close();writer=null;
   }catch(e){if(writer)try{await writer.abort();}catch{}throw e;}
   assertCurrent();
   const saved=await handle.getFile();assertCurrent();
   if(!await matches(saved))throw error('PC保存後の内容照合に失敗しました。','PC_BACKUP_READBACK');
   assertCurrent();return result(name,saved);
  });
 }
 return {save,versionedName};
});

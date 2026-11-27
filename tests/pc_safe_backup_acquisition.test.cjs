'use strict';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {save,versionedName}=require('../sentlog/pc-safe-backup.js');
const hash=async blob=>createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const wanted=new Blob(['synthetic verified original']),foreign=new Blob(['synthetic unrelated existing copy']);
async function fixture(atAcquisition){
 const asset={id:'00000000-0000-4000-8000-000000000001',byte_size:wanted.size,sha256:await hash(wanted)};
 const preferredName='original.jpg',name=versionedName(preferredName,asset),files=new Map([[name,new Blob([])]]);
 const calls={opened:0,writes:0,closes:0,aborts:0};
 const directory={async getFileHandle(path,options){
  if(!files.has(path)){if(!options?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});files.set(path,new Blob([]));}
  return {getFile:async()=>files.get(path),async createWritable(options){
   assert.equal(options.mode,'exclusive');calls.opened++;
   // An independent writer commits after the preflight read and before this
   // operation acquires the exclusive stream. This is the lost-update window.
   files.set(path,atAcquisition);let staged=null;
   return {async write(blob){calls.writes++;staged=blob;},async close(){calls.closes++;files.set(path,staged);},async abort(){calls.aborts++;}};
  }};
 }};
 return {files,calls,name,run:()=>save({directory,preferredName,asset,download:async()=>wanted,hash,
  locks:{request:async(name,options,callback)=>{assert.equal(name,'sentlog-pc-safe-backup-v2');assert.equal(options.mode,'exclusive');return callback();}}})};
}
(async()=>{
 let failed=0;
 for(const [name,test]of [
  ['foreign bytes committed during acquisition are preserved',async()=>{
   const f=await fixture(foreign),before=await hash(foreign);await assert.rejects(f.run,e=>e.code==='PC_BACKUP_COLLISION');
   assert.equal(await hash(f.files.get(f.name)),before);assert.deepEqual(f.calls,{opened:1,writes:0,closes:0,aborts:1});
  }],
  ['matching bytes committed during acquisition are reused without a write',async()=>{
   const f=await fixture(wanted),result=await f.run();assert.equal(result.name,f.name);assert.equal(await hash(result.file),await hash(wanted));
   assert.deepEqual(f.calls,{opened:1,writes:0,closes:0,aborts:1});
  }],
 ]){try{await test();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.message);}}
 if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

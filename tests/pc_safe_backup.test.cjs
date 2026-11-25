'use strict';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{save,versionedName}=require('../sentlog/pc-safe-backup.js');
const hash=async b=>createHash('sha256').update(Buffer.from(await b.arrayBuffer())).digest('hex');
const id='00000000-0000-4000-8000-000000000001',preferredName='image_1.jpg';
const blob=new Blob(['verified source photo']),old=new Blob(['an earlier unrelated photograph']),bad=new Blob(['x'.repeat(blob.size)]);
function make(initial={},mode=''){
 const files=new Map(Object.entries(initial)),calls={writes:0,creates:0,downloads:0},locks={request:async(k,o,fn)=>{assert.equal(o.mode,'exclusive');return fn();}};
 const directory={async getFileHandle(name,opt){
  if(!files.has(name)){if(!opt?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});calls.creates++;files.set(name,new Blob([]));}
  return {getFile:async()=>files.get(name),createWritable:async()=>{calls.writes++;let value=null;return {write:async b=>{value=b;},close:async()=>files.set(name,mode==='readback'?bad:value),abort:async()=>{}};}};
 }};
 return {files,calls,locks,directory};
}
(async()=>{
 const asset={id,byte_size:blob.size,sha256:await hash(blob)};
 const run=(f,extra={})=>save({directory:f.directory,preferredName,asset,download:async()=>{f.calls.downloads++;return blob;},hash,locks:f.locks,...extra});
 const name=versionedName(preferredName,asset);assert.match(name,/^image_1__.*\.jpg$/);
 const collision=make({[preferredName]:old});const r=await run(collision);assert.equal(r.name,name);assert.equal(await hash(collision.files.get(preferredName)),await hash(old));assert.equal(await hash(collision.files.get(name)),asset.sha256);assert.equal(collision.calls.writes,1);
 await run(collision);assert.equal(collision.calls.downloads,1);assert.equal(collision.calls.writes,1);
 const same=make({[preferredName]:blob});assert.equal((await run(same)).name,preferredName);assert.equal(same.calls.downloads,0);assert.equal(same.calls.writes,0);
 const fresh=make();assert.equal((await run(fresh)).name,name);assert(!fresh.files.has(preferredName));
 const occupied=make({[preferredName]:old,[name]:bad});await assert.rejects(()=>run(occupied),e=>e.code==='PC_BACKUP_COLLISION');assert.equal(occupied.calls.writes,0);assert.equal(occupied.calls.downloads,0);
 const corrupt=make({[preferredName]:old});await assert.rejects(()=>run(corrupt,{download:async()=>bad}),e=>e.code==='PC_BACKUP_DOWNLOAD_HASH');assert.equal(corrupt.calls.writes,0);assert.equal(corrupt.calls.creates,0);
 const placeholder=make({[name]:new Blob([])});assert.equal((await run(placeholder)).name,name);
 const readback=make({[preferredName]:old},'readback');await assert.rejects(()=>run(readback),e=>e.code==='PC_BACKUP_READBACK');assert.equal(await hash(readback.files.get(preferredName)),await hash(old));
 const changed=make();let current=true;await assert.rejects(()=>run(changed,{download:async()=>{current=false;return blob;},assertCurrent:()=>{if(!current)throw Error('scope changed');}}),/scope changed/);assert.equal(changed.calls.creates,0);
 await assert.rejects(()=>run(make(),{locks:null}),e=>e.code==='PC_BACKUP_LOCK');
 const revision=new Blob(['new drawing/photo revision']);const revisionAsset={...asset,sha256:await hash(revision),byte_size:revision.size};
 const r2=await run(collision,{asset:revisionAsset,download:async()=>revision});assert.notEqual(r2.name,name);assert.equal(await hash(collision.files.get(name)),asset.sha256);
 console.log('PASS PC backup: collision-safe versioned names, reuse exact originals, no duplicate downloads, corrupt upload rejected before creation, no overwrite, read-back verification, account scope and lock guard');
})().catch(e=>{console.error(e);process.exitCode=1;});

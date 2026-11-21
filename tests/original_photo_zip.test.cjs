'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const zip=require('../sentlog/original-photo-zip.js');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sentlog-onezip-core-'));
const checks=[];
function hash(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function pattern(length,seed){const data=Buffer.alloc(length);for(let i=0;i<length;i++)data[i]=(i*31+(i>>>8)*17+seed)&255;return data;}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
function independentRead(file,expected,extra={}){
  const manifest=file+'.json';fs.writeFileSync(manifest,JSON.stringify({expected,...extra}));
  const result=spawnSync('python3',['-c',String.raw`
import hashlib,json,struct,sys,zipfile
file,manifest=sys.argv[1:]
spec=json.load(open(manifest,encoding='utf-8'))
with zipfile.ZipFile(file) as archive:
    entries=archive.infolist()
    assert len(entries)==spec.get('count',len(spec['expected']))
    assert len({entry.filename.casefold() for entry in entries})==len(entries)
    assert archive.testzip() is None
    for expected in spec['expected']:
        entry=archive.getinfo(expected['path'])
        assert entry.file_size==expected['size']
        assert hashlib.sha256(archive.read(entry)).hexdigest()==expected['sha256']
        assert not entry.filename.startswith(('/', '\\'))
        assert all(segment not in ('.','..') for segment in entry.filename.split('/'))
        if 'offset' in spec:
            assert entry.header_offset==spec['offset']
            assert entry.extract_version==(45 if spec['offset']>=0xffffffff else 20)
with open(file,'rb') as stream:
    stream.seek(-22,2);end=stream.read(22)
    assert end[:4]==b'PK\x05\x06'
    fields=struct.unpack('<IHHHHIIH',end)
    if spec.get('zip64'):
        assert fields[3:7]==(65535,65535,0xffffffff,0xffffffff)
        stream.seek(-42,2);locator=stream.read(20)
        signature,disk,offset,disks=struct.unpack('<IIQI',locator)
        assert signature==0x07064b50 and disk==0 and disks==1
        stream.seek(offset);wide=struct.unpack('<IQHHIIQQQQ',stream.read(56))
        assert wide[0]==0x06064b50 and wide[1]==44
        assert wide[6]==wide[7]==len(entries)
    else:
        assert fields[3]==fields[4]==len(entries)
print(json.dumps({'files':len(entries),'zip64':bool(spec.get('zip64'))}))
`,file,manifest],{encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout.trim());
}
async function archive(file,inputs,initialOffset=0n){
  const fd=fs.openSync(file,'w');let position=Number(initialOffset),maximumWrite=0;
  const writer=zip.createWriter({initialOffset,write:bytes=>{maximumWrite=Math.max(maximumWrite,bytes.length);const size=fs.writeSync(fd,bytes,0,bytes.length,position);position+=size;return size;}}),expected=[];
  try{
    for(const input of inputs){const added=await writer.add({path:input.path,blob:new Blob([input.data]),modifiedAt:new Date(2026,10,21,10,22,24).getTime()});expected.push({path:added.path,size:input.data.length,sha256:hash(input.data)});}
    return {result:await writer.close(),expected,maximumWrite};
  }finally{fs.closeSync(fd);}
}
async function main(){
  await check('one ordinary ZIP: independent extraction, source hashes, UTF-8 and duplicate names',async()=>{
    const file=path.join(temporary,'ordinary.zip');
    const inputs=[
      {path:'2026/案件/写真/図面/ひび割れ/IMG_0001.JPG',data:pattern(700123,1)},
      {path:'2026/案件/写真/図面/ひび割れ/img_0001.jpg',data:pattern(526111,7)},
      {path:'2026/案件/写真/図面/ひび割れ/IMG_0001.JPG',data:Buffer.from('third original, same name')},
      {path:['2026','../案件','写真','図面\\別','CON','../../same.jpg'],data:Buffer.from('safe path')},
      {path:'../../C:\\tmp\\nul.jpg',data:Buffer.from('windows reserved path')},
      {path:'写真/'+('あ'.repeat(120))+'.JPEG',data:Buffer.alloc(0)},
      {path:'写真/é.jpg',data:Buffer.from('composed')},
      {path:'写真/e\u0301.jpg',data:Buffer.from('decomposed')},
      {path:'file-parent',data:Buffer.from('a')},
      {path:'file-parent/child.jpg',data:Buffer.from('b')},
      {path:'directory-parent/child.jpg',data:Buffer.from('c')},
      {path:'directory-parent',data:Buffer.from('d')}
    ];
    const out=await archive(file,inputs);assert.equal(out.result.zip64,false);assert.equal(out.result.originalBytes,BigInt(inputs.reduce((n,input)=>n+input.data.length,0)));
    assert.equal(out.expected[1].path,'2026/案件/写真/図面/ひび割れ/img_0001 (2).jpg');
    assert.equal(out.expected[2].path,'2026/案件/写真/図面/ひび割れ/IMG_0001 (3).JPG');
    assert.equal(out.expected[7].path,'写真/é (2).jpg');
    assert.equal(out.expected[9].path,'file-parent (2)/child.jpg');assert.equal(out.expected[11].path,'directory-parent (2)');
    assert.ok(out.maximumWrite<=zip.CHUNK_BYTES);for(const row of out.expected)for(const segment of row.path.split('/'))assert.ok(Buffer.byteLength(segment)<=240);
    assert.deepEqual(independentRead(file,out.expected),{files:inputs.length,zip64:false});
  });
  await check('ZIP64 offsets at 4GiB boundary: actual sparse archives read independently',async()=>{
    for(const initialOffset of [0xfffffffen,0xffffffffn,0x100000000n]){
      const file=path.join(temporary,'offset-'+initialOffset+'.zip'),out=await archive(file,[{path:'原本/写真.jpg',data:Buffer.from('real payload after sparse prefix')}],initialOffset);
      assert.equal(out.result.zip64,true);assert.equal(BigInt(fs.statSync(file).size),initialOffset+out.result.byteLength);
      assert.ok(fs.statSync(file).blocks*512<1024*1024,'boundary archive must remain physically sparse');
      assert.deepEqual(independentRead(file,out.expected,{zip64:true,offset:Number(initialOffset)}),{files:1,zip64:true});
    }
  });
  await check('5,000 same-name originals retain distinct entries and original bytes',async()=>{
    const file=path.join(temporary,'duplicates.zip'),inputs=Array.from({length:5000},(_,i)=>({path:'写真/図面/変状/IMG_0001.JPG',data:Buffer.from('original-'+i)}));
    const out=await archive(file,inputs);assert.equal(out.expected.at(-1).path,'写真/図面/変状/IMG_0001 (5000).JPG');
    assert.deepEqual(independentRead(file,out.expected),{files:5000,zip64:false});
  });
  await check('ZIP64 entry count: 65,536 real entries survive independent enumeration and CRC checks',async()=>{
    const file=path.join(temporary,'many.zip'),fd=fs.openSync(file,'w'),empty=new Blob([]);let position=0;
    const writer=zip.createWriter({write:bytes=>{const count=fs.writeSync(fd,bytes,0,bytes.length,position);position+=count;return count;}});
    let result;
    try{for(let i=0;i<65536;i++)await writer.add({path:`写真/${String(i).padStart(6,'0')}.jpg`,blob:empty,modifiedAt:0});result=await writer.close();}finally{fs.closeSync(fd);}
    assert.equal(result.entryCount,65536);assert.equal(result.zip64,true);
    const expected=[0,65534,65535].map(i=>({path:`写真/${String(i).padStart(6,'0')}.jpg`,size:0,sha256:hash(Buffer.alloc(0))}));
    assert.deepEqual(independentRead(file,expected,{count:65536,zip64:true}),{files:65536,zip64:true});
  });
  await check('single-file ZIP64 size header at boundary, without allocating or pretending to read 4GiB',async()=>{
    for(const size of [0xfffffffe,0xffffffff,0x100000000]){
      const records=[],stop=new Error('intentionally stop before any huge payload read');
      const writer=zip.createWriter({write:bytes=>{records.push(Buffer.from(bytes));return bytes.length;}});
      await assert.rejects(writer.add({path:'large.jpg',blob:{size,slice(){throw stop;}}}),e=>e===stop);
      const local=records[0],large=size>=0xffffffff;assert.equal(local.readUInt32LE(0),0x04034b50);assert.equal(local.readUInt16LE(4),large?45:20);
      assert.equal(local.readUInt32LE(18),large?0xffffffff:0);assert.equal(local.readUInt32LE(22),large?0xffffffff:0);
      if(large){const extra=30+local.readUInt16LE(26);assert.equal(local.readUInt16LE(extra),1);assert.equal(local.readUInt16LE(extra+2),16);assert.equal(local.readBigUInt64LE(extra+4),BigInt(size));assert.equal(local.readBigUInt64LE(extra+12),BigInt(size));}
      await assert.rejects(writer.close(),e=>e.code==='ZIP_STATE');
    }
  });
  await check('bounded chunks yield to cancellation and never finalize partial output',async()=>{
    const controller=new AbortController();let readBytes=0,maximumRead=0,maximumWrite=0,writes=0;
    const source={size:128*1024*1024,slice(start,end){const length=end-start;readBytes+=length;maximumRead=Math.max(maximumRead,length);return {arrayBuffer:async()=>new ArrayBuffer(length)};}};
    const writer=zip.createWriter({signal:controller.signal,write:bytes=>{maximumWrite=Math.max(maximumWrite,bytes.length);writes++;return bytes.length;}});
    const timer=setTimeout(()=>controller.abort(),0);
    try{await assert.rejects(writer.add({path:'large.jpg',blob:source}),e=>e.code==='EXPORT_CANCELLED');}finally{clearTimeout(timer);}
    assert.ok(readBytes>0&&readBytes<source.size);assert.ok(writes>1);assert.ok(maximumRead<=zip.CHUNK_BYTES&&maximumWrite<=zip.CHUNK_BYTES);
    await assert.rejects(writer.close(),e=>e.code==='ZIP_STATE');
  });
  await check('source truncation, sink quota failure and short writes fail closed',async()=>{
    const truncated=zip.createWriter({write:bytes=>bytes.length});
    await assert.rejects(truncated.add({path:'photo.jpg',blob:{size:10,slice:()=>({arrayBuffer:async()=>new ArrayBuffer(9)})}}),e=>e.code==='SOURCE_CHANGED');
    await assert.rejects(truncated.close(),e=>e.code==='ZIP_STATE');
    const quota=new DOMException('simulated full native sink','QuotaExceededError'),failed=zip.createWriter({write:()=>{throw quota;}});
    await assert.rejects(failed.add({path:'photo.jpg',blob:new Blob(['123456789'])}),e=>e===quota);await assert.rejects(failed.close(),e=>e.code==='ZIP_STATE');
    const short=zip.createWriter({write:bytes=>bytes.length-1});await assert.rejects(short.add({path:'photo.jpg',blob:new Blob(['x'])}),e=>e.code==='ZIP_WRITE_INCOMPLETE');
  });
  await check('empty archive, invalid input and reserved path handling remain deterministic',async()=>{
    const file=path.join(temporary,'empty.zip'),out=await archive(file,[]);assert.equal(out.result.byteLength,22n);independentRead(file,[]);
    assert.equal(zip.safeSegment('CON.txt'),'_CON.txt');assert.equal(zip.safeSegment('photo. '),'photo');assert.equal(zip.safePath(['..','a/b','c\\d']), '_/a_b/c_d');
    assert.throws(()=>zip.safePath(''),e=>e.code==='ZIP_PATH');assert.throws(()=>zip.createWriter({write(){},initialOffset:-1n}),e=>e.code==='ZIP_LIMIT');
    const invalid=zip.createWriter({write:bytes=>bytes.length});await assert.rejects(invalid.add({path:'x',blob:{size:Number.MAX_SAFE_INTEGER+1,slice(){}}}),e=>e.code==='ZIP_SOURCE');
  });
  console.log(JSON.stringify({result:'PASS',checks:checks.length,realEntryCountBoundary:65536,sparseOffsetBoundaries:[4294967294,4294967295,4294967296],singleLargePayload:'header-only boundary; no 4GiB payload was streamed',maximumPhotoChunkBytes:zip.CHUNK_BYTES}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temporary,{recursive:true,force:true}));

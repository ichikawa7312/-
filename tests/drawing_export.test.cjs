const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../sentlog/drawing-export-core.js');
(async()=>{
 assert.equal(C.safeName('../CON:図面?. '),'.._CON_図面_');
 assert.equal(C.safeName('CON'),'_CON');
 const names=C.names([{name:'魚道工'},{name:'魚道工'},{name:'a'},{name:'A'}]);
 assert.equal(new Set(names.map(x=>x.toLowerCase())).size,4);
 const p=C.pixels(11575,8031,1191,842);assert(p.width*p.height<6010000&&p.width<=4096&&p.height<=4096);
 assert.throws(()=>C.pixels(0,100,842,595));
 assert.equal(await C.crc32(new Blob(['123456789'])),0xcbf43926);
 const zip=await C.zip([{name:'魚道工/記録図.pdf',blob:new Blob(['fixture PDF bytes'])},{name:'出力一覧.txt',blob:new Blob(['日本語'])}]);
 const out=path.join(__dirname,'../test-results/drawing-export');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'core.zip'),Buffer.from(await zip.arrayBuffer()));
 const boot=fs.readFileSync(path.join(__dirname,'../sentlog/index.html'),'utf8');assert(boot.includes('drawing-export.js?v=188'));assert(boot.includes('phone-runtime.js?v=188'));
 const frame=fs.readFileSync(path.join(__dirname,'../sentlog/drawing-export-view.html'),'utf8');assert(!frame.includes('window.sentlogAppReady=initApp()'));assert(!frame.includes('src="./cloud-sync'));assert(!frame.includes('src="./record-store'));assert(frame.includes('drawing-export-frame.js?v=188'));
 console.log('PASS export filenames, UTF-8 ZIP/CRC, memory bounds and isolated build');
})().catch(e=>{console.error(e);process.exitCode=1;});

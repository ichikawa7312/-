'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const C=require('../sentlog/dxf-core.js');
const Raster=require('../sentlog/dxf-raster-core.js');
const MiB=1024*1024;

// Valid DXF with a long comment, so the parser must genuinely accept >8 MiB
// rather than merely return a different error for oversized invalid content.
const header='0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1027\n0\nENDSEC\n';
const entities='0\nSECTION\n2\nENTITIES\n999\n';
const end='\n0\nENDSEC\n0\nEOF\n';
const large=new TextEncoder().encode(header+entities+'A'.repeat(9*MiB)+end);
assert(large.byteLength>8*MiB && large.byteLength<25*MiB);
const parsed=C.scan(large);
assert.equal(parsed.version,'AC1027');
assert(parsed.records.some(r=>r.type==='EOF'));
assert.equal(Raster.parse(large).references.length,0);
assert.throws(()=>C.scan(new Uint8Array(25*MiB+1)),/25MB/);

// These are three distinct safety paths: file picker, core parser, and
// referenced-image cloud delivery. Keeping them consistent avoids silent loss.
const view=fs.readFileSync(__dirname+'/../sentlog/dxf.js','utf8');
const core=fs.readFileSync(__dirname+'/../sentlog/dxf-core.js','utf8');
const raster=fs.readFileSync(__dirname+'/../sentlog/dxf-raster.js','utf8');
assert(view.includes('if(file.size>25*1024*1024)'));
assert(core.includes('bytes.length>25*1024*1024'));
assert(raster.includes('source.size>25*1024*1024'));
assert(view.includes('90000:45000'));
console.log('PASS DXF capacity: 9 MiB valid ASCII accepted, raster parsing accepted, 25 MiB upper bound enforced, picker/remote reference paths aligned');

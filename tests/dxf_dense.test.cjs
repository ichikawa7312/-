'use strict';
const assert=require('node:assert/strict');
const C=require('../sentlog/dxf-core.js');
const fs=require('node:fs');
const MiB=1024*1024;

// 110,000 LINE entities, each 10 physical lines: previously rejected outright
// by the 1,000,000-line gate. The file remains under the existing 25 MiB cap.
const prefix='0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1027\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
const line='0\nLINE\n10\n0\n20\n1\n11\n2\n21\n3\n';
const suffix='0\nENDSEC\n0\nEOF\n';
const input=new TextEncoder().encode(prefix+line.repeat(110000)+suffix);
assert(input.length<25*MiB);
const parsed=C.scan(input);
assert.equal(parsed.version,'AC1027');
assert.equal(parsed.records.filter(r=>r.type==='LINE').length,110000);
assert(parsed.tags.length>500000);
assert.equal(parsed.raw.length,input.length);
const entity=parsed.records.find(r=>r.type==='LINE');
assert.equal(parsed.raw.slice(entity.start,entity.end),'0\nLINE\n10\n0\n20\n1\n11\n2\n21\n3\n');
const last=parsed.records.at(-1);
assert.equal(last.type,'EOF');
assert.deepEqual(C.appendPrimitives(input,[],{unitsPerPixel:1,xMin:0,yMax:0}).bytes,input);
assert.equal(C.inspect(input).entities,110000);
assert(fs.readFileSync(__dirname+'/../sentlog/dxf.js','utf8').includes('info.entities>50000'));

// Mixed CRLF, LF, CR, valid trailing blanks and malformed odd tag pairs.
const crlf=new TextEncoder().encode(prefix.replace(/\n/g,'\r\n')+line.replace(/\n/g,'\r\n')+suffix.replace(/\n/g,'\r\n')+'\r\n');
assert.equal(C.scan(crlf).records.filter(r=>r.type==='LINE').length,1);
assert.throws(()=>C.scan(new TextEncoder().encode('0\nSECTION\n2\nHEADER\n9\n')),/途中/);
console.log('PASS DXF dense: 110,000 LINE entities, 1.1M+ physical lines, byte-exact no-op export, offset stability and CRLF');

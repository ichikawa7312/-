'use strict';
// Test the deployed, generated startup HTML, not an isolated drawing-order module.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('sentlog/index.html','utf8');
const lookup="html=html.replace('</body>','<script src=\"./drawing-order.js?v=209\">";
const start=source.indexOf(lookup);
assert(start>0,'the real bootstrap must append the drawing-order module');
assert.equal(source.indexOf(lookup,start+1),-1,'only one module injection is allowed');
const end=source.indexOf(';document.open();document.write(html);document.close()',start);
assert(end>start,'the injection must run before document.write');
const stmt=source.slice(start,end+1);
assert(!stmt.includes('<\\\\/script>'),'the generated JavaScript must not double-escape HTML closing tags');
const fixture='<!doctype html><html><head></head><body><div id="drawingsGrid"></div><script src="./sync-view.js"></script></body></html>';
const output=vm.runInNewContext('let html='+JSON.stringify(fixture)+';'+stmt+';html');
const tag='<script src="./drawing-order.js?v=209"></script>';
assert(output.includes(tag),'the browser must receive a valid, executable <script> element');
assert.equal(output.split(tag).length-1,1);
assert(output.indexOf('./sync-view.js')<output.indexOf('./drawing-order.js'),'reorder module runs after drawing list wrappers');
assert(output.includes(tag+'</body>'),'reorder module is closed before the document body finishes');
assert(!output.includes('<\\/script>'),'invalid escaped HTML script endings are forbidden');
assert(source.includes("['drawing-order.js?v=209','SentlogDrawingOrder']"),
  'preflight verifies that the drawing-order resource exists');
console.log('PASS drawing order integrated boot: generated HTML contains one well-formed loadable script after other drawing modules');

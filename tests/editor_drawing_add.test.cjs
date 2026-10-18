const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

const source=fs.readFileSync(path.join(root,'sentlog/editor-drawing-add.js'),'utf8');
assert.match(source,/drawingAddInput/);
assert.match(source,/editorDrawingAddBtn/);
assert.match(source,/＋ 図面を追加/);
assert.match(source,/persist\(\)/);
assert.match(source,/addInput\.click\(\)/);
assert.doesNotMatch(source,/fileInput\.click\(\)/,'must not replace the current drawing');

const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/editor-drawing-add\.js\?v=170/);
assert.match(index,/SentlogEditorDrawingAdd/);
assert.match(index,/phone-runtime\.js\?v=170/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/sentlog-pwa-v181/);
assert.match(sw,/editor-drawing-add\.js/);
console.log('PASS editor drawing add: current drawing persisted, existing add-input reused, replace flow untouched');

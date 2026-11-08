'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(base,p),'utf8');
const script=read('sentlog/drawing-list-header.js');
const html=read('sentlog/index.html'),sw=read('sentlog/sw.js');
const sorting=read('sentlog/drawing-order.js'),exporter=read('sentlog/drawing-export.js');
const groups=read('sentlog/drawing-groups.js');
assert.equal((html.match(/drawing-list-header\.js\?v=233/g)||[]).length,1,'Header must be loaded once in generated app');
assert.ok(sw.includes("'drawing-list-header.js'"),'Header must work offline via service worker');
for(const name of ['slDrawingExportBtn','drawingAddInput','slDrawingOrderToolbar','sentlogCloudStatus','navBackBtn','headerTitle','slDrawingHeaderCounts']){
 assert.ok(script.includes(name),'Missing existing action or layout: '+name);
}
for(const name of ['図面一括出力','図面の追加','図面','シート']){
 assert.ok(script.includes(name),'Missing user-facing short wording: '+name);
}
assert.ok(script.includes('insertBefore(center'), 'No duplicate toolbar should be created');
assert.ok(script.includes("sort.parentElement!==center"),'Move the existing manual reorder control');
assert.ok(script.includes("add.parentElement!==center"),'Move the original file chooser label');
assert.ok(script.includes("exportBtn.parentElement!==center"),'Move existing multi-drawing export action');
assert.ok(script.includes('root.SentlogHomeLayout.moveControls()'),'Restore auto-sync button on other screens');
assert.ok(script.includes('overscroll-behavior-x:contain'),'Middle section should scroll on narrow phones');
assert.ok(script.includes('touch-action:pan-x'),'Allow horizontal touch navigation');
assert.ok(script.includes('min-height:44px'),'Finger-sized controls');
assert.ok(script.includes('sl-drawings-view header #navBackBtn')&&script.includes('order:99'),'Keep Back fixed at right');
assert.ok(script.includes('sl-drawings-view header .brand-mark')&&script.includes('order:0'),'Logo first');
assert.ok(script.includes('sl-drawings-view header #headerTitle')&&script.includes('order:1'),'Project title next to logo');
assert.ok(script.includes('safe-area-inset-top')===false,'Reuse existing tested iPhone safe-area padding rather than duplicate calculations');
assert.ok(script.includes('#drawingsView .manager-head p')&&script.includes('#drawingsView .manager-subbar'),'Hide duplicate explanation and summary row');
assert.ok(script.includes('setAttribute')&&script.includes('drawingAddInput'),'Keep keyboard operation on add-file label');
assert.ok(sorting.includes("['g1'")===false,'Use original sort implementation');
assert.ok(sorting.includes("const toggle=button('⇅ 並び替え'")&&sorting.includes("const byNum=button('図面No.順に整列'"));
assert.ok(exporter.includes("launch.id='slDrawingExportBtn'"),'Preserve existing exporter');
assert.ok(groups.includes("listAdd.textContent='＋ 新しい図面No.'"),'Keep underlying drawing-group operation unchanged');
for(const forbidden of ['saveWorkspace(','persist(','archiveAtomic(','deleteFiles:',"localStorage.setItem(","SentlogRecords.setItem(","indexedDB.open(","fetch("]){
 assert.ok(!script.includes(forbidden),'Presentation-only integration must not write or delete records: '+forbidden);
}
console.log('PASS drawing list header: original export/import, add, reorder, counts, 44px controls and no data writes');

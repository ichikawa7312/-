'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
const js=fs.readFileSync(path.join(root,'sentlog/home-layout.js'),'utf8');
const archive=fs.readFileSync(path.join(root,'sentlog/archive.js'),'utf8');
const recovery=fs.readFileSync(path.join(root,'sentlog/photo-recovery.js'),'utf8');
const settings=fs.readFileSync(path.join(root,'sentlog/app-settings.js'),'utf8');
const rescue=fs.readFileSync(path.join(root,'sentlog/record-rescue.js'),'utf8');

// Build loads the actual script once, after the existing auto-trace/photo modules.
assert.equal((html.match(/home-layout\.js\?v=232/g)||[]).length,1);
assert.ok(sw.includes("'home-layout.js'"),'Home layout must be available offline');
assert.ok(js.includes('root.SENTLOG_BUILD'),'Never hard-code the displayed app version');
assert.ok(js.includes('sentlogSettingsBtn')&&js.includes('slPhotoRedeliveryStatus')&&js.includes('sentlogCloudStatus')&&js.includes('sentlogRecordRescueBtn'));
assert.ok(js.includes('photoBadge.append(photo)'),'Reuse the live photo recovery text source without cloning it');
assert.ok(js.includes('settings.parentElement!==right'),'Preserve the original settings trigger and its listeners');
assert.ok(js.includes("rescue.parentElement!==left"),'Keep the original rescue action');
assert.ok(js.includes("cloud.parentElement!==left"),'Keep the original cloud status button');
assert.ok(js.includes('root.ResizeObserver')&&js.includes('--sl-home-header-height'),'Actual header height must drive document layout');
assert.ok(js.includes('safe-area-inset-top')&&js.includes('sl-home-layout.sentlog-phone header'),'Account for iPhone PWA status bar');
assert.ok(js.includes("$('slArchiveBack')")&&js.includes("archived?'保管':'案件一覧'"),'Do not lose the archive view heading');
assert.ok(js.includes('#projectsView #slPeerPhotosList')&&js.includes('#projectsView .sentlog-build'));
assert.ok(js.includes('#projectsView .manager-brand-sub')&&js.includes('#projectsView .manager-head p'));
assert.ok(js.includes('#slHomeHeaderRight')&&js.includes('#slHomeHeaderVersion'));

// This is a display-only feature; no additional snapshot or data-store writes.
for(const dangerous of ['window.SentlogRecords.setItem(','localStorage.setItem(','indexedDB.open(','saveWorkspace(','persist(','dbPut(','fetch(','window.location.reload(']){
 assert.ok(!js.includes(dangerous),'Home layout must not write data: '+dangerous);
}
assert.ok(archive.includes("title.textContent=archiveView?'保管':'使用中の案件'"));
assert.ok(recovery.includes("if(e)e.textContent=t"),'Photo recovery still writes the existing status element');
assert.ok(settings.includes("trigger.onclick=open"),'Settings original control must remain available');
assert.ok(rescue.includes("b.onclick=chooseProject"),'Emergency rescue original handler must remain available');
console.log('PASS home layout: original control relocation, version, photo status, mobile safe area and no data writes');

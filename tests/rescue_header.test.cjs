'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const rescue=fs.readFileSync('sentlog/record-rescue.js','utf8');
const index=fs.readFileSync('sentlog/index.html','utf8');

assert.match(rescue,/header\.insertBefore\(b,save\)/);
assert.match(rescue,/b\.textContent='緊急救出'/);
assert.match(rescue,/content:"救出"/);
assert.match(rescue,/#projectsView:not\(\.hidden\)/);
assert.ok(!rescue.includes("panel.append(label,b,note)"),'old large rescue panel must be gone');
assert.ok(!rescue.includes("b.textContent='緊急：案件を選んで救出'"),'old long label must be gone');
assert.match(index,/record-rescue\.js\?v=201/);
console.log('PASS rescue header: emergency export moved beside sync and hidden outside project list');

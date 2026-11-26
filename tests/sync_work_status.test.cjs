'use strict';
// Exercise the real status view plus the separate in-flight display. A small
// DOM and deterministic clock keep elapsed-time and stale-handle cases exact.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const baseSource = fs.readFileSync(path.join(root, 'sentlog/sync-status.js'), 'utf8')
  .replace('export function createSyncStatusView', 'function createSyncStatusView');
const workSource = fs.readFileSync(path.join(root, 'sentlog/sync-work-status.js'), 'utf8')
  .replace('export function attachSyncWorkStatus', 'function attachSyncWorkStatus');

function fixture({ showing = true } = {}) {
  let now = 1000, serial = 0;
  const timers = new Map(), created = [];
  const clock = {
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = target;
    }
  };
  const doc = { failWorkWrites: false };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.hidden = false; this.value = ''; }
    get textContent() { return this.value; }
    set textContent(value) {
      if (doc.failWorkWrites && this.attrs['data-sync-work-kind']) throw Error('Synthetic display failure');
      this.value = String(value); this.children = [];
    }
    set innerHTML(_) { throw Error('Dynamic status must use textContent'); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; this.value = ''; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    querySelector(selector) { return selector === '.sl-sync-label' ? this.children.find(child => child.className === 'sl-sync-label') : null; }
  }
  const modal = new Element('div'), button = new Element('button'), details = new Element('div'), head = new Element('head');
  modal.style.display = showing ? 'flex' : 'none';
  Object.assign(doc, {
    head, documentElement: { classList: { contains: () => false } },
    createElement(tag) { created.push(tag); return new Element(tag); },
    getElementById(id) { return id === 'sentlogCloudModal' ? modal : head.children.find(child => child.id === id) || null; }
  });
  const context = { document: doc, Date: class extends Date { static now() { return now; } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  vm.createContext(context);
  vm.runInContext(baseSource + '\n' + workSource + '\nthis.api={createSyncStatusView,attachSyncWorkStatus};', context);
  const base = context.api.createSyncStatusView(doc), view = context.api.attachSyncWorkStatus(base, doc);
  view.mount(button, details);
  const line = kind => details.children.find(child => child.getAttribute('data-sync-work-kind') === kind);
  return { view, base, clock, timers, doc, modal, button, details, created, line, attach: context.api.attachSyncWorkStatus };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }

(async () => {
  await test('mount preserves the three existing result rows and appends exactly two independent work rows', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const original = f.details.children.slice(0, 3);
    assert.equal(f.details.children.length, 5);
    assert.deepEqual(f.details.children.slice(3).map(row => row.getAttribute('data-sync-work-kind')), ['metadata', 'files']);
    const records = f.view.beginWork('metadata', '検証案件の変更を確認しています');
    const files = f.view.beginWork('files', '検証案件の図面を受信しています');
    assert.deepEqual(f.details.children.slice(0, 3), original);
    assert.equal(f.line('metadata').textContent, '記録・図面情報：検証案件の変更を確認しています');
    assert.equal(f.line('files').textContent, '図面・写真ファイル：検証案件の図面を受信しています');
    assert.equal(f.timers.size, 1, 'both workers share only the display timer');
    records.finish(); assert.equal(f.line('metadata').hidden, true); assert.equal(f.line('files').hidden, false);
    files.finish(); assert.equal(f.timers.size, 0);
    f.view.mount(f.button, f.details); assert.equal(f.details.children.length, 5, 'remount does not accumulate rows');
  });
  await test('project callbacks update only an explicitly bound same-kind and same-project work entry', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const records = f.view.beginWork('metadata', '保存を待っています');
    assert.equal(f.view.updateProjectWork('metadata', 'project-a', 'unexpected'), false, 'a callback cannot claim an unbound round');
    records.update('案件 A を確認しています', 'project-a');
    assert.equal(f.view.updateProjectWork('metadata', 'project-b', 'unexpected'), false);
    assert.equal(f.view.updateProjectWork('files', 'project-a', 'unexpected'), false);
    assert.equal(f.view.updateProjectWork('metadata', null, 'unexpected'), false);
    assert.equal(f.view.updateProjectWork('metadata', 'project-a', '案件 A の保護コピーを確認しています'), true);
    assert.match(f.line('metadata').textContent, /案件 A の保護コピー/);
    records.update('次の変更を確認しています');
    assert.equal(f.view.updateProjectWork('metadata', 'project-a', 'unexpected'), false, 'a round-level stage clears the project binding');
  });
  await test('elapsed seconds describe the current stage and repeated identical progress cannot hide a long wait', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const handle = f.view.beginWork('metadata', '保存を待っています');
    handle.update('案件 A の保存を待っています', 'project-a');
    f.clock.tick(15000); assert(!f.line('metadata').textContent.includes('秒経過'));
    f.view.updateProjectWork('metadata', 'project-a', '案件 A の保存を待っています');
    f.clock.tick(1000); assert.match(f.line('metadata').textContent, /（16秒経過）$/);
    handle.update('案件 A の基準データを確認しています', 'project-a');
    assert(!f.line('metadata').textContent.includes('秒経過'));
    f.clock.tick(16000); assert.match(f.line('metadata').textContent, /（16秒経過）$/);
    handle.update('案件 A の基準データを確認しています', 'project-b');
    assert(!f.line('metadata').textContent.includes('秒経過'), 'changing the project starts a distinct observed stage');
  });
  await test('hidden details never poll and refresh resumes the visible elapsed-time display', () => {
    const f = fixture({ showing: false }); f.view.setAccount('synthetic-owner');
    const handle = f.view.beginWork('files', '図面を受信しています');
    assert.equal(f.timers.size, 0); f.clock.tick(20000);
    assert.equal(f.line('files').textContent, '');
    f.modal.style.display = 'flex'; f.view.refresh();
    assert.match(f.line('files').textContent, /（20秒経過）$/); assert.equal(f.timers.size, 1);
    const previous = f.line('files').textContent;
    f.modal.style.display = 'none'; f.clock.tick(1000);
    assert.equal(f.timers.size, 0); assert.equal(f.line('files').textContent, previous);
    f.clock.tick(50000); f.view.refresh(); assert.equal(f.timers.size, 0);
    f.modal.style.display = 'flex'; f.view.refresh();
    assert.match(f.line('files').textContent, /（71秒経過）$/); assert.equal(f.timers.size, 1);
    handle.finish(); assert.equal(f.timers.size, 0);
  });
  await test('replacement rounds reject old updates and finishes without clearing the new work', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const old = f.view.beginWork('metadata', '古い round');
    const current = f.view.beginWork('metadata', '新しい round');
    assert.equal(old.update('stale', 'project-a'), false); assert.equal(old.finish(), false);
    assert.match(f.line('metadata').textContent, /新しい round/); assert.equal(f.timers.size, 1);
    assert.equal(current.finish(), true); assert.equal(current.finish(), false);
    assert.equal(f.line('metadata').textContent, ''); assert.equal(f.timers.size, 0);
  });
  await test('account changes clear all work, while token refresh preserves current work and rejects old generation handles', () => {
    const f = fixture(); f.view.setAccount('owner-a');
    const old = f.view.beginWork('metadata', '前の利用者の案件');
    f.view.beginWork('files', '前の利用者の図面');
    f.view.setAccount('owner-a'); assert.match(f.line('metadata').textContent, /前の利用者/);
    const lateTimer = [...f.timers.values()][0].fn;
    f.view.setAccount('owner-b');
    assert.equal(f.timers.size, 0); assert(f.details.children.slice(3).every(row => row.hidden && row.textContent === ''));
    f.view.beginWork('metadata', '現在の利用者の案件'); lateTimer();
    assert.equal(f.timers.size, 1, 'a cancelled timer cannot replace the new account timer');
    assert.equal(old.update('stale'), false); assert.equal(old.finish(), false);
    assert.match(f.line('metadata').textContent, /現在の利用者/);
    f.view.setAccount(''); assert.equal(f.timers.size, 0);
    f.view.setAccount('owner-a'); assert.equal(old.update('still stale'), false, 'signing back in does not revive a former handle');
  });
  await test('work is inactive without an account and unknown worker kinds cannot create extra rows or timers', () => {
    const f = fixture(); const signedOut = f.view.beginWork('metadata', 'unexpected');
    assert.equal(signedOut.update('unexpected'), false); assert.equal(signedOut.finish(), false);
    f.view.setAccount('synthetic-owner');
    assert.equal(f.view.beginWork('unknown', 'unexpected').finish(), false);
    assert.equal(f.view.updateProjectWork('unknown', 'project-a', 'unexpected'), false);
    assert.equal(f.details.children.length, 5); assert.equal(f.timers.size, 0);
  });
  await test('project and filename text remains literal and never enters an HTML sink', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const literal = '案件 <img src=x onerror=alert(1)> の "図面<&>.pdf" を確認しています';
    f.view.beginWork('files', literal);
    assert.equal(f.line('files').textContent, '図面・写真ファイル：' + literal);
    assert(!f.created.includes('img')); assert.equal(f.line('files').children.length, 0);
  });
  await test('finishing observed work cannot change the base result, last successful time or synchronization outcome', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner');
    const cycle = f.view.begin();
    f.view.finish(cycle, { level: 'pending', message: '実際の確認結果は未完了です。' });
    const before = f.details.children.slice(0, 3).map(row => row.textContent);
    const handle = f.view.beginWork('metadata', '保存を待っています');
    f.clock.tick(20000); handle.finish(); f.view.refresh();
    assert.deepEqual(f.details.children.slice(0, 3).map(row => row.textContent), before);
    assert.match(f.details.children[1].textContent, /この起動後は未確認/);
    assert.equal(f.details.children[2].getAttribute('data-level'), 'pending');
  });
  await test('DOM display errors cannot throw through beginWork, update or finish', () => {
    const f = fixture(); f.view.setAccount('synthetic-owner'); f.doc.failWorkWrites = true;
    let handle;
    assert.doesNotThrow(() => { handle = f.view.beginWork('metadata', '保存を待っています'); });
    assert.doesNotThrow(() => handle.update('案件 A を確認しています', 'project-a'));
    assert.doesNotThrow(() => f.view.updateProjectWork('metadata', 'project-a', '記録を確認しています'));
    assert.doesNotThrow(() => handle.finish()); assert.equal(f.timers.size, 0);
    f.doc.failWorkWrites = false; f.view.refresh(); assert.equal(f.line('metadata').hidden, true);
  });
  await test('the existing API preserves receiver, arguments and return values, including track rejections', async () => {
    const f = fixture(), calls = [], base = { extra: 'preserved' }, methods = ['mount', 'setAccount', 'setOnline', 'begin', 'finish', 'track', 'refresh'];
    const outputs = Object.fromEntries(methods.map(name => [name, { name }]));
    for (const name of methods) base[name] = function (...args) { assert.equal(this, base); calls.push({ name, args }); return outputs[name]; };
    const view = f.attach(base, f.doc); assert.equal(view.extra, 'preserved');
    const args = { mount: [f.button, f.details], setAccount: ['synthetic-owner'], setOnline: [false], begin: [], finish: [5, { level: 'pending' }], track: ['stage', () => 3], refresh: [] };
    for (const name of methods) assert.equal(view[name](...args[name]), outputs[name]);
    assert.deepEqual(calls.map(call => call.name), methods);
    for (let index = 0; index < methods.length; index++) assert.deepEqual(calls[index].args, args[methods[index]]);
    f.view.setAccount('synthetic-owner'); f.view.begin();
    assert.equal(await f.view.track('実際の通信', async () => 42), 42);
    const error = Error('Synthetic network failure');
    await assert.rejects(f.view.track('実際の通信', async () => { throw error; }), value => value === error);
  });
  console.log('PASS', passed, 'sync work status cases');
})().catch(error => { console.error(error); process.exitCode = 1; });

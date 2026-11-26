'use strict';
// Execute the production-built timer and targeted receiver with real records,
// real IndexedDB transactions and synthetic transport. No customer data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const { webcrypto } = require('node:crypto');
const { openApplication, digest, WORKSPACE, DRAWING } = require('./helpers/delta_recovery_fixture.cjs');
const root = path.resolve(process.env.SENTLOG_BUILT_ROOT || path.join(__dirname, '..'));
const source = fs.readFileSync(path.join(root, 'sentlog/pdf-recovery.js'), 'utf8');
assert(source.includes('function legacyPdfValidate(') && source.includes("operation:'legacy-pdf-receive'"),
  'Run this regression against the final production build');
const ownerId = 'handover-owner', deviceId = 'handover-device';
const clone = value => structuredClone(value);

async function fixture({ existing = false, deleted = false, count = 1 } = {}) {
  const projects = [], drawings = [], assets = [], blobs = new Map();
  for (let n = 0; n < count; n++) {
    const meta = { id: 'drawing-' + n, name: 'Synthetic drawing', fileName: 'drawing.pdf', sourceType: 'pdf', pageCount: 1 };
    const state = { sourceType: 'pdf', fileName: 'drawing.pdf', pageCount: 1, shapes: [], collabDeletedRecords: [] };
    projects.push({ id: 'local-' + n, name: 'Same display name', drawings: [meta] });
    drawings.push({ meta, state });
    const blob = new Blob(['%PDF-1.4 synthetic ' + n], { type: 'application/pdf' });
    blobs.set(meta.id, blob);
    assets.push({ id: 'asset-' + n, project_id: 'cloud-' + n, status: deleted ? 'storage_deleted' : 'uploaded',
      file_name: meta.fileName, mime_type: 'application/pdf', byte_size: blob.size, sha256: await digest(blob),
      storage_path: ownerId + '/cloud-' + n + '/' + meta.id, metadata: { drawing_id: meta.id } });
  }
  const local = new Map([[WORKSPACE, JSON.stringify({ projects })],
    ...drawings.map(d => [DRAWING + d.meta.id, JSON.stringify(d.state)])]);
  const app = await openApplication({ local });
  if (existing) for (const asset of assets) await app.records.writeFile('background:' + asset.metadata.drawing_id, blobs.get(asset.metadata.drawing_id));
  // Open the second application before either creates a binding. The first
  // instance's cache deliberately remains stale in cross-tab tests.
  const other = await app.restart();
  let currentOwner = ownerId, currentDevice = deviceId;
  const calls = { requests: [], acks: [], attaches: [], writes: [], writeErrors: [], forgets: [], warnings: [] };
  const hooks = {};
  const scope = n => ({ ownerId, deviceId, projectId: 'cloud-' + n });
  const stage = async (n = 0, instance = app) => instance.records.deltaJournal.begin({ scope: scope(n),
    localProjectId: 'local-' + n, actor: { deviceId, deviceName: 'Synthetic receiver' }, serverRevision: 1 });
  const activate = async (n = 0) => {
    await stage(n);
    return app.records.deltaJournal.activate({ scope: scope(n), localProjectId: 'local-' + n, baselineId: 'baseline-' + n });
  };
  const writeFile = app.records.writeFile;
  app.records.writeFile = async (key, value, options) => {
    calls.writes.push({ key, options });
    if (hooks.beforeWrite) await hooks.beforeWrite(key, value, options);
    let validations = 0;
    const validate = options?.validate;
    const guarded = options ? { ...options, validate: () => {
      validations++;
      hooks.onWriteValidate?.(validations);
      return validate();
    } } : options;
    try { return await writeFile(key, value, guarded); }
    catch (error) { calls.writeErrors.push(error); throw error; }
  };
  const environment = {
    location: { pathname: '/sentlog/' }, Blob, File, AbortController, Uint8Array, TextEncoder, ArrayBuffer, URL, Response,
    indexedDB: app.factory, crypto: webcrypto,
    navigator: { onLine: true }, document: { hidden: false, querySelector: () => null, getElementById: () => null, addEventListener() {} },
    console: { warn: (...args) => calls.warnings.push(args), error: (...args) => calls.warnings.push(args), log() {} },
    localStorage: { getItem: key => key === 'sentlogCloudSessionV1'
      ? JSON.stringify({ user: { id: currentOwner }, access_token: 'synthetic-token-' + currentOwner })
      : key === 'sentlogCloudDeviceV1' ? currentDevice : null },
    // Observe startup registration without introducing an unrelated timer.
    setTimeout: (fn, ms, ...args) => ms === 2500 ? 0 : setTimeout(fn, ms, ...args), clearTimeout, setInterval: () => 1,
    SentlogRecords: app.records, SentlogArchive: { ready: true, isAuto: () => true }, sentlogAppReady: Promise.resolve(),
    sentlogRestoreDrawingView: async (id, blob) => { calls.attaches.push({ id, blob }); },
    SentlogSyncTraffic: {
      ack: async (kind, asset, id, send) => {
        if (hooks.beforeAckSend) await hooks.beforeAckSend(asset);
        return send({ p_asset_id: asset.id, p_device_id: id, p_sha256: asset.sha256, p_byte_size: asset.byte_size });
      },
      forget: async (kind, asset) => calls.forgets.push(asset.id)
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url), request = { path: parsed.pathname, method: options.method || 'GET' };
      calls.requests.push(request);
      if (request.path.includes('/storage/')) {
        if (hooks.onDownload) await hooks.onDownload();
        return new Response(blobs.get(request.path.split('/').at(-1)));
      }
      if (request.path.endsWith('/rpc/sentlog_ack_pdf')) {
        calls.acks.push(JSON.parse(options.body)); return new Response(JSON.stringify({ received: true }));
      }
      const value = request.path.endsWith('/sentlog_devices') ? [{ id: deviceId, active: true }]
        : request.path.endsWith('/sentlog_assets') ? assets
        : request.path.endsWith('/sentlog_pdf_requests') ? []
        : request.path.endsWith('/rpc/sentlog_request_pdf') ? {} : null;
      assert.notEqual(value, null, 'Unexpected network path ' + request.path);
      return new Response(JSON.stringify(value));
    }
  };
  environment.window = environment; environment.addEventListener = () => {};
  vm.createContext(environment);
  vm.runInContext(fs.readFileSync(path.join(root, 'sentlog/blob-sha256.js'), 'utf8'), environment);
  await vm.runInContext('(async()=>{' + source + '\nwindow.__receiverStatus=()=>signature;})()', environment);
  return { app, other, assets, blobs, projects, drawings, calls, hooks, environment, stage, activate, scope,
    run: () => environment.sentlogCheckPdfRecovery(),
    targeted: (id = 'drawing-0') => environment.sentlogRequestDrawingRecovery(id),
    status: () => environment.__receiverStatus(),
    setOwner: owner => { currentOwner = owner; }, setDevice: id => { currentDevice = id; },
    async noSavedDrawing(n = 0) { assert.equal((await app.disk()).has('background:drawing-' + n), false); },
    noDelivery() { assert.equal(calls.acks.length, 0); assert.equal(calls.attaches.length, 0); },
    noDownload() { assert.equal(calls.requests.filter(r => r.path.includes('/storage/')).length, 0); }
  };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
async function sameDurable(app, before) { assert.deepEqual(await app.durable(), before); }

(async () => {
  await test('staging timer and targeted opener preserve a missing PDF, all raw records and pending files', async () => {
    const f = await fixture(); await f.stage(); const before = await f.app.durable();
    await f.run(); assert.equal(await f.targeted(), false);
    await sameDurable(f.app, before); await f.noSavedDrawing(); f.noDelivery(); f.noDownload();
    assert.equal(f.calls.writes.length, 0); assert.match(f.status(), /同期画面.*図面/);
    assert.doesNotMatch(f.status(), /保存済み|再取得しました/);
  });
  await test('an already matching live PDF receives no legacy ACK or view attachment while staging', async () => {
    const f = await fixture({ existing: true }); await f.stage(); const before = await f.app.durable();
    await f.run(); assert.equal(await f.targeted(), false);
    await sameDurable(f.app, before); f.noDelivery(); f.noDownload(); assert.equal(f.calls.writes.length, 0);
  });
  await test('staging deleted-storage assets neither forget receipts nor request redelivery', async () => {
    const f = await fixture({ deleted: true }); await f.stage(); await f.run(); assert.equal(await f.targeted(), false);
    assert.equal(f.calls.forgets.length, 0); assert(!f.calls.requests.some(r => r.path.includes('/rpc/')));
    f.noDelivery(); f.noDownload(); await f.noSavedDrawing();
  });
  await test('cross-tab staging during download is rechecked before a save or receipt', async () => {
    const f = await fixture(); let staged;
    f.hooks.onDownload = async () => { await f.stage(0, f.other); staged = await f.app.durable(); };
    await f.run();
    assert.equal(f.app.records.deltaJournal.listBindingStatesSync().length, 0, 'local cache must remain stale');
    await sameDurable(f.app, staged); await f.noSavedDrawing(); f.noDelivery(); assert.equal(f.calls.writes.length, 0);
  });
  await test('the actual file transaction rejects another-tab staging after the last readonly guard', async () => {
    const f = await fixture(); let staged;
    f.hooks.beforeWrite = async () => { await f.stage(0, f.other); staged = await f.app.durable(); };
    await f.run();
    assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.writes[0].options.operation, 'legacy-pdf-receive');
    assert.equal(f.calls.writeErrors[0]?.code, 'JOURNAL_PDF_HANDOVER');
    assert.equal(f.app.records.deltaJournal.listBindingStatesSync().length, 0, 'transaction must not rely on the cache');
    await sameDurable(f.app, staged); await f.noSavedDrawing(); f.noDelivery();
    await f.app.records.retry(); await sameDurable(f.app, staged); await f.noSavedDrawing();
    assert.equal(f.app.records.writerState('background:drawing-0').failed, false, 'guarded rejection must not enter legacy retry');
  });
  await test('account change after the native file put rolls back file, sequence and journal atomically', async () => {
    const f = await fixture(); await f.activate(); const before = await f.app.durable();
    f.hooks.onWriteValidate = n => { if (n === 5) f.setOwner('other-owner'); };
    await f.run();
    assert.equal(f.calls.writeErrors[0]?.code, 'PDF_RECOVERY_CONTEXT');
    await sameDurable(f.app, before); await f.noSavedDrawing(); f.noDelivery();
    await f.app.records.retry(); await sameDurable(f.app, before);
  });
  await test('a queued ACK rechecks another-tab staging at its actual send callback', async () => {
    const f = await fixture(); let staged;
    f.hooks.beforeAckSend = async () => { await f.stage(0, f.other); staged = await f.app.durable(); };
    await f.run();
    assert.equal(f.calls.writes.length, 1, 'the file was validly saved before handover started');
    assert.equal(await digest((await f.app.disk()).get('background:drawing-0')), f.assets[0].sha256);
    await sameDurable(f.app, staged); f.noDelivery(); assert.match(f.status(), /同期画面/);
  });
  await test('account or device change while downloading prevents targeted persistence and completion', async () => {
    for (const change of ['owner', 'device']) {
      const f = await fixture(); const before = await f.app.durable();
      f.hooks.onDownload = async () => change === 'owner' ? f.setOwner('other-owner') : f.setDevice('other-device');
      assert.equal(await f.targeted(), false);
      await sameDurable(f.app, before); await f.noSavedDrawing(); f.noDelivery();
      assert.equal(f.calls.writes.length, 0); assert.doesNotMatch(f.status(), /再取得しました/);
    }
  });
  await test('active and unbound projects continue receiving, independently of a same-named staging project', async () => {
    for (const active of [false, true]) {
      const f = await fixture({ count: 2 }); await f.stage(0); if (active) await f.activate(1);
      await f.run(); await f.noSavedDrawing(0);
      assert.deepEqual(f.calls.acks.map(a => a.p_asset_id), ['asset-1']);
      assert.deepEqual(f.calls.attaches.map(a => a.id), ['drawing-1']);
      assert.equal(await digest((await f.app.disk()).get('background:drawing-1')), f.assets[1].sha256);
      assert.equal(f.calls.writes.length, 1); assert.match(f.status(), /確認待ち/);
    }
  });
  await test('missing protection API and unready records fail closed without a raw IndexedDB fallback', async () => {
    for (const missing of ['api', 'ready']) {
      const f = await fixture(); const before = await f.app.durable();
      if (missing === 'api') f.environment.SentlogRecords = { ready: true, deltaJournal: {},
        getItem: f.app.records.getItem, openFilesDatabase: f.app.records.openFilesDatabase, writeFile: f.app.records.writeFile };
      else f.environment.SentlogRecords = new Proxy(f.app.records, { get: (target, key) => key === 'ready' ? false : target[key] });
      assert.equal(await f.targeted(), false);
      await sameDurable(f.app, before); await f.noSavedDrawing(); f.noDelivery(); f.noDownload();
    }
  });
  await test('durable guard protects actual drawing ownership even if the supplied cloud project is different', async () => {
    const f = await fixture(); await f.stage(0, f.other); const before = await f.app.durable();
    await assert.rejects(f.app.records.deltaJournal.assertLegacyPdfReceive({ projectId: 'another-cloud', key: 'background:drawing-0' }),
      { code: 'JOURNAL_PDF_HANDOVER' });
    await assert.rejects(f.app.records.writeFile('background:drawing-0', f.blobs.get('drawing-0'),
      { operation: 'legacy-pdf-receive', context: { projectId: 'another-cloud' }, validate: () => true }),
      { code: 'JOURNAL_PDF_HANDOVER' });
    await sameDurable(f.app, before); await f.noSavedDrawing();
  });
  await test('explicit user-confirmed recovery retains its independent authority and honest receipt', async () => {
    const f = await fixture(), cutoff = await f.stage(), blob = f.blobs.get('drawing-0'), a = f.assets[0];
    const sourceDescriptor = { id: 'drawing-0', fileName: 'drawing.pdf', sourceType: 'pdf', pageCount: 1, pageReplacements: {} };
    const ticket = await f.app.records.deltaJournal.prepareMissingDrawingRecovery({ scope: f.scope(0), localProjectId: 'local-0',
      bindingId: cutoff.bindingId, key: 'background:drawing-0', blob, size: blob.size, sha256: a.sha256, validate: () => true,
      proof: { ownerId, projectId: a.project_id, assetId: a.id, clientKey: 'drawing:drawing-0', kind: 'drawing', drawingId: 'drawing-0',
        fileName: 'drawing.pdf', sourceType: 'pdf', size: blob.size, sha256: a.sha256, snapshotRevision: 8, source: sourceDescriptor } });
    await f.app.records.deltaJournal.confirmMissingDrawingRecovery(ticket);
    const binding = f.app.records.deltaJournal.bindingFor('local-0');
    assert.equal(binding.phase, 'staging'); assert.equal(binding.cutoff.serverRevision, 1);
    assert.deepEqual(binding.cutoff.rawEntries, cutoff.rawEntries);
    const recovered = binding.cutoff.files.find(file => file.key === 'background:drawing-0');
    assert.equal(recovered.recovery.sourceKind, 'user-confirmed-current-drawing');
    assert.equal(recovered.recovery.exactOriginalVerified, false); assert.equal(recovered.recovery.selectedSnapshotRevision, 8);
    assert.equal(await digest(recovered.value), a.sha256); f.noDelivery();
  });
  console.log('PDF handover guard cases passed:', passed);
})().catch(error => { console.error(error); process.exitCode = 1; });

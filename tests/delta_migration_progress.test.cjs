'use strict';
// Real handover coordinators and disposable IndexedDB. Only the progress
// observer and explicitly held storage boundaries are controlled by the test.
const assert = require('node:assert/strict');
const Installer = require('../sentlog/delta-sync-app-migration.js');
const Source = require('../sentlog/delta-sync-legacy-source.js');
const Migration = require('../sentlog/delta-sync-migration.js');
const Bootstrap = require('../sentlog/delta-sync-bootstrap.js');
const IndexedDB = require('../sentlog/delta-sync-indexeddb.js');
const { webcrypto } = require('node:crypto');
const { openApplication, digest, WORKSPACE } = require('./helpers/delta_recovery_fixture.cjs');

const scope = { ownerId: 'progress-owner', projectId: 'progress-cloud', deviceId: 'progress-device' };
const localProjectId = 'progress-local';
const clone = value => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Synthetic progress test did not reach its boundary')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture({ observer = () => {}, foreignDetails = false, missingDrawing = false } = {}) {
  const drawings = missingDrawing ? [{
    meta: { id: 'progress-drawing', name: 'Synthetic drawing', sourceType: 'pdf', fileName: 'drawing.pdf', pageCount: 1 },
    state: { sourceType: 'pdf', fileName: 'drawing.pdf', pageCount: 1, shapes: [], collabDeletedRecords: [] }
  }] : [];
  const snapshot = { version: 1, kind: 'sentlog-app-project', localProjectId,
    project: { id: localProjectId, name: 'Synthetic progress project', drawings: drawings.map(d => clone(d.meta)) }, drawings };
  const app = await openApplication({ snapshot });
  const before = app.records.getItem(WORKSPACE), events = [], calls = { baselineReads: 0 };
  const values = [{ kind: 'header', key: 'project', value: { project: snapshot.project } },
    ...drawings.map(d => { const state = clone(d.state); delete state.shapes; delete state.collabDeletedRecords;
      return { kind: 'drawing', key: d.meta.id, value: { meta: d.meta, state } }; })];
  const metadata = [];
  for (const value of values) {
    const row = { ordinal: metadata.length + 1, kind: value.kind, key: value.key, metadataJson: JSON.stringify(value.value) };
    row.sha256 = await digest(row.metadataJson);
    row.manifestEntryJson = JSON.stringify({ ordinal: row.ordinal, kind: row.kind, key: row.key, sha256: row.sha256 });
    metadata.push(row);
  }
  const receipt = { schema: 1, baselineId: 'progress-baseline', ...scope, clientProjectId: localProjectId,
    drawingIds: drawings.map(d => d.meta.id), snapshotRevision: 1, cursor: 0, recordCount: 0, importedCount: 0,
    metadataCount: metadata.length, snapshotSha256: await digest(JSON.stringify(snapshot)),
    manifestSha256: await digest('[]'), metadataManifestSha256: await digest('[' + metadata.map(r => r.manifestEntryJson).join(', ') + ']'),
    hashFormat: 'postgres-jsonb-text-sha256-v1', state: 'active', deltaEnabled: true,
    deviceMigrationVerified: false, assetDeliveryVerified: false };
  const page = (rows, after, limit, key) => ({ receipt: clone(receipt), [key]: clone(rows.slice(after, after + limit)),
    nextOrdinal: Math.min(after + limit, rows.length), hasMore: after + limit < rows.length });
  const transport = {
    getCapabilities: () => ({ atomicGroups: true, sharedMetadata: true }),
    inspect: async () => ({ ...scope, enabled: true, baseline: clone(receipt), headSeq: 0 }),
    list: async () => [],
    readBaselinePage: async (_, after, limit) => { calls.baselineReads++; return page([], after, limit, 'records'); },
    readBaselineMetadataPage: async (_, after, limit) => { calls.baselineReads++; return page(metadata, after, limit, 'metadata'); }
  };
  const store = IndexedDB.createStore({ ...scope, indexedDB: app.factory });
  const coordinator = (create, options) => create({ ...options, onProgress: detail => options.onProgress(foreignDetails ? {
    ...detail, localProjectId: 'foreign-local', scope: { ownerId: 'foreign-owner', projectId: 'foreign-cloud', deviceId: 'foreign-device' }
  } : detail) });
  const installer = Installer.createInstaller({ records: app.records,
    recoverMissingFiles: async ({ missing }) => ({ issues: missing.map(item => ({ key: item.key, reviewable: true,
      reason: 'SNAPSHOT_REVISION_MISMATCH', message: 'Synthetic drawing requires review' })) }),
    onProgress: detail => {
      // Match the application boundary which previously discarded coordinator
      // notifications because their localProjectId was absent.
      if (detail.localProjectId) events.push(clone(detail));
      return observer(detail);
    },
    factories: {
      source: options => Source.createSource({ ...options, indexedDB: app.factory, localStorage: app.localStorage, crypto: webcrypto }),
      migrationStore: binding => Migration.createStore({ ...binding, indexedDB: app.factory }),
      migration: options => coordinator(Migration.createCoordinator, options),
      bootstrap: options => coordinator(Bootstrap.createCoordinator, options)
    }
  });
  return { app, before, events, calls, store, statuses: () => events.map(event => event.status),
    run: () => installer({ scope, localProjectId, actor: { deviceId: scope.deviceId, deviceName: 'Synthetic progress device' },
      store, transport, mode: { enabled: true, baseline: clone(receipt), snapshotRevision: 1 }, currentScope: () => scope }),
    async assertActive() {
      assert.equal((await app.records.deltaJournal.readBindingState(localProjectId)).phase, 'active');
      assert(await store.readProvenance());
      assert.equal(app.records.getItem(WORKSPACE), before, 'progress must not change application records');
    },
    close: () => store.close()
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
(async () => {
  for (const foreignDetails of [false, true]) await test(foreignDetails ?
    'coordinator details cannot override the actual application project ownership' :
    'real copy and bootstrap phases survive the application progress filter', async () => {
    const f = await fixture({ foreignDetails });
    try {
      assert.equal((await f.run()).installed, true); await f.assertActive();
      for (const status of ['copying', 'verified-copy', 'reconciling', 'prepared', 'installing', 'installed'])
        assert(f.statuses().includes(status), 'Missing coordinator phase: ' + status);
      for (const event of f.events) { assert.equal(event.localProjectId, localProjectId); assert.deepEqual(event.scope, scope); }
      for (const status of ['waiting-records', 'protecting-records', 'reading-local-copy', 'checking-missing-files',
        'preparing-baseline', 'capturing-source', 'copying', 'verified-copy', 'reconciling', 'prepared',
        'installing', 'installed', 'projecting', 'activating', 'active']) assert(f.statuses().includes(status), 'Missing phase: ' + status);
      const copied = f.events.find(event => event.status === 'verified-copy');
      assert.equal(copied.copied, copied.total); assert(copied.total > 0, 'copy details survive the wrapper');
      assert.equal(f.statuses().at(-1), 'active');
      assert(f.statuses().indexOf('installed') < f.statuses().indexOf('activating'));
    } finally { f.close(); }
  });
  for (const kind of ['throw', 'reject', 'unresolved']) await test('a display callback that ' + kind + ' does not change the real installation result', async () => {
    const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    const f = await fixture({ observer: detail => {
      detail.scope.ownerId = 'display-mutated-owner';
      if (kind === 'throw') throw Error('Synthetic display failure');
      if (kind === 'reject') return Promise.reject(Error('Synthetic async display failure'));
      return new Promise(() => {});
    } });
    try {
      assert.equal((await deadline(f.run())).installed, true); await f.assertActive();
      assert(f.events.every(event => event.scope.ownerId === scope.ownerId));
      await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
    } finally { f.close(); process.removeListener('unhandledRejection', listener); }
  });
  await test('an outstanding application save reports waiting and cannot announce activation', async () => {
    const f = await fixture(), held = deferred(), reached = deferred(), settled = f.app.records.settled;
    f.app.records.settled = async () => { reached.resolve(); await held.promise; return settled(); };
    try {
      const task = f.run(); await deadline(reached.promise);
      assert.deepEqual(f.statuses(), ['waiting-records']); assert.equal(f.calls.baselineReads, 0);
      assert.equal(f.app.records.deltaJournal.bindingStateFor(localProjectId), null);
      held.resolve(); assert.equal((await deadline(task)).installed, true); await f.assertActive();
    } finally { held.resolve(); f.app.records.settled = settled; f.close(); }
  });
  await test('local activation failure is not reported as active and its verified copy resumes', async () => {
    const f = await fixture(), held = deferred(), reached = deferred(), activate = f.app.records.deltaJournal.activate;
    const failure = Object.assign(Error('Synthetic activation interruption'), { code: 'SYNTHETIC_ACTIVATION' });
    f.app.records.deltaJournal.activate = async () => { reached.resolve(); await held.promise; throw failure; };
    try {
      const task = f.run(); task.catch(() => {}); await deadline(reached.promise);
      assert(f.statuses().includes('installed')); assert.equal(f.statuses().at(-1), 'activating');
      assert(!f.statuses().includes('active')); assert.equal(f.app.records.deltaJournal.bindingStateFor(localProjectId).phase, 'staging');
      held.resolve(); await assert.rejects(task, error => error === failure); assert(!f.statuses().includes('active'));
      f.app.records.deltaJournal.activate = activate; f.events.length = 0;
      assert.deepEqual(await deadline(f.run()), { resumed: true }); await f.assertActive();
      assert.deepEqual(f.statuses(), ['waiting-records', 'protecting-records', 'reading-local-copy', 'projecting', 'activating', 'active']);
      assert.equal(f.events.at(-1).resumed, true);
    } finally { held.resolve(); f.app.records.deltaJournal.activate = activate; f.close(); }
  });
  await test('a display failure preserves missing-file review details and the original blocking error', async () => {
    const f = await fixture({ missingDrawing: true, observer() { throw Error('Synthetic display failure'); } });
    try {
      await assert.rejects(f.run(), error => error.code === 'DELTA_MIGRATION_REVIEW');
      const review = f.events.find(event => event.status === 'missing-files-review'); assert(review);
      assert.deepEqual(review.scope, scope); assert.equal(review.localProjectId, localProjectId);
      assert.equal(review.issues[0].key, 'background:progress-drawing'); assert.equal(review.remaining, 1);
      assert.equal(review.bindingId, f.app.records.deltaJournal.bindingStateFor(localProjectId).id);
      assert.equal(f.calls.baselineReads, 0); assert(!f.statuses().includes('installed')); assert(!f.statuses().includes('active'));
      assert.equal(await f.store.readProvenance(), null); assert.equal(f.app.records.getItem(WORKSPACE), f.before);
    } finally { f.close(); }
  });
  console.log('Migration progress cases passed:', passed);
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Incident-shaped synthetic reproduction. No customer names, IDs, coordinates,
// files, hashes, or snapshots are loaded by this test or committed as fixtures.
const assert = require('node:assert/strict');
const C = require('../sentlog/record-collaboration.js');
const D = require('../sentlog/delta-sync-core.js');
const Recovery = require('../sentlog/delta-sync-migration-recovery.js');
const Migration = require('../sentlog/delta-sync-migration.js');
const Assets = require('../sentlog/delta-sync-assets.js');
const AssetRuntime = require('../sentlog/delta-sync-asset-runtime.js');
const { openApplication, createInstallerHarness, digest, DRAWING } = require('./helpers/delta_recovery_fixture.cjs');

const clone = value => structuredClone(value);
const scope = { ownerId: 'synthetic-owner', projectId: 'synthetic-cloud', deviceId: 'synthetic-pc' };
const localProjectId = 'synthetic-local', drawingId = 'synthetic-drawing';
const backgroundKey = 'background:' + drawingId;
const actor = { deviceId: scope.deviceId, deviceName: 'Synthetic PC' };
const photoDistribution = [2, 37, 26, 0, 4];

function onePagePdf() {
  const stream = 'BT /F1 12 Tf 36 800 Td (Synthetic drawing for review) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  text += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  text += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return new Blob([text], { type: 'application/pdf' });
}

async function fixture() {
  const photos = await Promise.all(Array.from({ length: 69 }, async (_, index) => ({
    id: 'synthetic-photo-' + index, name: 'photo-' + index + '.jpg', type: 'image/jpeg',
    size: 1000 + index, sha256: await digest('synthetic-photo-content-' + index), createdAt: 1700000000000 + index
  })));
  let offset = 0;
  const shapes = photoDistribution.map((count, index) => {
    const record = C.upgrade({
      id: 'synthetic-record-' + index, kind: 'field-record', recordKind: 'field-record', recordType: 'photo',
      type: 'Inspection', typeNo: index + 1, recordNo: index + 1, globalNo: index + 1,
      autoLabel: 'Inspection-' + (index + 1), displayKind: 'direction', page: 1,
      point: { x: 100 + index * 20, y: 200 + index * 20 }, points: [],
      labelPos: { x: 110 + index * 20, y: 220 + index * 20, anchor: 'middle' },
      memo: 'Synthetic retained note ' + index, surveyItems: [], createdAt: 1700000000000 + index,
      photos: photos.slice(offset, offset + count)
    });
    offset += count; return record;
  });
  const meta = {
    id: drawingId, name: 'Synthetic bridge drawing', groupId: drawingId, fileName: 'synthetic-bridge.pdf',
    createdAt: 1700000000000, groupName: 'Synthetic bridge drawing', pageCount: 1,
    sheetName: 'Synthetic bridge drawing', photoCount: 69, shapeCount: 5, sheetOrder: 1, sourceType: 'pdf'
  };
  const state = {
    shapes, project: 'Synthetic bridge', fileName: meta.fileName, pageCount: 1, pageStates: {},
    sourceType: 'pdf', leaderMarker: 'open-circle', nextGlobalNo: 6, pageSettings: {},
    typeCounters: {}, pageRotations: {}, collabDeletedRecords: []
  };
  const snapshot = {
    version: 1, kind: 'sentlog-app-project', localProjectId,
    project: { id: localProjectId, name: 'Synthetic bridge', drawings: [clone(meta)], createdAt: 1700000000000 },
    drawings: [{ meta: clone(meta), state }]
  };
  const baseline = clone(snapshot);
  baseline.drawings[0].state.shapes = [];
  for (const drawing of [baseline.project.drawings[0], baseline.drawings[0].meta]) {
    drawing.photoCount = 0; drawing.shapeCount = 0;
  }
  const app = await openApplication({ snapshot });
  const cutoff = await app.records.deltaJournal.begin({ scope, localProjectId, actor, serverRevision: 1 });
  const blob = onePagePdf(), sha256 = await digest(blob);
  const asset = {
    id: '11111111-2222-4333-8444-555555555555', owner_id: scope.ownerId, project_id: scope.projectId,
    client_key: 'drawing:' + drawingId, kind: 'drawing', file_name: meta.fileName,
    storage_path: scope.ownerId + '/' + scope.projectId + '/drawings/synthetic.pdf', mime_type: blob.type,
    byte_size: blob.size, sha256, status: 'pc_verified',
    metadata: { drawing_id: drawingId, local_project_key: localProjectId, source_type: 'pdf' }
  };
  const remote = { asset, snapshot: { revision: 8, payload: { project: snapshot.project, drawings: snapshot.drawings } } };
  const stats = { downloads: 0, restores: 0 };
  let active = true;
  const validate = () => active;
  const recovery = Recovery.createRecovery({
    maxFiles: 128,
    listAssets: async (binding, keys) => { assert.deepEqual(binding, scope); return keys.includes(remote.asset.client_key) ? [clone(remote.asset)] : []; },
    readAsset: async (binding, id) => { assert.deepEqual(binding, scope); return id === remote.asset.id ? clone(remote.asset) : null; },
    readSnapshot: async binding => { assert.deepEqual(binding, scope); return clone(remote.snapshot); },
    download: async candidate => { assert.equal(candidate.id, remote.asset.id); stats.downloads++; return blob; }
  });
  const acceptedEvents = shapes.map((record, index) => D.diffRecord(null, record, {
    eventId: 'synthetic-accepted-event-' + index, projectId: scope.projectId, drawingId, deviceId: 'synthetic-peer'
  }));
  async function recoveryArguments(target = app) {
    return { scope, localProjectId, serverRevision: 1, bindingId: cutoff.bindingId, validate,
      missing: await target.records.deltaJournal.missingCutoffFiles({ scope, localProjectId, bindingId: cutoff.bindingId }) };
  }
  async function prepare(target = app) {
    const preview = await recovery.prepareReview({ ...await recoveryArguments(target), key: backgroundKey });
    const localTicket = await target.records.deltaJournal.prepareMissingDrawingRecovery({
      ...preview, scope, localProjectId, bindingId: cutoff.bindingId, validate
    });
    return { preview, localTicket };
  }
  const installer = target => createInstallerHarness({ app: target, scope, localProjectId, baseline,
    baselineRevision: 1, currentRevision: 8, acceptedEvents, recoverMissingFiles: recovery });
  return { app, snapshot, baseline, cutoff, blob, sha256, remote, stats, recovery, acceptedEvents,
    recoveryArguments, prepare, installer, invalidate: () => { active = false; } };
}

async function assertPhotosStillPending(app, state) {
  const calls = { acknowledgements: 0, uploads: 0, downloads: 0 }, owners = new Map(), token = Object.freeze({});
  const assetStore = Assets.createIndexedDBStore({ ...scope, indexedDB: app.factory });
  const runtime = AssetRuntime.createRuntime({
    scope, store: assetStore, currentScope: () => scope, currentSnapshotToken: () => token,
    authGeneration: () => 0, subscribeAuth: () => () => {},
    transport: {
      getScope: () => clone(scope), online: () => true, listPhotos: async () => [],
      uploadPhoto: async () => { calls.uploads++; throw Error('A missing photo cannot be uploaded'); },
      download: async () => { calls.downloads++; throw Error('There is no published photo asset'); },
      acknowledge: async () => { calls.acknowledgements++; throw Error('A missing photo cannot be acknowledged'); }
    },
    localFiles: {
      getCapabilities: () => app.records.getFileWriteCapabilities(), read: async key => (await app.disk()).get(key),
      assertExclusive: key => { const value = app.records.writerState(key, { ownerToken: owners.get(key) });
        return value.exclusive && !value.foreignPending && !value.failed && value.journaled; },
      withLock: async (key, run) => { assert(!owners.has(key)); owners.set(key, {});
        try { return await run(); } finally { owners.delete(key); } },
      write: (key, blob, options) => app.records.writeFile(key, blob, { ...options, ownerToken: owners.get(key) })
    }
  });
  try {
    const result = await runtime.sync({ snapshot: state, snapshotToken: token });
    assert.equal(result.complete, false);
    assert.equal(result.pending, 69);
    assert.equal(result.references.length, 0);
    assert(result.issues.every(issue => issue.code === 'ASSET_REFERENCE_MISSING'));
    assert.deepEqual(calls, { acknowledgements: 0, uploads: 0, downloads: 0 });
  } finally { runtime.close(); assetStore.close(); }
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
(async () => {
  await test('a newer unversioned drawing is explained, never automatically downloaded, and cancellation preserves every durable row', async () => {
    const f = await fixture(), before = await f.app.durable();
    const automatic = await f.recovery({ ...await f.recoveryArguments(), restore: async () => { f.stats.restores++; } });
    assert.equal(automatic.restored, 0); assert.equal(f.stats.downloads, 0); assert.equal(f.stats.restores, 0);
    const issue = automatic.issues.find(item => item.key === backgroundKey);
    assert.equal(issue.reason, 'SNAPSHOT_REVISION_MISMATCH'); assert.equal(issue.reviewable, true);
    const install = await f.installer(f.app);
    try {
      await assert.rejects(install.run, error => error.code === 'DELTA_MIGRATION_REVIEW');
      assert.equal(await install.store.read(), null);
      assert.equal(install.calls.baselineReads, 0);
    } finally { install.close(); }
    assert.deepEqual(await f.app.durable(), before);
    const { preview, localTicket } = await f.prepare();
    assert.equal(preview.originalSnapshotRevision, 1); assert.equal(preview.selectedSnapshotRevision, 8);
    assert.equal(preview.source.pageCount, 1); assert.equal(await digest(preview.blob), f.sha256);
    assert.deepEqual(await f.app.durable(), before, 'preview and preparation must not modify the cutoff or live store');
    assert.equal(f.app.records.deltaJournal.cancelMissingDrawingRecovery(localTicket), true);
    assert.equal(f.recovery.releaseReview(preview.ticket), true);
    await assert.rejects(() => f.app.records.deltaJournal.confirmMissingDrawingRecovery(localTicket),
      error => error.code === 'JOURNAL_RECOVERY_REVIEW_TICKET');
    await assert.rejects(() => f.recovery.validateReview(preview.ticket), error => error.code === 'DELTA_RECOVERY_REVIEW_TICKET');
    assert.deepEqual(await f.app.durable(), before);
  });

  await test('confirmed PDF survives restart, resumes the actual installer, and preserves five records and 69 unacknowledged photo references', async () => {
    const f = await fixture(), recordsBefore = f.app.records.getItem(DRAWING + drawingId);
    const { preview, localTicket } = await f.prepare();
    const validated = await f.recovery.validateReview(preview.ticket);
    assert.equal(validated.sha256, f.sha256);
    const result = await f.app.records.deltaJournal.confirmMissingDrawingRecovery(localTicket);
    f.recovery.releaseReview(preview.ticket);
    assert.equal(result.restored, true); assert.equal(result.liveWritten, true);
    assert.equal(result.sourceKind, 'user-confirmed-current-drawing');
    assert.equal(f.app.records.getItem(DRAWING + drawingId), recordsBefore);
    const recovered = await f.app.records.deltaJournal.readCutoff({ scope, localProjectId });
    assert.deepEqual(recovered.rawEntries, f.cutoff.rawEntries); assert.equal(recovered.cutoffSeq, f.cutoff.cutoffSeq);
    assert.equal(recovered.serverRevision, 1, 'a chosen current PDF must not rewrite the old cutoff revision');
    assert.deepEqual(recovered.snapshot, f.cutoff.snapshot);
    assert.equal(recovered.files.length, 1);
    const receipt = recovered.files[0].recovery;
    assert.equal(receipt.exactOriginalVerified, false);
    assert.equal(receipt.originalSnapshotRevision, 1); assert.equal(receipt.selectedSnapshotRevision, 8);
    assert.equal(receipt.sourceKind, 'user-confirmed-current-drawing');
    assert.equal(await digest((await f.app.disk()).get(backgroundKey)), f.sha256);
    const retained = await f.app.durable();
    await assert.rejects(() => f.app.records.deltaJournal.confirmMissingDrawingRecovery(localTicket),
      error => error.code === 'JOURNAL_RECOVERY_REVIEW_TICKET');
    assert.deepEqual(await f.app.durable(), retained, 'a second confirmation cannot append another file');

    const restarted = await f.app.restart(), install = await f.installer(restarted);
    try {
      assert.equal((await install.run()).installed, true);
      const state = await install.store.read(), provenance = await install.store.readProvenance();
      const migratedRecords = Object.values(state.records).filter(record => record.id.startsWith('synthetic-record-'));
      assert.equal(migratedRecords.length, 5);
      for (const original of f.snapshot.drawings[0].state.shapes) {
        const migrated = migratedRecords.find(record => record.id === original.id);
        for (const field of ['memo', 'page', 'type', 'recordNo', 'createdAt', 'point', 'labelPos']) {
          assert.deepEqual(migrated[field], original[field], 'retained record field: ' + field);
        }
      }
      assert.deepEqual(migratedRecords.map(record => record.photos.length).sort((a, b) => a - b), [...photoDistribution].sort((a, b) => a - b));
      const references = records => records.flatMap(record => record.photos).map(photo => [photo.id, photo.sha256, photo.size]).sort();
      assert.deepEqual(references(migratedRecords), references(f.snapshot.drawings[0].state.shapes));
      assert.equal(state.cursor, 5); assert.equal(state.outbox.length, 0);
      assert.equal((await restarted.records.deltaJournal.readBindingState(localProjectId)).phase, 'active');
      const migration = Migration.createCoordinator({ source: { capture: async () => {}, recheck: async () => {} },
        store: Migration.createStore({ ...scope, indexedDB: restarted.factory }), localProjectId, currentScope: () => scope });
      try {
        const copy = await migration.readCopy(provenance.source.migrationId);
        const pending = copy.snapshot.manifest.filter(item => item.status === 'shared-photo-pending');
        assert.equal(pending.length, 69); assert(pending.every(item => item.deliveryVerified === false));
        assert.equal(copy.snapshot.files.filter(file => file.kind === 'background').length, 1);
      } finally { migration.close(); }
      assert.equal(await digest((await restarted.disk()).get(backgroundKey)), f.sha256);
      assert.equal((await restarted.records.deltaJournal.readCutoff({ scope, localProjectId })).files.length, 1);
      await assertPhotosStillPending(restarted, state);
      assert.equal(install.calls.activation, 0); assert.equal(install.calls.outboundGroups, 0);
      assert.equal(f.stats.downloads, 1, 'confirmation and restart must not redownload the selected PDF');
    } finally { install.close(); }
  });

  await test('a remote revision change after preview cancels the candidate without writing the PDF', async () => {
    const f = await fixture(), before = await f.app.durable();
    const { preview, localTicket } = await f.prepare();
    f.remote.snapshot.revision = 9;
    await assert.rejects(() => f.recovery.validateReview(preview.ticket), error => error.code === 'DELTA_RECOVERY_REVIEW_CHANGED');
    assert.equal(f.app.records.deltaJournal.cancelMissingDrawingRecovery(localTicket), true);
    assert.deepEqual(await f.app.durable(), before);
  });

  await test('a new local note during review remains intact and prevents the stale confirmation', async () => {
    const f = await fixture(), { preview, localTicket } = await f.prepare();
    const changed = JSON.parse(f.app.records.getItem(DRAWING + drawingId));
    changed.shapes[0].memo = 'Synthetic unsent note entered during preview';
    f.app.records.setItem(DRAWING + drawingId, JSON.stringify(changed)); await f.app.records.settled();
    const before = await f.app.durable();
    await f.recovery.validateReview(preview.ticket);
    await assert.rejects(() => f.app.records.deltaJournal.confirmMissingDrawingRecovery(localTicket),
      error => error.code === 'JOURNAL_RECOVERY_REVIEW_CHANGED');
    f.recovery.releaseReview(preview.ticket);
    assert.deepEqual(await f.app.durable(), before);
    assert.equal(JSON.parse(f.app.records.getItem(DRAWING + drawingId)).shapes[0].memo, changed.shapes[0].memo);
    assert.equal((await f.app.disk()).has(backgroundKey), false);
  });
  console.log('PASS drawing review integration:', passed, 'synthetic application flows');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

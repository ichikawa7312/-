'use strict';
// Disposable application/transport boundary for recovery integration tests.
// All caller-supplied snapshots and byte content must be synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Core = require('../../sentlog/delta-sync-core.js');
const Source = require('../../sentlog/delta-sync-legacy-source.js');
const Migration = require('../../sentlog/delta-sync-migration.js');
const IndexedDB = require('../../sentlog/delta-sync-indexeddb.js');
const Installer = require('../../sentlog/delta-sync-app-migration.js');

const WORKSPACE = 'surveyFieldNoteWorkspaceV1';
const DRAWING = 'surveyFieldNoteDrawingV1:';
const JOURNAL = 'sentlog_delta_journal_v1';
const CONTROL = 'sentlog_delta_control_v1';
const clone = value => structuredClone(value);
async function digest(value) {
  const bytes = value instanceof Blob ? await value.arrayBuffer() : new TextEncoder().encode(value);
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

async function openApplication({ snapshot, factory = new IDBFactory(), local } = {}) {
  local ||= new Map([
    [WORKSPACE, JSON.stringify({ projects: [snapshot.project] })],
    ...snapshot.drawings.map(drawing => [DRAWING + drawing.meta.id, JSON.stringify(drawing.state)])
  ]);
  const localStorage = {
    get length() { return local.size; },
    key(index) { return Array.from(local.keys())[index] ?? null; },
    getItem(key) { return local.get(key) ?? null; },
    setItem(key, value) { local.set(key, String(value)); },
    removeItem(key) { local.delete(key); }
  };
  const environment = {
    indexedDB: factory, IDBKeyRange, localStorage, navigator: {}, console,
    Blob, queueMicrotask, structuredClone, crypto: webcrypto, SentlogDeltaSyncCore: Core
  };
  environment.window = environment;
  vm.createContext(environment);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../sentlog/record-store.js'), 'utf8'), environment);
  const records = environment.SentlogRecords;
  await records.init();
  async function disk(storeName = 'files') {
    const database = await records.openFilesDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const rows = new Map();
        const request = transaction.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { rows.set(cursor.key, cursor.value); cursor.continue(); }
        };
        transaction.oncomplete = () => resolve(rows);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }
  return {
    records, factory, local, localStorage, disk,
    restart: () => openApplication({ factory, local }),
    durable: async () => ({ files: await disk(), controls: await disk(CONTROL), journal: await disk(JOURNAL) })
  };
}

async function createInstallerHarness({ app, scope, localProjectId, baseline, baselineRevision,
  currentRevision, acceptedEvents = [], recoverMissingFiles, currentScope = () => scope } = {}) {
  const recordRows = [];
  for (const drawing of baseline.drawings) {
    for (const record of drawing.state.shapes) {
      const row = { ordinal: recordRows.length + 1, drawingId: drawing.meta.id, recordId: record.id,
        recordJson: JSON.stringify(record) };
      row.sha256 = await digest(row.recordJson);
      row.manifestEntryJson = JSON.stringify({ ordinal: row.ordinal, drawingId: row.drawingId,
        recordId: row.recordId, sha256: row.sha256 });
      recordRows.push(row);
    }
  }
  const documents = [{ kind: 'header', key: 'project', value: { project: baseline.project } }];
  for (const drawing of baseline.drawings) {
    const state = clone(drawing.state);
    delete state.shapes; delete state.collabDeletedRecords;
    documents.push({ kind: 'drawing', key: drawing.meta.id, value: { meta: drawing.meta, state } });
  }
  const metadataRows = [];
  for (const document of documents) {
    const row = { ordinal: metadataRows.length + 1, kind: document.kind, key: document.key,
      metadataJson: JSON.stringify(document.value) };
    row.sha256 = await digest(row.metadataJson);
    row.manifestEntryJson = JSON.stringify({ ordinal: row.ordinal, kind: row.kind, key: row.key, sha256: row.sha256 });
    metadataRows.push(row);
  }
  const manifestHash = rows => digest('[' + rows.map(row => row.manifestEntryJson).join(', ') + ']');
  const receipt = {
    schema: 1, baselineId: 'synthetic-review-baseline', ownerId: scope.ownerId, projectId: scope.projectId,
    clientProjectId: localProjectId, drawingIds: baseline.drawings.map(drawing => drawing.meta.id),
    snapshotRevision: baselineRevision, cursor: 0, recordCount: recordRows.length, importedCount: recordRows.length,
    metadataCount: metadataRows.length,
    snapshotSha256: await digest(JSON.stringify({ project: baseline.project, drawings: baseline.drawings })),
    manifestSha256: await manifestHash(recordRows), metadataManifestSha256: await manifestHash(metadataRows),
    hashFormat: 'postgres-jsonb-text-sha256-v1', state: 'active', deltaEnabled: true,
    deviceMigrationVerified: false, assetDeliveryVerified: false
  };
  const calls = { baselineReads: 0, activation: 0, outboundGroups: 0 };
  const page = (rows, after, limit, key) => ({ receipt: clone(receipt), [key]: clone(rows.slice(after, after + limit)),
    nextOrdinal: Math.min(after + limit, rows.length), hasMore: after + limit < rows.length });
  const transport = {
    getCapabilities: () => ({ atomicGroups: true, sharedMetadata: true }),
    inspect: async () => ({ ...scope, enabled: true, baseline: clone(receipt), headSeq: acceptedEvents.length,
      snapshotRevision: currentRevision }),
    list: async (projectId, after, limit) => acceptedEvents.slice(after, after + limit)
      .map((event, index) => ({ seq: after + index + 1, event: clone(event) })),
    prepareBaseline: async revision => { calls.baselineReads++; assert.equal(revision, currentRevision); return clone(receipt); },
    readBaselinePage: async (id, after, limit) => { calls.baselineReads++; return page(recordRows, after, limit, 'records'); },
    readBaselineMetadataPage: async (id, after, limit) => { calls.baselineReads++; return page(metadataRows, after, limit, 'metadata'); },
    activateBaseline: async () => { calls.activation++; throw Error('An already active baseline must not be reactivated'); },
    pushGroup: async () => { calls.outboundGroups++; throw Error('Review must not send a record mutation'); }
  };
  const store = IndexedDB.createStore({ ...scope, indexedDB: app.factory });
  const installer = Installer.createInstaller({ records: app.records, recoverMissingFiles, factories: {
    source: options => Source.createSource({ ...options, indexedDB: app.factory, localStorage: app.localStorage, crypto: webcrypto }),
    migrationStore: binding => Migration.createStore({ ...binding, indexedDB: app.factory })
  } });
  return { store, receipt, calls,
    run: () => installer({ scope, localProjectId, actor: { deviceId: scope.deviceId, deviceName: 'Synthetic review PC' },
      transport, store, mode: { enabled: true, baseline: clone(receipt), snapshotRevision: currentRevision },
      revision: currentRevision, currentScope }),
    close: () => store.close()
  };
}

module.exports = { openApplication, createInstallerHarness, digest, WORKSPACE, DRAWING, JOURNAL, CONTROL };

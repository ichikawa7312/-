'use strict';
// Execute the actual generated uploadDrawing function. Before a full build,
// apply the literal transformations from the production builders, not a second
// implementation of the upload decision. All files and identities are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { File } = require('node:buffer');
const { openApplication, digest } = require('./helpers/delta_recovery_fixture.cjs');
const root = path.resolve(__dirname, '..');
const builtRoot = process.env.SENTLOG_BUILT_ROOT ? path.resolve(process.env.SENTLOG_BUILT_ROOT) : root;
const source = fs.readFileSync(path.join(builtRoot, 'sentlog/cloud-sync.js'), 'utf8');
const start = source.indexOf('async function uploadDrawing(');
const end = source.indexOf('\nasync function downloadPrivateAsset(', start);
assert(start >= 0 && end > start, 'production uploadDrawing boundaries must exist');
let uploadSource = source.slice(start, end);
if (!uploadSource.includes('confirmedDrawingSource')) {
  assert(!process.env.SENTLOG_BUILT_ROOT, 'the supplied production build must include the adopted-drawing guard');
  const parsed = spawnSync(process.env.SENTLOG_TEST_PYTHON || 'python3', ['-c', String.raw`
import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
def literal(node):
    try: return ast.literal_eval(node)
    except (ValueError, TypeError): return None
def replacements(name, call):
    result = []
    for n in ast.walk(ast.parse((root / 'scripts' / name).read_text())):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == call and len(n.args) >= 3:
            old, new = literal(n.args[1]), literal(n.args[2])
            if isinstance(old, str) and isinstance(new, str): result.append((old, new))
    return result
review = [(old, new) for old, new in replacements('build_sync_review.py', 'replace')
          if old.startswith('async function uploadDrawing(') or old.startswith("    cloudProject,deviceId,clientKey:'drawing:")]
pdf = ast.parse((root / 'scripts/build_pdf_revision_guard.py').read_text())
guards = [literal(n.value) for n in pdf.body if isinstance(n, ast.Assign)
          and any(isinstance(t, ast.Name) and t.id == 'upload_guard' for t in n.targets)]
delta = [(old, new) for old, new in replacements('build_delta_sync.py', 'change')
         if 'confirmedDrawingSource' in new]
assert len(review) == 2 and len(guards) == 1 and len(delta) == 1
print(json.dumps({'review': review, 'pdf': guards[0], 'delta': delta[0]}))
`, root], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const instructions = JSON.parse(parsed.stdout);
  const replaceOnce = (old, replacement) => {
    assert.equal(uploadSource.split(old).length - 1, 1, 'production builder anchor must match once: ' + old);
    uploadSource = uploadSource.replace(old, replacement);
  };
  for (const [old, replacement] of instructions.review) replaceOnce(old, replacement);
  const missing = "  if(!(blob instanceof Blob))return {status:'missing'};";
  if (!uploadSource.includes('const revision=expectedDrawingRevision')) replaceOnce(missing, missing + instructions.pdf);
  replaceOnce(...instructions.delta);
}

const scope = { ownerId: 'upload-owner', projectId: 'upload-project', deviceId: 'upload-device' };
const localProjectId = 'upload-local', drawingId = 'upload-drawing';
const project = { id: scope.projectId, client_key: localProjectId };
const item = { drawingId, drawingName: 'Synthetic drawing', fileName: 'synthetic.pdf', sourceType: 'pdf' };
const copy = value => structuredClone(value);
const fields = 'id,owner_id,project_id,client_key,kind,file_name,storage_path,mime_type,byte_size,sha256,status,metadata';

async function fixture({ localBlob, records, adopted = true } = {}) {
  const adoptedBlob = new Blob(['%PDF-1.4 synthetic adopted PDF'], { type: 'application/pdf' });
  const accepted = { assetId: '11111111-2222-4333-8444-555555555555', sha256: await digest(adoptedBlob),
    size: adoptedBlob.size, selectedSnapshotRevision: 8 };
  let rows = [{ id: accepted.assetId, owner_id: scope.ownerId, project_id: scope.projectId,
    client_key: 'drawing:' + drawingId, kind: 'drawing', file_name: item.fileName,
    storage_path: scope.ownerId + '/' + scope.projectId + '/drawings/synthetic.pdf',
    mime_type: 'application/pdf', byte_size: accepted.size, sha256: accepted.sha256, status: 'pc_verified',
    metadata: { drawing_id: drawingId, local_project_key: localProjectId, source_type: 'pdf' } }];
  const cached = new Map([[rows[0].client_key, copy(rows[0])]]);
  const calls = { freshReads: 0, uploads: [], optimizations: 0 };
  const blocks = new Set();
  const environment = {
    Blob, File, console, session: { user: { id: scope.ownerId } }, enc: encodeURIComponent,
    sentlogDeltaRecoveryFields: fields, drawingUploadBlocks: blocks,
    window: { SentlogRecords: records || (adopted ? { deltaJournal: { confirmedDrawingSource: (localId, id) => {
      assert.equal(localId, localProjectId); assert.equal(id, drawingId); return copy(accepted);
    } } } : {}) },
    dbGet: async key => { assert.equal(key, 'background:' + drawingId); return localBlob || adoptedBlob; },
    sha256Hex: digest, expectedDrawingRevision: () => null,
    normalizePdfHash: value => /^[a-f0-9]{64}$/i.test(String(value || '')) ? String(value).toLowerCase() : '',
    rest: async (url, options) => {
      assert(!options || !options.method || options.method === 'GET', 'the adopted-file guard must remain read-only');
      const parsed = new URL(url, 'https://synthetic.invalid');
      assert.equal(parsed.pathname, '/rest/v1/sentlog_assets');
      assert.equal(parsed.searchParams.get('project_id'), 'eq.' + scope.projectId);
      assert.equal(parsed.searchParams.get('client_key'), 'eq.drawing:' + drawingId);
      assert.equal(parsed.searchParams.get('select'), fields);
      calls.freshReads++; return copy(rows);
    },
    existingAsset: async () => { throw Error('The adopted-file guard must not use the legacy partial lookup'); },
    optimizePdfForSync: async blob => { calls.optimizations++; return { blob, optimized: false, originalSize: blob.size }; },
    uploadAsset: async options => { calls.uploads.push(options); return { status: 'uploaded' }; }
  };
  vm.createContext(environment);
  vm.runInContext(uploadSource + '\nthis.testUploadDrawing=uploadDrawing;', environment);
  return { accepted, adoptedBlob, cached, calls, blocks, get rows() { return rows; }, set rows(value) { rows = value; },
    run: () => environment.testUploadDrawing(project, scope.deviceId, item, cached) };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
(async () => {
  await test('an unchanged accepted PDF performs a fresh scoped read and never uploads', async () => {
    for (const status of ['uploaded', 'pc_verified']) {
      const f = await fixture(); f.rows[0].status = status;
      assert.equal((await f.run()).status, 'exists');
      assert.equal(f.calls.freshReads, 1); assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.optimizations, 0);
      assert.equal(f.blocks.size, 0);
    }
  });
  await test('a stale cached asset cannot authorize an upload or hide a changed remote PDF', async () => {
    const f = await fixture(); f.rows[0].sha256 = 'e'.repeat(64);
    assert.equal((await f.run()).status, 'blocked-stale');
    assert.equal(f.calls.freshReads, 1); assert.equal(f.calls.uploads.length, 0); assert(f.blocks.has(drawingId));
  });
  await test('deleted, missing, ambiguous, foreign or malformed remote rows cannot become a false exists result', async () => {
    const variants = [
      ['deleted', f => { f.rows[0].status = 'storage_deleted'; }],
      ['missing', f => { f.rows = []; }], ['duplicate', f => { f.rows.push(copy(f.rows[0])); }],
      ['asset id', f => { f.rows[0].id = 'different-asset'; }], ['owner', f => { f.rows[0].owner_id = 'foreign'; }],
      ['project', f => { f.rows[0].project_id = 'foreign'; }], ['kind', f => { f.rows[0].kind = 'photo'; }],
      ['key', f => { f.rows[0].client_key = 'drawing:foreign'; }],
      ['drawing metadata', f => { f.rows[0].metadata.drawing_id = 'foreign'; }],
      ['project metadata', f => { f.rows[0].metadata.local_project_key = 'foreign'; }],
      ['missing path', f => { f.rows[0].storage_path = ''; }],
      ['foreign path', f => { f.rows[0].storage_path = 'foreign/' + scope.projectId + '/drawings/a.pdf'; }],
      ['dot path', f => { f.rows[0].storage_path = scope.ownerId + '/' + scope.projectId + '/drawings/../a.pdf'; }],
      ['empty path', f => { f.rows[0].storage_path = scope.ownerId + '/' + scope.projectId + '//a.pdf'; }],
      ['backslash path', f => { f.rows[0].storage_path = scope.ownerId + '/' + scope.projectId + '/drawings/a\\b.pdf'; }],
      ['control path', f => { f.rows[0].storage_path = scope.ownerId + '/' + scope.projectId + '/drawings/a\nb.pdf'; }]
    ];
    for (const [name, mutate] of variants) {
      const f = await fixture(); mutate(f);
      assert.equal((await f.run()).status, 'blocked-stale', name);
      assert.equal(f.calls.uploads.length, 0, name); assert(f.blocks.has(drawingId), name);
    }
  });
  await test('a deliberately different local PDF and an ordinary legacy drawing retain the existing upload path', async () => {
    const replacement = new Blob(['%PDF-1.4 deliberately replaced local PDF'], { type: 'application/pdf' });
    for (const options of [{ localBlob: replacement }, { adopted: false }]) {
      const f = await fixture(options);
      assert.equal((await f.run()).status, 'uploaded'); assert.equal(f.calls.uploads.length, 1);
      assert.equal(f.calls.freshReads, 0); assert.equal(f.calls.optimizations, 1); assert.equal(f.blocks.size, 0);
      assert.equal(await digest(f.calls.uploads[0].blob), await digest(options.localBlob || f.adoptedBlob));
    }
  });
  await test('a real persisted confirmation is recognized after restart and cannot overwrite a later remote PDF', async () => {
    const setup = await fixture(), meta = { id: drawingId, name: item.drawingName, fileName: item.fileName, sourceType: 'pdf', pageCount: 1 };
    const state = { fileName: item.fileName, sourceType: 'pdf', pageCount: 1, shapes: [], collabDeletedRecords: [] };
    const snapshot = { project: { id: localProjectId, name: 'Synthetic project', drawings: [meta] }, drawings: [{ meta, state }] };
    const app = await openApplication({ snapshot });
    const cutoff = await app.records.deltaJournal.begin({ scope, localProjectId,
      actor: { deviceId: scope.deviceId, deviceName: 'Synthetic PC' }, serverRevision: 1 });
    const source = { id: drawingId, fileName: item.fileName, sourceType: 'pdf', pageCount: 1, pageReplacements: {} };
    const ticket = await app.records.deltaJournal.prepareMissingDrawingRecovery({ scope, localProjectId, bindingId: cutoff.bindingId,
      key: 'background:' + drawingId, blob: setup.adoptedBlob, size: setup.accepted.size, sha256: setup.accepted.sha256,
      proof: { assetId: setup.accepted.assetId, ownerId: scope.ownerId, projectId: scope.projectId,
        clientKey: 'drawing:' + drawingId, kind: 'drawing', drawingId, sha256: setup.accepted.sha256,
        size: setup.accepted.size, snapshotRevision: 8, fileName: item.fileName, sourceType: 'pdf', source }, validate: () => true });
    await app.records.deltaJournal.confirmMissingDrawingRecovery(ticket);
    const restarted = await app.restart();
    assert.deepEqual(copy(restarted.records.deltaJournal.confirmedDrawingSource(localProjectId, drawingId)), setup.accepted);
    const f = await fixture({ records: restarted.records, localBlob: (await restarted.disk()).get('background:' + drawingId) });
    f.rows[0].sha256 = 'f'.repeat(64);
    assert.equal((await f.run()).status, 'blocked-stale'); assert.equal(f.calls.uploads.length, 0);
    assert.equal(await digest((await restarted.disk()).get('background:' + drawingId)), setup.accepted.sha256);
  });
  console.log('PASS adopted drawing upload guard:', passed, 'actual builder/function regressions');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

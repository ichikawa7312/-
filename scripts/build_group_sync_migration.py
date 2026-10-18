"""Sentlog v1.72 after v1.71: reconcile legacy/grouped metadata without false sync conflicts."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Group-sync build mismatch: {path}: {old[:120]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

# The group migration only adds deterministic metadata to legacy one-sheet drawings.
# Compare snapshots after applying the same defaults on both sides, so the migration
# itself never looks like a concurrent user edit.
p='sentlog/sync-view.js'
change(p,
       "  function snapshotText(payload){\n    const p=clone(payload||{});",
       "  function snapshotText(payload){\n    const groupApi=window.SentlogDrawingGroups;\n    const p=groupApi?.normalizeSnapshotPayload?groupApi.normalizeSnapshotPayload(payload):clone(payload||{});")
change(p,
       "  window.sentlogSyncView={snapshotText,commit,",
       "  window.sentlogSyncView={snapshotText,commit,groupFingerprintSchema:2,")

# Fingerprints made before v1.72 used a different structural representation.
# Force exactly one comparison pass so already-normalized phones repair their sync
# metadata even when the remote revision number itself has not advanced.
p='sentlog/cloud-sync.js'
change(p,
       "const SYNC_META_PREFIX='sentlogCloudProjectSyncV2:';",
       "const SYNC_META_PREFIX='sentlogCloudProjectSyncV2:';\nconst SYNC_FINGERPRINT_SCHEMA=2;")
change(p,
       "function setSyncMeta(projectId,meta){\n  window.SentlogRecords.setItem(SYNC_META_PREFIX+projectId,JSON.stringify(meta||{}));\n}",
       "function setSyncMeta(projectId,meta){\n  window.SentlogRecords.setItem(SYNC_META_PREFIX+projectId,JSON.stringify({...meta,fingerprint_schema:SYNC_FINGERPRINT_SCHEMA}));\n}")
change(p,
       "if(!lp || remoteRev>Number(meta?.revision||0) || !meta){",
       "if(!lp || remoteRev>Number(meta?.revision||0) || !meta || Number(meta?.fingerprint_schema||0)<SYNC_FINGERPRINT_SCHEMA){")

# Fresh URLs/cache markers make sure iPhone Home Screen Safari does not keep the
# pre-fix synchronizer after the app shell itself has updated.
p='sentlog/index.html'
change(p,'drawing-groups.js?v=171','drawing-groups.js?v=172',2)
change(p,'sync-view.js?v=130','sync-view.js?v=172',2)
change(p,'cloud-sync.js?v=20261008-archive-133','cloud-sync.js?v=20261018-group-sync-172',2)
change(p,'phone-runtime.js?v=171','phone-runtime.js?v=172',2)
change(p,"['phone-runtime.js?v=172','v1.71']","['phone-runtime.js?v=172','v1.72']")
change('sentlog/phone-runtime.js','v1.71','v1.72',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v182';","const CACHE='sentlog-pwa-v183';")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.71'","window.SENTLOG_BUILD==='v1.72'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.71'","window.SENTLOG_BUILD==='v1.72'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.71'","'v1.72'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v182','sentlog-pwa-v183')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs','drawing_groups.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=171/);",
           "assert.match(index,/phone-runtime\\.js\\?v=172/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v182/);",
           "assert.match(sw,/sentlog-pwa-v183/);")

change('tests/drawing_groups.test.cjs',
       "assert.match(index,/drawing-groups\\.js\\?v=171/);",
       "assert.match(index,/drawing-groups\\.js\\?v=172/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.72: legacy/grouped snapshot canonicalization + one-time sync fingerprint repair')

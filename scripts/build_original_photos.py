"""Sentlog v1.62 after v1.61: device-local originals, lighter shared photos and PC-layout ZIP export."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Original photo build mismatch: {path}: {old[:90]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


# Load the local-original subsystem before storage UI/cloud sync. The normal
# photo key remains the lightweight copy, so existing sync/PC verification keeps working.
p = 'sentlog/index.html'
change(p, "['image-quality.js?v=161','drawTouchViewport']",
       "['image-quality.js?v=161','drawTouchViewport'],['original-photo-store.js?v=162','SentlogOriginalPhotos']")
change(p, '<script src="./image-quality.js?v=161"><\\/script>',
       '<script src="./image-quality.js?v=161"><\\/script><script src="./original-photo-store.js?v=162"><\\/script>')
change(p, 'phone-runtime.js?v=161', 'phone-runtime.js?v=162', 2)
change(p, "'v1.61'", "'v1.62'")
change('sentlog/phone-runtime.js', 'v1.61', 'v1.62', 4)

# Capacity breakdown: browser quota already includes both IndexedDB databases;
# list device originals explicitly instead of hiding them in "other".
p = 'sentlog/storage-ui.js'
change(p, '/* v1.32: always compare used space against browser quota. Display only. */',
       '/* v1.62: browser quota with shared photos and device-local originals shown separately. */')
chane(p, '#sentlogStorageSection [data-category="photos"]{--sl-storage-color:#e99717;}\n#sentlogStorageSection [data-category="archive"]',
        '#sentlogStorageSection [data-category="photos"]{--sl-storage-color:#e99717;}\n#sentlogStorageSection [data-category="originals"]{--sl-storage-color:#c2410c;}\n#sentlogStorageSection [data-category="archive"]')
change(p, "{key:'photos',name:'写真',amount:sizes.photos,count:sizes.photoCount+'枚'},\n      {key:'archive'",
       "{key:'photos',name:'写真（共有用）',amount:sizes.photos,count:sizes.photoCount+'枚'},\n      {key:'originals',name:'端末原本',amount:sizes.originals,count:sizes.originalCount+'枚'},\n      {key:'archive'")
change(p, "if(usageKnown&&estimate.usage>total)categories[4].amount+=estimate.usage-total;",
       "if(usageKnown&&estimate.usage>total)categories.find(c=>c.key==='other').amount+=estimate.usage-total;")
change(p, "const sizes=await store.stats();\n      if(!sizes||!['records','drawings','photos','archive','other','drawingCount','photoCount'].every(k=>valid(sizes[k])))throw Error('保存データ量を取得できませんでした。');\n      const [estimate,persisted]=await Promise.all([\n        optional(()=>navigator.storage?.estimate?.()),optional(()=>navigator.storage?.persisted?.())\n      ]);\n      sample={sizes,estimate};renderCapacity();",
       "const [sizes,originals]=await Promise.all([store.stats(),window.SentlogOriginalPhotos?.stats?.()||Promise.resolve({bytes:0,count:0})]);\n      if(!sizes||!['records','drawings','photos','archive','other','drawingCount','photoCount'].every(k=>valid(sizes[k])))throw Error('保存データ量を取得できませんでした。');\n      sizes.originals=Number(originals?.bytes)||0;sizes.originalCount=Number(originals?.count)||0;\n      const [estimate,persisted]=await Promise.all([\n        optional(()=>navigator.storage?.estimate?.()),optional(()=>navigator.storage?.persisted?.())\n      ]);\n      sample={sizes,estimate};renderCapacity();")
change(p, '記録・メモ、PDF・図面、写真、移行前の控えは端末内で集計した目安です。',
       '記録・メモ、PDF・図面、共有用写真、端末原本、移行前の控えは端末内で集計した目安です。')

# Offline shell and cache busting.
p = 'sentlog/sw.js'
change(p, "const CACHE='sentlog-pwa-v172';", "const CACHE='sentlog-pwa-v173';")
change(p, "'pdf-quality.js','image-quality.js','sync-view.js'",
       "'pdf-quality.js','image-quality.js','original-photo-store.js','sync-view.js'")

# All browser checks must wait for the final release, not the previous build.
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
    'optional_symbol_ui.py': 2, 'large_image_view_ui.py': 1,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.61'", "window.SENTLOG_BUILD==='v1.62'", count)
change('tests/image_memory_ui.py', "window.SENTLOG_BUILD==='v1.61'", "window.SENTLOG_BUILD==='v1.62'")
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, "'v1.61'", "'v1.62'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v172', 'sentlog-pwa-v173')

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.62: local originals + 1600px/0.78 shared photos + PC-layout ZIP export')

"""Sentlog v1.76 after v1.75: entered edge dimensions override later scale settings.
When page settings are saved, recorded rectangle/polygon edge dimensions are kept
and geometry is reconciled to them. Impossible polygon constraints stay recorded
and are shown/warned instead of being overwritten.
"""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Manual-dimension priority build mismatch: {path}: {old[:140]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,'shape-dimensions.js?v=175','shape-dimensions.js?v=176',2)
change(p,'phone-runtime.js?v=175','phone-runtime.js?v=176',2)
change(p,"['phone-runtime.js?v=176','v1.75']","['phone-runtime.js?v=176','v1.76']")
change('sentlog/phone-runtime.js','v1.75','v1.76',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v186';","const CACHE='sentlog-pwa-v187';")

p='sentlog/part09.txt'
old="""function savePageSettings(){
  let denom=null;if($('drawingScale').value==='custom')denom=Number($('customScale').value)||null;else denom=Number($('drawingScale').value)||null;
  const setting={paperSize:$('paperSize').value,orientation:$('paperOrientation').value,scaleDenom:denom,customW:Number($('customPaperW').value)||null,customH:Number($('customPaperH').value)||null};
  if(denom && !getPaperMm(state.currentPage,setting)){alert('縮尺を使う場合は、用紙サイズを設定してください。');return}
  state.pageSettings[String(state.currentPage)]=setting;persist();updateScaleStatus();closePageSettings();
}"""
new="""function savePageSettings(){
  let denom=null;if($('drawingScale').value==='custom')denom=Number($('customScale').value)||null;else denom=Number($('drawingScale').value)||null;
  const setting={paperSize:$('paperSize').value,orientation:$('paperOrientation').value,scaleDenom:denom,customW:Number($('customPaperW').value)||null,customH:Number($('customPaperH').value)||null};
  if(denom && !getPaperMm(state.currentPage,setting)){alert('縮尺を使う場合は、用紙サイズを設定してください。');return}
  state.pageSettings[String(state.currentPage)]=setting;
  const reconciliation=denom?window.SentlogShapeDimensions?.reconcileManualDimensions?.(state.currentPage):null;
  persist();updateScaleStatus();render();closePageSettings();
  const warning=window.SentlogShapeDimensions?.reconcileWarningMessage?.(reconciliation)||'';
  if(warning)setTimeout(()=>alert(warning),0);
}"""
change(p,old,new)

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.75'","window.SENTLOG_BUILD==='v1.76'",count)
for name in ('image_memory_ui.py','dimension_lines_ui.py','shape_dimensions_ui.py','editable_shape_dimensions_ui.py'):
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.75'","window.SENTLOG_BUILD==='v1.76'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.75'","'v1.76'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v186','sentlog-pwa-v187')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs','drawing_groups.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=175/);",
           "assert.match(index,/phone-runtime\\.js\\?v=176/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v186/);",
           "assert.match(sw,/sentlog-pwa-v187/);")
for name in ('group_sync_migration.test.cjs','dimension_lines.test.cjs','shape_dimensions.test.cjs','editable_shape_dimensions.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=175/);",
           "assert.match(index,/phone-runtime\\.js\\?v=176/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v186/);",
           "assert.match(sw,/sentlog-pwa-v187/);")
change('tests/shape_dimensions.test.cjs',
       "assert.match(index,/shape-dimensions\\.js\\?v=175/);",
       "assert.match(index,/shape-dimensions\\.js\\?v=176/);")
change('tests/editable_shape_dimensions.test.cjs',
       "assert.match(index,/shape-dimensions\\.js\\?v=175/);",
       "assert.match(index,/shape-dimensions\\.js\\?v=176/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.76: entered edge dimensions stay authoritative across scale/paper changes')

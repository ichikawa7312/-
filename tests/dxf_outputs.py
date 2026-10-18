"""Independently parse and audit actual app/browser and core DXF outputs."""
from pathlib import Path
import ezdxf
from ezdxf.lldxf.encoding import decode_dxf_unicode
ROOT=Path(__file__).resolve().parents[1]
paths=list((ROOT/'test-results/dxf').glob('*.dxf'))
assert len(paths)>=6,paths
for p in paths:
 doc=ezdxf.readfile(p);audit=doc.audit()
 assert not audit.errors and not audit.fixes,(p,audit.errors,audit.fixes)
 assert len(doc.modelspace().query('HATCH'))>=1
 assert len(doc.modelspace().query('DIMENSION'))==1
 names={decode_dxf_unicode(e.dxf.layer) for e in doc.modelspace()}
 assert any(n.startswith('メモ_') for n in names),names
 assert not any(n.startswith('SENTLOG') for n in names),names
 print('PASS independent DXF audit',p.name,len(doc.modelspace()),'entities')

# Verify the actual browser capture, not only parser acceptance: original CAD
# coordinates and the editable 1.5m memo segment must agree to sub-micron scale.
doc=ezdxf.readfile(ROOT/'test-results/dxf/browser-records.dxf')
lines=[e for e in doc.modelspace().query('LWPOLYLINE') if e.dxf.layer=='メモ_線']
points=[list(e.get_points('xy')) for e in lines]
assert any(len(p)==2 and abs(p[0][0]-500)<1e-3 and abs(p[0][1]-4500)<1e-3 and abs(p[1][0]-2000)<1e-3 and abs(p[1][1]-4500)<1e-3 for p in points),points
source=ezdxf.readfile(ROOT/'tests/fixtures/dxf-model.dxf')
for entity in source.modelspace():
 assert doc.entitydb[entity.dxf.handle].dxfattribs()==entity.dxfattribs(),entity
assert any(e.plain_text()=='日本語メモ' for e in doc.modelspace().query('MTEXT'))
print('PASS exact memo coordinates, retained original entity attributes and Japanese text')

# Original and new types occupy separate Japanese layers; geometry and fills
# can be selected independently in CAD, without a product prefix.
names={e.dxf.layer for e in doc.modelspace()}
assert {'腐食_図形','腐食_ハッチング','腐食_名称','腐食_寸法','漏水_図形','漏水_名称','メモ_文字','寸法_線','寸法_文字','全景写真_記号','調査_名称'}<=names,names
for e in doc.modelspace():
 if e.dxf.layer.endswith('_ハッチング'):assert e.dxftype()=='HATCH'
 if e.dxf.layer in {'腐食_名称','漏水_名称','寸法_文字','全景写真_名称','調査_名称'}:assert e.dxftype()=='MTEXT'
legacy=ezdxf.readfile(ROOT/'test-results/dxf/browser-cp932.dxf')
assert 'メモ_文字' in {decode_dxf_unicode(e.dxf.layer) for e in legacy.modelspace()}
print('PASS independent CAD layers: damage types, outlines/fills, labels, memos, dimensions, field records, CP932 names')

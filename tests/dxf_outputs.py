"""Independently parse and audit actual app/browser and core DXF outputs."""
from pathlib import Path
import ezdxf
ROOT=Path(__file__).resolve().parents[1]
paths=list((ROOT/'test-results/dxf').glob('*.dxf'))
assert len(paths)>=5,paths
for p in paths:
 doc=ezdxf.readfile(p);audit=doc.audit()
 assert not audit.errors and not audit.fixes,(p,audit.errors,audit.fixes)
 assert len(doc.modelspace().query('HATCH'))>=1
 assert len(doc.modelspace().query('DIMENSION'))==1
 assert any(e.dxf.layer.startswith('SENTLOG') for e in doc.modelspace())
 print('PASS independent DXF audit',p.name,len(doc.modelspace()),'entities')

# Verify the actual browser capture, not only parser acceptance: original CAD
# coordinates and the editable 1.5m memo segment must agree to sub-micron scale.
doc=ezdxf.readfile(ROOT/'test-results/dxf/browser-records.dxf')
lines=[e for e in doc.modelspace().query('LWPOLYLINE') if e.dxf.layer=='SENTLOG_MEMO']
points=[list(e.get_points('xy')) for e in lines]
assert any(len(p)==2 and abs(p[0][0]-500)<1e-3 and abs(p[0][1]-4500)<1e-3 and abs(p[1][0]-2000)<1e-3 and abs(p[1][1]-4500)<1e-3 for p in points),points
source=ezdxf.readfile(ROOT/'tests/fixtures/dxf-model.dxf')
for entity in source.modelspace():
 assert doc.entitydb[entity.dxf.handle].dxfattribs()==entity.dxfattribs(),entity
assert any(e.plain_text()=='日本語メモ' for e in doc.modelspace().query('MTEXT'))
print('PASS exact memo coordinates, retained original entity attributes and Japanese text')

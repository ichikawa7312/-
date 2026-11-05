"""Sentlog v1.96: prevent stale local PDF from overwriting restored cloud drawing.

Runs after the guarded build chain. If the durable background File name differs
from the drawing record's fileName, automatic drawing upload fails closed.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/cloud-sync.js'
s=p.read_text()
old="""  const fileName=item.fileName||item.drawingName||('drawing-'+item.drawingId);
  let optimization={blob,optimized:false,originalSize:blob.size};"""
new="""  const fileName=item.fileName||item.drawingName||('drawing-'+item.drawingId);
  if(blob instanceof File && blob.name && fileName && blob.name!==fileName){
    throw new Error('端末内のPDF「'+blob.name+'」と記録上のPDF「'+fileName+'」が異なるため、自動上書きを停止しました。図面を確認してから差し替えてください。');
  }
  let optimization={blob,optimized:false,originalSize:blob.size};"""
if s.count(old)!=1:
    raise RuntimeError('drawing upload guard integration mismatch: '+str(s.count(old)))
s=s.replace(old,new)
# Existing restored DXF Files may have a generic application/octet-stream type.
# Fix MIME and extension only for actual DXF drawings; preserve original bytes.
replacements=[
    (
        "  const ext=extForBlob(blob,fileName);\n  const storagePath=",
        """  const isDxf=kind==='drawing' && (
    metadata?.source_type==='dxf' || /\\.dxf$/i.test(fileName||'') ||
    /^(?:application\\/(?:x-)?dxf|image\\/(?:x-|vnd\\.)?dxf)$/i.test(blob.type||'')
  );
  const mimeType=isDxf?'application/dxf':(blob.type||'application/octet-stream');
  const ext=isDxf?'.dxf':extForBlob(blob,fileName);
  const storagePath="""
    ),
    (
        "method:'POST',headers:headers({'Content-Type':blob.type||'application/octet-stream','x-upsert':'true'}),body:blob",
        "method:'POST',headers:headers({'Content-Type':mimeType,'x-upsert':'true'}),body:blob"
    ),
    (
        "    mime_type:blob.type||'application/octet-stream',byte_size:blob.size,sha256:hash,status:'uploaded',",
        "    mime_type:mimeType,byte_size:blob.size,sha256:hash,status:'uploaded',"
    )
]
for before,after in replacements:
    if s.count(before)!=1:
        raise RuntimeError('DXF upload MIME integration mismatch: '+str(s.count(before)))
    s=s.replace(before,after,1)
p.write_text(s)
subprocess.run(['node','--check','sentlog/cloud-sync.js'],cwd=ROOT,check=True)
print('Built Sentlog v1.96: guarded drawing uploads with DXF MIME and original PDF/photo support')

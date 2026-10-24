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
p.write_text(s.replace(old,new))
subprocess.run(['node','--check','sentlog/cloud-sync.js'],cwd=ROOT,check=True)
print('Built Sentlog v1.96: mismatched local drawing cannot overwrite cloud drawing')

"""Sentlog v1.97: explicit per-device PDF recovery may replace a mismatched local PDF.

Runs after the normal build chain. The default remains fail-closed: a local PDF
that differs from the cloud asset is never overwritten. The only exception is
an unresolved sentlog_pdf_requests row for the same current device, asset, and
asset SHA. That row is the explicit recovery authorization.
"""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/pdf-recovery.js'
s=p.read_text()

old="""    const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,expected_sha256&limit=1000');
    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));"""
new="""    const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256&limit=1000');
    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));
    const requestedForThisDevice=new Set((requests||[])
      .filter(r=>r.device_id===id)
      .map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));"""
if s.count(old)!=1:
    raise RuntimeError('pdf recovery request integration mismatch: '+str(s.count(old)))
s=s.replace(old,new)

old_line="""        if(blob instanceof Blob && blob.size>0){missing++;differentNames.push(a.file_name||'図面PDF');continue}"""
new_line="""        if(blob instanceof Blob && blob.size>0 && !requestedForThisDevice.has(a.id+':'+String(a.sha256).toLowerCase())){missing++;differentNames.push(a.file_name||'図面PDF');continue}"""
if s.count(old_line)!=1:
    raise RuntimeError('pdf recovery mismatch gate integration mismatch: '+str(s.count(old_line)))
s=s.replace(old_line,new_line)
p.write_text(s)

idx=ROOT/'sentlog/index.html'
x=idx.read_text()
x,n=re.subn(r'pdf-recovery\.js\?v=[0-9A-Za-z._-]+','pdf-recovery.js?v=197',x)
if n<2:
    raise RuntimeError('pdf-recovery loader count unexpected: '+str(n))
idx.write_text(x)

subprocess.run(['node','--check','sentlog/pdf-recovery.js'],cwd=ROOT,check=True)
final=p.read_text()
assert 'select=asset_id,device_id,expected_sha256' in final
assert 'requestedForThisDevice.has' in final
print('Built Sentlog v1.97: explicit per-device PDF recovery may replace mismatched local PDF')

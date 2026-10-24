"""Allow an explicitly requested device to replace a mismatched local PDF with a verified cloud PDF.

This runs after the normal Sentlog build chain. It preserves the default fail-closed
behavior for unsolicited local/cloud PDF mismatches. A replacement is allowed only
when sentlog_pdf_requests contains an unresolved request for the same asset, current
device, and current asset SHA.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/pdf-recovery.js'
s=p.read_text()

old_requests="""    const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,expected_sha256&limit=1000');
    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));"""
new_requests="""    const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256&limit=1000');
    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));
    const requestedForThisDevice=new Set((requests||[])
      .filter(r=>r.device_id===id)
      .map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));"""

old_mismatch="""        // A different local PDF may be an unsent replacement. Never overwrite it.
        if(blob instanceof Blob && blob.size>0){missing++;differentNames.push(a.file_name||'図面PDF');continue}
        await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});
        if(a.status==='storage_deleted'){missing++;missingNames.push(a.file_name||'図面PDF');continue}
        const path=a.storage_path.split('/').map(enc).join('/');
        const downloaded=await(await net('/storage/v1/object/authenticated/'+BUCKET+'/'+path)).blob();
        if(!await matches(downloaded,a))throw new Error('PDFの内容照合に失敗しました');
        const named=new File([downloaded],a.file_name||'drawing.pdf',{type:a.mime_type||'application/pdf'});
        await db('surveyFieldNoteDB','files',fileKey(a),named);
        blob=await localFile(a);
        if(!await matches(blob,a))throw new Error('端末内PDFの保存照合に失敗しました');
        await acknowledge(a,id);available++;
        if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);"""
new_mismatch="""        const requestKey=a.id+':'+String(a.sha256).toLowerCase();
        const explicitRecovery=requestedForThisDevice.has(requestKey);
        // A different local PDF may be an unsent replacement. Never overwrite it
        // unless this exact device has an unresolved recovery request for this
        // exact asset SHA.
        if(blob instanceof Blob && blob.size>0 && !explicitRecovery){
          missing++;differentNames.push(a.file_name||'図面PDF');continue;
        }
        if(!explicitRecovery)await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});
        if(a.status==='storage_deleted'){missing++;missingNames.push(a.file_name||'図面PDF');continue}
        const path=a.storage_path.split('/').map(enc).join('/');
        const downloaded=await(await net('/storage/v1/object/authenticated/'+BUCKET+'/'+path)).blob();
        if(!await matches(downloaded,a))throw new Error('PDFの内容照合に失敗しました');
        const named=new File([downloaded],a.file_name||'drawing.pdf',{type:a.mime_type||'application/pdf'});
        await db('surveyFieldNoteDB','files',fileKey(a),named);
        blob=await localFile(a);
        if(!await matches(blob,a))throw new Error('端末内PDFの保存照合に失敗しました');
        await acknowledge(a,id);available++;
        if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);"""

if s.count(old_requests)!=1:
    raise RuntimeError('pdf recovery request integration mismatch: '+str(s.count(old_requests)))
if s.count(old_mismatch)!=1:
    raise RuntimeError('pdf recovery mismatch integration mismatch: '+str(s.count(old_mismatch)))
s=s.replace(old_requests,new_requests).replace(old_mismatch,new_mismatch)
p.write_text(s)

# Force the Home Screen/browser shell to fetch the updated recovery module.
idx=ROOT/'sentlog/index.html'
x=idx.read_text()
import re
matches=re.findall(r'pdf-recovery\.js\?v=([0-9A-Za-z._-]+)',x)
if not matches:
    raise RuntimeError('pdf-recovery loader not found')
old=matches[0]
x=x.replace('pdf-recovery.js?v='+old,'pdf-recovery.js?v=197')
idx.write_text(x)

subprocess.run(['node','--check','sentlog/pdf-recovery.js'],cwd=ROOT,check=True)
print('Built Sentlog v1.97: explicit per-device PDF recovery may replace mismatched local PDF')

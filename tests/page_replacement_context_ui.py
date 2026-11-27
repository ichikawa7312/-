"""Real PDF page replacement, navigation and native IndexedDB regression.

Run against the canonical built application. PDF.js, PDFLib, the record writer,
navigation and undo are production code. Only small input documents and the
timing of promise completion are synthetic. There are no accounts or external
API calls, no PDF/parser/storage mocks and no transaction-abort injection.

Every condition owns a fresh temporary persistent browser profile. The normal
case closes the complete browser process and reopens its same profile before
undo. Profiles are outside --out, which contains JSON and screenshots only.
Service workers are blocked: this fixture does not test PWA cache behavior,
cloud synchronization, physical storage exhaustion or abrupt power loss.
"""

import argparse
import base64
import functools
import hashlib
import json
import struct
import tempfile
import threading
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PID, A, B = 'page-proof-project', 'page-proof-a', 'page-proof-b'
CASES = ('replace-restart-undo', 'navigate-different-drawing',
         'reopen-same-drawing', 'external-write-during-compose',
         'navigate-after-background-commit', 'external-write-before-rollback')
SOURCE_FILES = ('sentlog/index.html', 'sentlog/page-replacement.js',
                'sentlog/record-store.js', 'sentlog/part04.txt',
                'sentlog/part05.txt', 'sentlog/part06.txt',
                'sentlog/part07.txt', 'sentlog/part08.txt', 'sentlog/part09.txt',
                'sentlog/pdf-quality.js', 'sentlog/image-quality.js',
                'sentlog/sync-view.js', 'sentlog/collaboration-editor.js',
                'sentlog/vendor/export-pdf.min.js',
                'sentlog/vendor/export-pdf.worker.min.js',
                'sentlog/vendor/export-pdf-lib.min.js')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pdf_fixture(labels, color):
    """Deterministic, valid PDF with visible labels and identical page frames."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    font_id = 3 + 2 * len(labels)
    for index, label in enumerate(labels):
        assert label.replace('_', '').isalnum() and label.isascii()
        red, green, blue = color
        stream = (f'{red} {green} {blue} rg 0 0 600 400 re f\n'
                  f'0 0 0 rg BT /F1 22 Tf 30 340 Td ({label}) Tj ET\n'
                  f'0 0 0 RG 2 w 30 {100+index*20} m 530 250 l S\n').encode('ascii')
        page_id = 3 + 2 * index
        objects.extend([
            (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] '
             f'/Resources << /Font << /F1 {font_id} 0 R >> >> '
             f'/Contents {page_id+1} 0 R >>').encode('ascii'),
            b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream'])
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids = ' '.join(f'{3+2*i} 0 R' for i in range(len(labels)))
    objects[1] = f'<< /Type /Pages /Kids [{kids}] /Count {len(labels)} >>'.encode('ascii')
    data, offsets = b'%PDF-1.4\n', [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += str(number).encode() + b' 0 obj\n' + body + b'\nendobj\n'
    start = len(data)
    data += f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode('ascii')
    data += b''.join(f'{offset:010d} 00000 n \n'.encode('ascii') for offset in offsets[1:])
    return data + (f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\n'
                   f'startxref\n{start}\n%%EOF\n').encode('ascii')


def photo_fixture():
    def chunk(kind, data):
        return (struct.pack('!I', len(data)) + kind + data +
                struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('!2I5B', 24, 24, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress((b'\0' + b'\x30\x80\xb0' * 24) * 24)) +
            chunk(b'IEND', b''))


SEED = r"""async inputs=>{
  await window.sentlogAppReady;
  SentlogRecords.assertSafe();
  const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const ids=['page-proof-a','page-proof-b'],pid='page-proof-project';
  const photo=new Blob([decode(inputs.photo)],{type:'image/png'});
  workspace={projects:[{id:pid,name:'PDF差替えの合成検証',createdAt:1700000000000,
    updatedAt:1700000000000,drawings:ids.map((id,i)=>({id,name:'合成図面'+(i+1),
      sourceType:'pdf',fileName:'source-'+(i?'b':'a')+'.pdf',pageCount:2,
      shapeCount:2,photoCount:1,createdAt:1700000000000,updatedAt:1700000000000}))}]};
  for(const [i,id]of ids.entries()){
    const file=new File([decode(i?inputs.b:inputs.a)],'source-'+(i?'b':'a')+'.pdf',
      {type:'application/pdf',lastModified:1700000000000});
    await SentlogRecords.writeFile('background:'+id,file);
    const photoId='proof-photo-'+(i?'b':'a');
    await SentlogRecords.writeFile(photoDBKey(photoId,id),photo);
    const shapes=[1,2].map(page=>SentlogRecordCollaboration.upgrade({
      id:id+'-record-'+page,page,kind:'field-record',recordKind:'field-record',
      recordType:'survey',type:'調査',displayKind:'point',recordNo:page,typeNo:page,
      globalNo:page,autoLabel:'調査-'+page,point:{x:120+page*70,y:220},
      points:[{x:120+page*70,y:220},{x:120+page*70,y:220}],surveyItems:['写真記録'],
      memo:'合成図面'+(i+1)+'の保存済みコメント '+page,
      photos:page===1?[{id:photoId,name:'proof.png',type:'image/png',size:photo.size}]:[]}));
    const model={...freshDrawingState('PDF差替えの合成検証'),sourceType:'pdf',
      fileName:file.name,pageCount:2,currentPage:1,width:600,height:400,shapes,
      nextGlobalNo:3,pageSettings:{'1':{paperSize:'auto',orientation:'auto',scaleDenom:100,
        customW:null,customH:null},'2':{paperSize:'auto',orientation:'auto',scaleDenom:200,
        customW:null,customH:null}},pageRotations:{'1':0,'2':90}};
    SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(model));
  }
  saveWorkspace();await SentlogRecords.settled();SentlogRecords.assertSafe();
  // Warm both real views before the baseline, including collaboration upgrade
  // and render metadata. Subsequent comparisons do not blame normal navigation.
  showDrawings(pid);await openDrawing(pid,ids[1]);
  showDrawings(pid);await openDrawing(pid,ids[0]);
  await SentlogRecords.settled();SentlogRecords.assertSafe();clearAllHistory();
  return {projects:1,drawings:2,pages:4,records:4,photoLinks:2};
}"""


HELPER = r"""inputs=>{
  const pid='page-proof-project',ids=['page-proof-a','page-proof-b'];
  const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const donor=new File([decode(inputs.donor)],'replacement.pdf',{type:'application/pdf',lastModified:1700000000000});
  const external=new File([decode(inputs.external)],'source-a.pdf',{type:'application/pdf',lastModified:1700000000001});
  const canonical=value=>JSON.stringify(sort(value));
  function sort(value){
    if(Array.isArray(value))return value.map(sort);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));
    return value;
  }
  const digest=async (value,key=null)=>{
    try{
      f.readPhase={phase:value instanceof Blob?'blob.arrayBuffer':'text.encode',key,
        bytes:value instanceof Blob?value.size:null,completed:false};
      const bytes=value instanceof Blob?await value.arrayBuffer():new TextEncoder().encode(String(value));
      f.readPhase={phase:'crypto.sha256',key,bytes:bytes.byteLength,completed:false};
      const result=await crypto.subtle.digest('SHA-256',bytes);
      f.readPhase.completed=true;
      return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');
    }catch(error){
      f.readFailure={...f.readPhase,name:error?.name||null,message:String(error?.message||error),stack:String(error?.stack||'')};
      throw error;
    }
  };
  const context=()=>({view:currentView,project:activeProjectId,drawing:activeDrawingId,
    drawingOpenSequence:typeof drawingOpenSequence==='number'?drawingOpenSequence:null,
    fileOpenSequence:typeof drawingFileOpenSequence==='number'?drawingFileOpenSequence:null});
  const f=window.pageReplacementProof={pid,ids,done:true,inOperation:false,gate:null,
    errors:[],events:[],unexpected:null,externalOwner:{fixture:true},readPhase:null,readFailure:null};
  const originalError=console.error;
  console.error=function(...args){
    if(typeof args[0]==='string'&&args[0].startsWith('page replacement'))
      f.errors.push({phase:args[0],code:args[1]?.code||null,message:String(args[1]?.message||args[1])});
    return originalError.apply(this,args);
  };
  function eligible(kind){return f.inOperation&&f.gate?.kind===kind&&!f.gate.used;}
  async function hold(value){
    f.gate.entered=true;f.events.push({event:'gate-entered',kind:f.gate.kind,context:context()});
    await f.gate.wait;
    if(f.gate.fail)throw Error('SYNTHETIC_POST_RENDER_FAILURE');
    return value;
  }
  const originalPdf=window.pdfjsLib,originalGet=originalPdf.getDocument;
  window.pdfjsLib={...originalPdf,getDocument:function(...args){
    const task=originalGet.apply(originalPdf,args);
    if(!eligible('inspect'))return task;
    f.gate.used=true;
    // Real parsing runs to completion. Only promise delivery is held; the
    // document, methods, worker and byte input remain the real PDF.js objects.
    const promise=task.promise.then(hold);
    return new Proxy(task,{get(target,key){
      if(key==='promise')return promise;
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }};
  const originalLoad=PDFLib.PDFDocument.load;
  PDFLib.PDFDocument.load=async function(...args){
    const selected=eligible('compose');if(selected)f.gate.used=true;
    const doc=await originalLoad.apply(this,args);
    if(selected){const save=doc.save;doc.save=function(...values){return Promise.resolve(save.apply(this,values)).then(hold);};}
    return doc;
  };
  const originalOpen=openFile;
  openFile=function(...args){
    const selected=eligible('open-return');if(selected)f.gate.used=true;
    // Keep openFile's synchronous epoch increment; never defer its invocation.
    const pending=originalOpen.apply(this,args);
    return selected?Promise.resolve(pending).then(hold):pending;
  };
  f.arm=kind=>{
    if(!f.done)throw Error('Previous operation still active');
    let release;const wait=new Promise(resolve=>release=resolve);
    f.gate={kind,used:false,entered:false,fail:false,wait,release};
    f.events.push({event:'armed',kind,context:context()});
  };
  f.start=action=>{
    if(!f.done)throw Error('Concurrent test operation');
    f.done=false;f.inOperation=true;f.unexpected=null;
    f.events.push({event:'start',action,context:context()});
    Promise.resolve().then(()=>action==='undo'?SentlogPageReplacement.undoLast():SentlogPageReplacement.replaceCurrentPage(donor))
      .then(()=>{f.inOperation=false;f.done=true;f.events.push({event:'done',action,context:context()});},
        error=>{f.unexpected=String(error?.stack||error);f.inOperation=false;f.done=true;});
  };
  f.release=fail=>{
    if(!f.gate?.entered)throw Error('Timing gate not reached');
    f.gate.fail=!!fail;f.events.push({event:'released',fail:!!fail,context:context()});f.gate.release();
  };
  f.navigate=async id=>{
    showDrawings(pid);await openDrawing(pid,id);await SentlogRecords.settled();SentlogRecords.assertSafe();
    if(activeDrawingId!==id||currentView!=='editor')throw Error('Real navigation did not complete');
    f.events.push({event:'navigation-complete',context:context()});
  };
  f.externalWrite=async()=>{
    const key='background:'+ids[0];
    await SentlogRecords.writeFile(key,external,{ownerToken:f.externalOwner});
    await SentlogRecords.settled();SentlogRecords.assertSafe();
    const [committed]=await SentlogRecords.readFileStates([key]);
    if(!Number.isSafeInteger(committed.sequence)||committed.sequence<1)throw Error('External commit generation missing');
    f.events.push({event:'external-commit',sequence:committed.sequence,sha256:await digest(external),context:context()});
    return {sequence:committed.sequence,sha256:await digest(external),bytes:external.size};
  };
  f.pdfTexts=async id=>{
    const value=await getDBFile('background:'+id);
    if(!(value instanceof Blob))throw Error('Native PDF is missing');
    const doc=await pdfjsLib.getDocument({data:new Uint8Array(await value.arrayBuffer())}).promise;
    try{const pages=[];for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n),text=await page.getTextContent();
      pages.push(text.items.map(item=>item.str).join(' ').trim());
    }return pages;}finally{await doc.destroy();}
  };
  f.snapshot=async()=>{
    f.readFailure=null;f.readPhase={phase:'records.settled',key:null,completed:false};
    await SentlogRecords.settled();SentlogRecords.assertSafe();
    const recordKeys=[WORKSPACE_KEY,...ids.map(drawingStorageKey)];
    const fileKeys=[...ids.map(id=>'background:'+id),
      ...ids.map((id,i)=>photoDBKey('proof-photo-'+(i?'b':'a'),id)),
      'page-replace-backup:'+ids[0],'page-replace-backup-meta:'+ids[0]];
    const allKeys=[...recordKeys.map(key=>'__sentlog_record__:'+key),...fileKeys];
    f.readPhase={phase:'database.open',key:null,completed:false};
    const db=await SentlogRecords.openFilesDatabase();let rows;
    f.readPhase={phase:'files.readonly',key:null,completed:false};
    try{rows=await new Promise((resolve,reject)=>{
      const tx=db.transaction('files','readonly'),store=tx.objectStore('files'),values={};
      for(const key of allKeys){const request=store.get(key);request.onsuccess=()=>{values[key]=request.result;};}
      tx.oncomplete=()=>resolve(values);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Readonly snapshot aborted'));
    });}finally{db.close();}
    const records={},files={};
    for(const key of recordKeys){
      const text=rows['__sentlog_record__:'+key];
      if(typeof text!=='string')throw Error('Durable record missing: '+key);
      if(text!==SentlogRecords.getItem(key))throw Error('Native/memory record mismatch: '+key);
      const parsed=JSON.parse(text);
      records[key]={bytes:new TextEncoder().encode(text).length,sha256:await digest(text,'__sentlog_record__:'+key)};
      if(key!==WORKSPACE_KEY){
        const protectedValue={shapes:parsed.shapes,pageSettings:parsed.pageSettings,
          pageRotations:parsed.pageRotations,nextGlobalNo:parsed.nextGlobalNo,typeCounters:parsed.typeCounters};
        Object.assign(records[key],{protectedSha256:await digest(canonical(protectedValue),'protected:'+key),
          shapeCount:parsed.shapes.length,photoCount:parsed.shapes.reduce((n,s)=>n+(s.photos||[]).length,0),
          commentCount:parsed.shapes.reduce((n,s)=>n+SentlogRecordCollaboration.view(s).comments.filter(c=>!c.deleted).length,0),
          pageCount:parsed.pageCount,pageReplacements:parsed.pageReplacements||{},
          pageSettings:parsed.pageSettings,pageRotations:parsed.pageRotations});
      }
    }
    for(const key of fileKeys){
      const value=rows[key];files[key]=value==null?null:{bytes:value.size,type:value.type,
        name:value.name||null,isBlob:value instanceof Blob,isFile:value instanceof File,
        sha256:await digest(value,key)};
    }
    const metaKey='page-replace-backup-meta:'+ids[0],meta=rows[metaKey],contextAtRead=context();
    let backupMeta=null;
    f.readPhase={phase:'blob.text',key:metaKey,bytes:meta?.size??null,completed:false};
    try{backupMeta=meta instanceof Blob?JSON.parse(await meta.text()):null;f.readPhase.completed=true;}
    catch(error){f.readFailure={...f.readPhase,name:error?.name||null,message:String(error?.message||error),stack:String(error?.stack||'')};throw error;}
    f.readPhase={phase:'file-sequences.readonly',key:null,completed:false};
    const fileStates=await SentlogRecords.readFileStates(fileKeys);f.readPhase.completed=true;
    return {context:contextAtRead,records,files,backupMeta,fileStates,pending:SentlogRecords.pending,
      failed:SentlogRecords.failed,importing:!!window.sentlogImporting,
      errors:[...f.errors],events:[...f.events],unexpected:f.unexpected};
  };
  return {navigationGuardVersion:SentlogPageReplacement.navigationGuardVersion,
    fileCapabilities:SentlogRecords.getFileWriteCapabilities(),pdfjsVersion:pdfjsLib.version};
}"""


def preserved(snapshot, baseline):
    for drawing in (A, B):
        key = 'surveyFieldNoteDrawingV1:' + drawing
        observed, expected = snapshot['records'][key], baseline['records'][key]
        assert observed['protectedSha256'] == expected['protectedSha256'], ('record content changed', drawing)
        assert observed['shapeCount'] == 2 and observed['photoCount'] == 1 and observed['commentCount'] == 2, observed
        assert observed['pageCount'] == 2, observed
        photo_key = 'photo:' + drawing + ':proof-photo-' + ('a' if drawing == A else 'b')
        assert snapshot['files'][photo_key] == baseline['files'][photo_key], ('photo changed', drawing)
    assert snapshot['files']['background:' + B] == baseline['files']['background:' + B], 'Other PDF changed'
    assert not snapshot['failed'] and not snapshot['pending'], snapshot
    assert snapshot['unexpected'] is None, snapshot['unexpected']


def same_records(after, before):
    assert after['records'] == before['records'], 'Managed records changed after the held operation resumed'


def run_case(page, restart, row, inputs, expected, save):
    row['stage'] = 'seed'
    row['seed'] = page.evaluate(SEED, inputs)
    row['capabilities'] = page.evaluate(HELPER, {'donor': inputs['donor'], 'external': inputs['external']})
    assert row['capabilities']['navigationGuardVersion'] == 1, row['capabilities']
    assert row['capabilities']['fileCapabilities']['expectedFileStatesVersion'] == 1, row['capabilities']
    baseline = row['baseline'] = page.evaluate('pageReplacementProof.snapshot()')
    assert baseline['files']['background:' + A]['sha256'] == expected['a']['sha256']
    assert baseline['files']['background:' + B]['sha256'] == expected['b']['sha256']
    preserved(baseline, baseline)
    assert baseline['backupMeta'] is None
    save()

    def complete():
        page.wait_for_function('pageReplacementProof.done', timeout=60000)
        assert page.evaluate('pageReplacementProof.unexpected') is None
        result = page.evaluate('pageReplacementProof.snapshot()')
        assert not result['importing'], 'Replacement import flag was left active'
        return result

    name = row['name']
    if name == 'replace-restart-undo':
        row['stage'] = 'replace'
        page.evaluate("pageReplacementProof.start('replace')")
        replaced = row['replaced'] = complete()
        preserved(replaced, baseline)
        assert not replaced['errors'], replaced['errors']
        current_hash = replaced['files']['background:' + A]['sha256']
        assert current_hash != expected['a']['sha256']
        assert replaced['files']['page-replace-backup:' + A]['sha256'] == expected['a']['sha256']
        meta = replaced['backupMeta']
        assert meta['applied'] and meta['drawingId'] == A and meta['replacementHash'] == current_hash, meta
        assert meta['sourceHash'] == expected['a']['sha256'], meta
        background_sequence = next(item['sequence'] for item in replaced['fileStates'] if item['key'] == 'background:' + A)
        assert meta['replacementSequence'] == background_sequence, 'Undo metadata must identify the committed background generation'
        marker = replaced['records']['surveyFieldNoteDrawingV1:' + A]['pageReplacements']['1']
        assert marker['revision'] == 1 and marker['restored'] is False and marker['pdfHash'] == current_hash, marker
        row['replacementPageTexts'] = page.evaluate('pageReplacementProof.pdfTexts(pageReplacementProof.ids[0])')
        assert row['replacementPageTexts'] == ['DONOR_PAGE_1', 'SOURCE_A_PAGE_2'], row['replacementPageTexts']
        save()
        row['stage'] = 'full-browser-restart'
        page = restart(page)
        row['restartCapabilities'] = page.evaluate(HELPER, {'donor': inputs['donor'], 'external': inputs['external']})
        page.evaluate('pageReplacementProof.navigate(pageReplacementProof.ids[0])')
        restarted = row['restarted'] = page.evaluate('pageReplacementProof.snapshot()')
        preserved(restarted, baseline)
        assert restarted['files'] == replaced['files'], 'Native PDF/backup/photo changed across process restart'
        assert restarted['backupMeta'] == replaced['backupMeta']
        assert restarted['records']['surveyFieldNoteDrawingV1:' + A]['pageReplacements'] == replaced['records']['surveyFieldNoteDrawingV1:' + A]['pageReplacements']
        row['stage'] = 'undo'
        page.evaluate("pageReplacementProof.start('undo')")
        restored = row['restored'] = complete()
        preserved(restored, baseline)
        assert not restored['errors'], restored['errors']
        assert restored['files']['background:' + A]['sha256'] == expected['a']['sha256'], 'Undo must recover exact original bytes'
        assert restored['backupMeta']['applied'] is False, restored['backupMeta']
        marker = restored['records']['surveyFieldNoteDrawingV1:' + A]['pageReplacements']['1']
        assert marker['revision'] == 2 and marker['restored'] is True and marker['pdfHash'] == expected['a']['sha256'], marker
        row['restoredPageTexts'] = page.evaluate('pageReplacementProof.pdfTexts(pageReplacementProof.ids[0])')
        assert row['restoredPageTexts'] == ['SOURCE_A_PAGE_1', 'SOURCE_A_PAGE_2']
        row['assertions'] = ['real composition replaced only page one', 'records/photos/settings preserved',
                             'same-profile full process restart readback', 'undo restored original PDF SHA256']
    else:
        gate = ('inspect' if name in ('navigate-different-drawing', 'reopen-same-drawing') else
                'compose' if name == 'external-write-during-compose' else 'open-return')
        row['stage'] = 'await-' + gate
        page.evaluate('(kind)=>pageReplacementProof.arm(kind)', gate)
        page.evaluate("pageReplacementProof.start('replace')")
        page.wait_for_function('pageReplacementProof.gate?.entered||pageReplacementProof.done', timeout=60000)
        assert page.evaluate('pageReplacementProof.gate?.entered'), page.evaluate('pageReplacementProof.snapshot()')
        row['atGate'] = page.evaluate('pageReplacementProof.snapshot()')
        if gate == 'open-return':
            assert row['atGate']['files']['background:' + A]['sha256'] != expected['a']['sha256'], 'Gate must follow a real background commit'
            assert row['atGate']['backupMeta']['applied'] is False, 'The marker-completion boundary must not have run'
        row['stage'] = 'interleave'
        if name in ('navigate-different-drawing', 'navigate-after-background-commit'):
            page.evaluate('(id)=>pageReplacementProof.navigate(id)', B)
        elif name == 'reopen-same-drawing':
            before_epoch = row['atGate']['context']['drawingOpenSequence']
            page.evaluate('(id)=>pageReplacementProof.navigate(id)', A)
            assert page.evaluate('drawingOpenSequence') > before_epoch, 'Same ID must really reopen'
        else:
            row['externalCommit'] = page.evaluate('pageReplacementProof.externalWrite()')
            assert row['externalCommit']['sha256'] == expected['external']['sha256']
            previous_sequence = next(item['sequence'] for item in row['atGate']['fileStates'] if item['key'] == 'background:' + A)
            assert row['externalCommit']['sequence'] > previous_sequence, 'External write must commit a newer native generation'
        before_release = row['beforeRelease'] = page.evaluate('pageReplacementProof.snapshot()')
        save()
        row['stage'] = 'release-and-observe'
        page.evaluate('(fail)=>pageReplacementProof.release(fail)', name == 'external-write-before-rollback')
        final = row['final'] = complete()
        preserved(final, baseline)
        same_records(final, before_release)
        assert final['context'] == before_release['context'], 'Rejected operation reopened or changed the active drawing'
        assert final['errors'], 'Expected rejection was not observed'
        codes = {error['code'] for error in final['errors']}
        if name != 'external-write-before-rollback':
            assert codes & {'PAGE_REPLACEMENT_CHANGED', 'JOURNAL_FILE_CHANGED'}, final['errors']
        else:
            assert any(error['message'] == 'SYNTHETIC_POST_RENDER_FAILURE' for error in final['errors']), final['errors']
            assert any(error['phase'] == 'page replacement rollback' and error['code'] in
                       ('PAGE_REPLACEMENT_CHANGED', 'JOURNAL_FILE_CHANGED') for error in final['errors']), final['errors']
        external_expected = name in ('external-write-during-compose', 'external-write-before-rollback')
        expected_hash = expected['external' if external_expected else 'a']['sha256']
        assert final['files']['background:' + A]['sha256'] == expected_hash, 'Original/newer background was overwritten'
        if gate == 'inspect':
            assert final['files']['page-replace-backup:' + A] is None and final['backupMeta'] is None
        else:
            assert final['files']['page-replace-backup:' + A]['sha256'] == expected['a']['sha256']
            assert final['backupMeta']['applied'] is False
        row['assertions'] = ['timing boundary reached', 'real interleaved navigation/write completed',
                             'all managed record SHA unchanged after release', 'other drawing/photo bytes unchanged',
                             'newer background retained' if external_expected else 'original background retained/restored']
    row.update(status='passed', stage='complete')
    save()
    return page


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--browser-executable', type=Path)
    args = parser.parse_args()
    root, out = args.built_root.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    sources = {name: {'bytes': (root/name).stat().st_size, 'sha256': sha((root/name).read_bytes())}
               for name in SOURCE_FILES}
    data = {'a': pdf_fixture(['SOURCE_A_PAGE_1', 'SOURCE_A_PAGE_2'], (.94, .97, 1)),
            'b': pdf_fixture(['SOURCE_B_PAGE_1', 'SOURCE_B_PAGE_2'], (1, .97, .90)),
            'donor': pdf_fixture(['DONOR_PAGE_1'], (.82, 1, .86)),
            'external': pdf_fixture(['EXTERNAL_PAGE_1', 'EXTERNAL_PAGE_2'], (1, .84, .84)),
            'photo': photo_fixture()}
    expected = {name: {'bytes': len(value), 'sha256': sha(value)} for name, value in data.items()}
    inputs = {name: base64.b64encode(value).decode('ascii') for name, value in data.items()}
    report = {'schema': 'sentlog-page-replacement-context-native-v1', 'engine': args.engine,
              'status': 'running', 'testSource': {'bytes': Path(__file__).stat().st_size,
                                               'sha256': sha(Path(__file__).read_bytes())},
              'sourceManifest': sources, 'syntheticInputs': expected, 'conditions': [],
              'scope': {'realPdfEngines': True, 'nativeIndexedDB': True, 'productionNavigation': True,
                        'actionDelivery': 'production replaceCurrentPage/undoLast and showDrawings/openDrawing APIs',
                        'cloudOrUserData': False, 'serviceWorkers': 'blocked',
                        'faultModel': 'promise completion held after real parse/compose/render; final case throws after actual openFile returns',
                        'restartModel': 'normal case: complete browser process restart, same persistent profile',
                        'limits': ['no cloud/auth/multi-device transport', 'no PWA cache assertion',
                                   'no actual disk failure or abrupt power loss', 'synthetic documents only']}}

    def save():
        (out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *unused):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    save()
    try:
        with sync_playwright() as playwright:
            for name in CASES:
                row = {'name': name, 'status': 'running', 'stage': 'browser-launch',
                       'browserErrors': [], 'consoleErrors': [], 'dialogs': [], 'blockedRequests': [], 'restarts': []}
                report['conditions'].append(row)
                save()
                context = page = None
                # Profile data is intentionally never included in the artifact directory.
                with tempfile.TemporaryDirectory(prefix='sentlog-page-context-') as profile:
                    def route(request):
                        url = request.request.url
                        if url.startswith(origin+'/') or url.startswith('blob:'+origin+'/') or url.startswith('data:'):
                            request.continue_()
                        elif urlsplit(url).netloc == 'cdnjs.cloudflare.com' and urlsplit(url).path.startswith('/ajax/libs/pdf.js/'):
                            vendor = 'export-pdf.worker.min.js' if 'worker' in urlsplit(url).path else 'export-pdf.min.js'
                            request.fulfill(content_type='text/javascript', body=(root/'sentlog/vendor'/vendor).read_bytes())
                        else:
                            row['blockedRequests'].append({'url': url, 'method': request.request.method})
                            request.abort()

                    def launch():
                        options = {'headless': True, 'viewport': {'width': 1180, 'height': 840},
                                   'service_workers': 'block', 'accept_downloads': False}
                        if args.browser_executable:
                            options['executable_path'] = str(args.browser_executable)
                        if args.engine == 'chromium':
                            options['args'] = ['--no-sandbox', '--disable-dev-shm-usage']
                        created = getattr(playwright, args.engine).launch_persistent_context(profile, **options)
                        created.route('**/*', route)
                        row['browserVersion'] = created.browser.version if created.browser else 'persistent-context'
                        return created

                    def open_page(created):
                        nonlocal page
                        page = created.pages[0] if created.pages else created.new_page()
                        page.on('pageerror', lambda error: row['browserErrors'].append(str(error)))
                        page.on('console', lambda message: row['consoleErrors'].append(message.text)
                                if message.type == 'error' and len(row['consoleErrors']) < 80 else None)

                        def dialog(value):
                            row['dialogs'].append({'type': value.type, 'message': value.message})
                            value.accept()

                        page.on('dialog', dialog)
                        page.goto(origin+'/sentlog/', wait_until='domcontentloaded', timeout=60000)
                        page.wait_for_function('window.sentlogAppReady&&window.SentlogPageReplacement&&window.SentlogRecordCollaboration&&window.sentlogSyncView', timeout=45000)
                        page.evaluate('async()=>{await sentlogAppReady;SentlogRecords.assertSafe();pdfjsLib.GlobalWorkerOptions.workerSrc="./vendor/export-pdf.worker.min.js";}')
                        row.setdefault('userAgents', []).append(page.evaluate('navigator.userAgent'))
                        page.add_script_tag(url=origin+'/sentlog/vendor/export-pdf-lib.min.js')
                        assert page.evaluate('!!window.PDFLib?.PDFDocument&&!!window.pdfjsLib?.getDocument')
                        return page

                    def restart(previous):
                        nonlocal context
                        live = [item for item in context.pages if not item.is_closed()]
                        assert live == [previous], 'Unexpected page owns the profile at restart'
                        row['restarts'].append({'beforeClosed': previous.is_closed(), 'openPages': len(live),
                                                'method': 'close persistent context/browser process and relaunch same profile'})
                        context.close()
                        assert previous.is_closed()
                        row['restarts'][-1]['afterClosed'] = previous.is_closed()
                        context = launch()
                        return open_page(context)

                    try:
                        context = launch()
                        page = open_page(context)
                        page = run_case(page, restart, row, inputs, expected, save)
                        assert not row['browserErrors'], row['browserErrors']
                        assert not row['blockedRequests'], row['blockedRequests']
                        page.screenshot(path=str(out/(name+'.png')), full_page=True)
                        row['screenshot'] = name+'.png'
                    except Exception as error:
                        row.update(status='failed', error=str(error))
                        if page is not None and not page.is_closed():
                            try:
                                row['failureState'] = page.evaluate('''()=>({view:typeof currentView==='undefined'?null:currentView,
                                  drawing:typeof activeDrawingId==='undefined'?null:activeDrawingId,
                                  error:document.getElementById('errorBanner')?.textContent,
                                  ready:!!window.SentlogRecords?.ready,failed:!!window.SentlogRecords?.failed,
                                  done:window.pageReplacementProof?.done,gate:window.pageReplacementProof?.gate?
                                    {kind:pageReplacementProof.gate.kind,used:pageReplacementProof.gate.used,entered:pageReplacementProof.gate.entered}:null,
                                  events:window.pageReplacementProof?.events,errors:window.pageReplacementProof?.errors,
                                  nativeReadPhase:window.pageReplacementProof?.readPhase,
                                  nativeReadFailure:window.pageReplacementProof?.readFailure})''')
                                page.screenshot(path=str(out/(name+'-failure.png')), full_page=True, timeout=10000)
                            except Exception as diagnostic_error:
                                row['diagnosticError'] = str(diagnostic_error)
                    finally:
                        save()
                        if context is not None:
                            context.close()
                print(f"{row['status'].upper()} {args.engine} {name}: {row.get('error', 'native assertions complete')}", flush=True)
        report['passed'] = sum(row['status'] == 'passed' for row in report['conditions'])
        report['failed'] = sum(row['status'] != 'passed' for row in report['conditions'])
        report['status'] = 'passed' if report['passed'] == len(CASES) else 'failed'
        save()
    finally:
        server.shutdown()
        server.server_close()
        save()
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())

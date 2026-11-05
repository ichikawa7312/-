"""Allow DXF diagrams with >1,000,000 physical lines without a second line index.

Run after build_dxf_size.py and the existing raster sync integration.
The guarded source baseline remains untouched, as do user CAD files/records.
"""
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
core=ROOT/'sentlog/dxf-core.js'
text=core.read_text(encoding='utf-8')
old=r""" const lines=[];const re=/([^\r\n]*)(\r\n|\n|\r|$)/g;let m;
 while((m=re.exec(raw))&&m[0])lines.push({value:m[1],start:m.index,end:re.lastIndex});
 while(lines.length&&lines.at(-1).value==='')lines.pop();
 if(lines.length%2)throw Error('DXFのデータが途中で終わっています。');
 if(lines.length>1000000)throw Error('図面要素が多すぎます。図面を分割してください。');
 const tags=[];for(let i=0;i<lines.length;i+=2){const code=Number(lines[i].value.trim());if(!Number.isInteger(code)||!lines[i].value.trim())throw Error('DXFのグループコードが正しくありません。');tags.push({code,value:lines[i+1].value,start:lines[i].start,valueStart:lines[i+1].start,valueEnd:lines[i+1].start+lines[i+1].value.length,end:lines[i+1].end});}
"""
new=r""" // Parse code/value pairs directly: keeping a separate object for every
 // physical line previously exhausted memory before the DXF engine ran.
 // The 25 MiB byte limit remains in force for safe offline devices.
 const tags=[],re=/([^\r\n]*)(\r\n|\n|\r|$)/g;let codeLine;
 while((codeLine=re.exec(raw))&&codeLine[0]){
   // Ignore only trailing blank lines, not malformed interior group codes.
   if(codeLine[1]===''&&raw.slice(codeLine.index).trim()==='')break;
   const codeText=codeLine[1].trim(),code=Number(codeText);
   if(!codeText||!Number.isInteger(code))throw Error('DXFのグループコードが正しくありません。');
   const valueLine=re.exec(raw);
   if(!valueLine||!valueLine[0])throw Error('DXFのデータが途中で終わっています。');
   tags.push({code,value:valueLine[1],start:codeLine.index,valueStart:valueLine.index,
     valueEnd:valueLine.index+valueLine[1].length,end:re.lastIndex});
   // This is a structural safety bound on DXF tag pairs, not on line count.
   if(tags.length>1500000)throw Error('DXFのデータ量が端末の安全上限を超えています（150万組超）。');
 }
"""
if text.count(old)!=1:
    raise RuntimeError('DXF scanning integration point moved (match='+str(text.count(old))+')')
core.write_text(text.replace(old,new,1),encoding='utf-8')

# Force the latest scanner into existing browsers, even if older v205 is cached.
loader=ROOT/'sentlog/index.html'
html=loader.read_text(encoding='utf-8')
old_src='dxf-core.js?v=205'
if html.count(old_src)!=2:
    raise RuntimeError('DXF core loader version mismatch (match='+str(html.count(old_src))+')')
loader.write_text(html.replace(old_src,'dxf-core.js?v=206'),encoding='utf-8')

sw=ROOT/'sentlog/sw.js'
worker=sw.read_text(encoding='utf-8')
version=re.search(r'sentlog-pwa-v(\d+)',worker)
if not version:raise RuntimeError('Service worker version missing')
old_cache=version.group(0)
new_cache='sentlog-pwa-v'+str(int(version.group(1))+1)
sw.write_text(worker.replace(old_cache,new_cache),encoding='utf-8')

for test in (ROOT/'tests').iterdir():
    if test.suffix not in ('.cjs','.py'):continue
    source=test.read_text(encoding='utf-8')
    changed=source.replace(old_src,'dxf-core.js?v=206').replace(
        r'dxf-core\.js\?v=205',r'dxf-core\.js\?v=206').replace(old_cache,new_cache)
    if changed!=source:test.write_text(changed,encoding='utf-8')

subprocess.run(['node','--check','sentlog/dxf-core.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/dxf_dense.test.cjs'],cwd=ROOT,check=True)
print('DXF scanner: over 1 million physical lines accepted with bounded pair parsing and no duplicate line index')

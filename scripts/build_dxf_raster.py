"""Build the DXF reference raster viewer after all guarded Sentlog builds.
This stage preserves DXF bytes, existing annotations and existing synchronization checks.
"""
from pathlib import Path
import re
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
    p=ROOT/path
    current=p.read_text()
    if current.count(old)!=count:
        raise RuntimeError('DXF raster integration mismatch '+str(path)+': '+str(current.count(old))+' for '+old[:90])
    p.write_text(current.replace(old,new,count))

# Pin the TIFF decoder. A separate cached, local copy makes the viewer work offline.
vendor=ROOT/'sentlog/vendor'
vendor.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as temporary:
    subprocess.run(['npm','install','--no-audit','--no-fund','--ignore-scripts','--no-save','--prefix',temporary,'utif@3.1.0'],check=True)
    decoder=Path(temporary)/'node_modules/utif/UTIF.js'
    if not decoder.exists(): raise RuntimeError('UTIF package entry is missing')
    (vendor/'UTIF.js').write_bytes(decoder.read_bytes())

# Keep the new parser and picker after the DXF engine, before cloud sync.
idx=ROOT/'sentlog/index.html'
s=idx.read_text()
anchor='<script src="./dxf.js?v=178"><\\/script>'
if s.count(anchor)!=1: raise RuntimeError('DXF raster runtime loader anchor changed')
s=s.replace(anchor,anchor+'<script src="./dxf-image-refs.js?v=211"><\\/script><script src="./dxf-raster.js?v=211"><\\/script>')
needle="const deps=["
if s.count(needle)!=1:raise RuntimeError('DXF raster preflight anchor changed')
s=s.replace(needle,needle+"['dxf-image-refs.js?v=211','SentlogDxfImageRefs'],['dxf-raster.js?v=211','SentlogDxfRaster'],")
# Sync script also gets a new URL, so old cached builds cannot be mixed.
s,n=re.subn(r'cloud-sync\.js\?v=[\w.-]+','cloud-sync.js?v=20261105-raster-211',s)
if n!=2:raise RuntimeError('Unexpected cloud-sync bootstrap count')
idx.write_text(s)

# Inject into the production-equivalent, fully built sync module, after all
# existing original-PDF and conflict-protection transformations.
p=ROOT/'sentlog/cloud-sync.js'
sync=p.read_text()
ref_pull="""    if(a.kind!=='drawing'&&a.kind!=='photo')continue;"""
insert_pull="""    if(a.kind==='other'&&a.metadata?.reference_type==='dxf-raster'){
      const handle=String(a.metadata?.reference_handle||'');
      if(!/^[0-9a-f]+$/i.test(handle))continue;
      const rasterKey='dxf-raster:'+drawingId+':'+handle;
      try{
        await window.SentlogSyncTraffic.withFileLock(rasterKey,async()=>{
          const local=await dbGet(rasterKey);
          const same=local instanceof Blob&&local.size===Number(a.byte_size)&&
            (await sha256Hex(local)).toLowerCase()===String(a.sha256).toLowerCase();
          if(!same){
            if(local instanceof Blob&&local.size)throw Error('端末内の参照画像が異なります。自動上書きはしません。');
            const remote=await downloadPrivateAsset(a);
            const named=new File([remote],a.file_name||'reference.png',{type:a.mime_type||'image/png'});
            await dbPut(rasterKey,named);
            const stored=await dbGet(rasterKey);
            if(!(stored instanceof Blob)||stored.size!==Number(a.byte_size)||
                (await sha256Hex(stored)).toLowerCase()!==String(a.sha256).toLowerCase())
              throw Error('参照画像の保存照合に失敗しました。');
            received++;
            window.SentlogDxfRaster?.received(drawingId,handle);
          }
          if(a.source_device_id!==deviceId)await ackAsset(a,deviceId,!same);
        });
      }catch(e){errors.push((a.file_name||'参照画像')+'：'+e.message);}
      continue;
    }
"""
if sync.count(ref_pull)!=1:raise RuntimeError('DXF raster receiving branch anchor mismatch')
sync=sync.replace(ref_pull,insert_pull+ref_pull)
ref_upload="""      for(const item of collectPhotos(lp)){
        const r=await uploadPhoto(cp,deviceId,item,knownAssets);
        if(r.status==='uploaded')uploaded++;
      }"""
insert_upload="""      for(const item of window.SentlogDxfRaster?.collect(lp)||[]){
        try{
          const original=await dbGet('dxf-raster:'+item.drawingId+':'+item.handle);
          if(!(original instanceof Blob))throw Error('端末内に画像がありません');
          const r=await uploadAsset({
            cloudProject:cp,deviceId,knownAssets,kind:'other',
            clientKey:'dxf-raster:'+item.drawingId+':'+item.handle,
            fileName:item.fileName||'reference.png',blob:original,storageFolder:'references',
            metadata:{reference_type:'dxf-raster',reference_handle:item.handle,drawing_id:item.drawingId}
          });
          if(r.status==='uploaded')uploaded++;
        }catch(e){drawingErrors.push((item.fileName||'DXF参照画像')+'：'+e.message);}
      }
"""
if sync.count(ref_upload)!=1:raise RuntimeError('DXF raster upload loop anchor mismatch')
sync=sync.replace(ref_upload,ref_upload+'\n'+insert_upload)
p.write_text(sync)

# Cache only static JS and the TIFF decoder, never customer DXF or images.
sw=ROOT/'sentlog/sw.js'
s=sw.read_text()
s,n=re.subn(r"const CACHE='sentlog-pwa-v(\d+)'",lambda m:"const CACHE='sentlog-pwa-v"+str(int(m.group(1))+1)+"'",s)
if n!=1:raise RuntimeError('DXF raster cache version missing')
s=s.replace("const FILES=[","const FILES=['dxf-image-refs.js','dxf-raster.js','vendor/UTIF.js',",1)
sw.write_text(s)

subprocess.run(['node','--check','sentlog/dxf-image-refs.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/dxf-raster.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/cloud-sync.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/dxf-image-refs.test.cjs'],cwd=ROOT,check=True)
print('DXF raster image reference display and cloud delivery build checks passed')

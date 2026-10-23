"""Actual browser IndexedDB/Web Locks test. Synthetic receipts only; no cloud calls."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import functools, os, threading
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  options={'headless':True}
  if os.environ.get('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**options)
  context=browser.new_context()
  context.route('**/traffic-harness.html',lambda r:r.fulfill(content_type='text/html',body='<html><script src="/sentlog/sync-traffic.js"></script></html>'))
  page=context.new_page();page.goto(base+'/traffic-harness.html')
  def run():
   return page.evaluate('''async()=>{
    localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({user:{id:'synthetic-owner'}}));
    let calls=0;const send=async()=>{calls++;return {received:true};};
    const asset={id:'browser-asset',sha256:'a'.repeat(64),byte_size:42,storage_path:'test/file'};
    for(let cycle=0;cycle<4;cycle++)await Promise.all(Array.from({length:25},()=>SentlogSyncTraffic.ack('photo',asset,'synthetic-device',send)));
    return {calls,version:SentlogSyncTraffic.version,webLocks:!!navigator.locks};
   }''')
  first=run();assert first=={'calls':1,'version':'v1.90','webLocks':True},first
  page.reload();second=run();assert second['calls']==0,second
  # A new delivery needs a fresh ACK, even with identical content.
  changed=page.evaluate('''async()=>{
   let calls=0;await SentlogSyncTraffic.ack('photo',{id:'browser-asset',sha256:'a'.repeat(64),byte_size:42,storage_path:'test/new-delivery'},'synthetic-device',async()=>{calls++;return {received:true};});
   return calls;
  }''');assert changed==1
  # A cache transaction is durable across document reload, not just an in-memory Set.
  names=page.evaluate('async()=> (await indexedDB.databases()).map(d=>d.name)')
  assert names==['sentlogSyncTrafficV1'],names
  print('PASS Chromium: real IndexedDB persistence after reload, concurrent ACK=1, changed delivery ACK=1, actual Web Locks, no user database mutation')
  browser.close()
finally:server.shutdown()

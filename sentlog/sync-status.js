/* v1.27: presentation only. Polling, file storage and synchronization stay in cloud-sync.js. */
export function createSyncStatusView(doc = document) {
  const SHOW_DELAY = 1200, MIN_VISIBLE = 900;
  let account = '', online = true, cycle = 0, running = false;
  let transfers = 0, operation = '', phase = 'idle', lastSuccess = null;
  let outcome = { level:'ok', message:'この起動後は、まだ同期を確認していません。' };
  let visible = false, shownAt = 0, showTimer = null, hideTimer = null;
  let button, label, detail, detailPhase, detailTime, detailResult;
  const text = (el, value) => { if(el && el.textContent !== value) el.textContent = value; };
  const attr = (el, key, value) => { if(el && el.getAttribute(key) !== value) el.setAttribute(key, value); };
  function clearTimers() {
    clearTimeout(showTimer); clearTimeout(hideTimer); showTimer = hideTimer = null;
  }
  function hideActivity() { clearTimers(); visible = false; render(); }
  function settleActivity() {
    clearTimeout(showTimer); showTimer = null;
    if(!visible) return;
    clearTimeout(hideTimer);
    const wait = Math.max(0, MIN_VISIBLE - (Date.now() - shownAt));
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if(!transfers) { visible = false; render(); }
    }, wait);
  }
  function renderDetails() {
    // Do not rewrite hidden details on every background poll.
    if(!detail || doc.getElementById('sentlogCloudModal')?.style.display !== 'flex') return;
    let current = !account ? 'ログインしていません。' : !online ? '通信待ち（オンラインになると再確認）' :
      running ? (transfers ? operation || 'データを送受信中' : '変更を確認中') : '自動確認を待機中';
    text(detailPhase, '現在：' + current);
    text(detailTime, '最終同期確認：' + (lastSuccess === null ? 'この起動後は未確認' :
      new Date(lastSuccess).toLocaleString('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})));
    text(detailResult, outcome.message || '');
    attr(detailResult, 'data-level', outcome.level);
  }
  function render() {
    let title = '同期設定', kind = 'neutral', active = false;
    if(account) {
      if(!online) { title = '通信待ち'; kind = 'warn'; }
      else if(outcome.level === 'error') { title = outcome.label || '同期を要確認'; kind = 'err'; }
      else if(outcome.level === 'pending') { title = outcome.label || '反映待ち'; kind = 'warn'; }
      else { title = visible ? '同期中' : '自動同期ON'; kind = 'ok'; active = visible; }
    }
    text(label, title);
    attr(button, 'data-kind', kind);
    attr(button, 'data-activity', String(active));
    attr(button, 'aria-label', title + '、同期状況を開く');
    renderDetails();
  }
  function mount(b, container) {
    button = b; detail = container;
    if(!doc.getElementById('sentlogSyncStatusStyle')) {
      const style = doc.createElement('style'); style.id = 'sentlogSyncStatusStyle';
      style.textContent = `
#sentlogCloudStatus{width:158px;flex:0 0 158px;max-width:100%;min-width:0;min-height:36px;display:grid;grid-template-columns:14px minmax(0,1fr) 12px;align-items:center;gap:6px;padding:7px 10px;border-radius:10px;background:#374151;color:#fff;border:1px solid #4b5563;font-size:12px;line-height:1.25;margin-left:4px;white-space:nowrap;touch-action:manipulation;transition:none;}
#sentlogCloudStatus[data-kind="ok"]{background:#065f46;}
#sentlogCloudStatus[data-kind="warn"]{background:#78350f;}
#sentlogCloudStatus[data-kind="err"]{background:#991b1b;}
#sentlogCloudStatus .sl-sync-label{overflow:hidden;text-overflow:ellipsis;min-width:0;}
#sentlogCloudStatus .sl-sync-spinner{box-sizing:border-box;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;visibility:hidden;}
#sentlogCloudStatus[data-activity="true"] .sl-sync-spinner{visibility:visible;animation:sl-sync-turn 1.3s linear infinite;}
@keyframes sl-sync-turn{to{transform:rotate(360deg);}}
@media(prefers-reduced-motion:reduce){#sentlogCloudStatus[data-activity="true"] .sl-sync-spinner{animation:none;}}
#sentlogCloudDetails{margin-top:12px;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:12px;line-height:1.65;color:#374151;overflow-wrap:anywhere;}
#sentlogCloudDetails p{margin:0;min-height:20px;}
#sentlogCloudDetails [data-level="error"]{color:#991b1b;}
#sentlogCloudDetails [data-level="pending"]{color:#92400e;}`;
      doc.head.appendChild(style);
    }
    if(button && !button.querySelector('.sl-sync-label')) {
      const icon = doc.createElement('span'); icon.textContent = '☁'; icon.setAttribute('aria-hidden','true');
      label = doc.createElement('span'); label.className = 'sl-sync-label';
      const spinner = doc.createElement('span'); spinner.className = 'sl-sync-spinner'; spinner.setAttribute('aria-hidden','true');
      button.replaceChildren(icon, label, spinner);
    } else label = button?.querySelector('.sl-sync-label');
    if(detail) {
      detailPhase = doc.createElement('p'); detailTime = doc.createElement('p'); detailResult = doc.createElement('p');
      detailResult.setAttribute('role','status'); detailResult.setAttribute('aria-live','polite');
      detail.replaceChildren(detailPhase, detailTime, detailResult);
    }
    render();
  }
  function setAccount(id) {
    const next = String(id || '');
    if(next !== account) {
      account = next; cycle++; running = false; transfers = 0; phase = 'idle'; operation = '';
      clearTimers(); visible = false; lastSuccess = null;
      outcome = {level:'ok',message:next ? 'この起動後は、まだ同期を確認していません。' : 'ログインすると自動同期が有効になります。'};
    }
    // Token refresh/modal opening with the same account must not clear an existing warning.
    render();
  }
  function setOnline(value) {
    online = !!value;
    if(!online) hideActivity(); else render();
  }
  function begin() {
    cycle++; running = true; transfers = 0; phase = 'checking'; operation = '';
    render();
    return cycle;
  }
  function beginTransfer(description) {
    const token = cycle;
    if(!account || !running) return () => {};
    transfers++; phase = 'transfer'; operation = description || 'データを送受信中';
    clearTimeout(hideTimer); hideTimer = null;
    if(!showTimer && !visible && online && outcome.level === 'ok') {
      showTimer = setTimeout(() => {
        showTimer = null;
        if(token === cycle && transfers && online && outcome.level === 'ok') {
          visible = true; shownAt = Date.now(); render();
        }
      }, SHOW_DELAY);
    }
    renderDetails();
    let ended = false;
    return () => {
      if(ended || token !== cycle) return; ended = true;
      transfers = Math.max(0, transfers-1);
      if(!transfers) { phase = running ? 'checking' : 'idle'; operation = ''; settleActivity(); }
      renderDetails();
    };
  }
  async function track(description, action) {
    const end = beginTransfer(description);
    try { return await action(); } finally { end(); }
  }
  function finish(token, result) {
    if(token !== cycle || !account) return;
    running = false; transfers = 0; phase = 'idle'; operation = '';
    outcome = result || {level:'error',message:'同期結果を確認できませんでした。'};
    if(outcome.level === 'ok' && online) lastSuccess = Date.now();
    if(outcome.level !== 'ok') hideActivity(); else settleActivity();
    render();
  }
  return {mount,setAccount,setOnline,begin,track,finish,refresh:render};
}

// Independent in-flight descriptions. Completion receipts stay in sync-status.
export function attachSyncWorkStatus(base, doc = document) {
  const kinds = ['metadata', 'files'];
  const labels = { metadata: '記録・図面情報：', files: '図面・写真ファイル：' };
  const entries = new Map(), rows = new Map();
  let account = '', generation = 0, detail = null, timer = null;
  const idleHandle = Object.freeze({ update: () => false, finish: () => false });

  function stopTimer() {
    if (!timer) return;
    const old = timer; timer = null;
    clearTimeout(old.id);
  }
  function visible() {
    return !!detail && doc.getElementById('sentlogCloudModal')?.style.display === 'flex';
  }
  function render() {
    const showing = visible();
    for (const kind of kinds) {
      const row = rows.get(kind), entry = entries.get(kind);
      if (!row) continue;
      if (!entry) {
        row.textContent = ''; row.hidden = true;
      } else if (showing) {
        const elapsed = Math.max(0, Date.now() - entry.since);
        const suffix = elapsed > 15000 ? '（' + Math.floor(elapsed / 1000) + '秒経過）' : '';
        const message = labels[kind] + entry.description + suffix;
        if (row.textContent !== message) row.textContent = message;
        row.hidden = false;
      }
    }
    if (!showing || !entries.size || !account) { stopTimer(); return; }
    if (!timer) {
      const next = {}; timer = next;
      next.id = setTimeout(() => {
        if (timer !== next) return;
        timer = null; renderSafely();
      }, 1000);
    }
  }
  function renderSafely() {
    // Display failures must never reject or hold up the work being observed.
    try { render(); } catch { stopTimer(); }
  }
  function current(kind, entry) {
    return entry.generation === generation && entries.get(kind) === entry && !!account;
  }
  function update(kind, entry, description, projectId) {
    if (!current(kind, entry)) return false;
    try {
      const nextDescription = String(description ?? '');
      const nextProjectId = projectId == null ? null : String(projectId);
      if (nextDescription !== entry.description || nextProjectId !== entry.projectId) {
        entry.description = nextDescription; entry.projectId = nextProjectId; entry.since = Date.now();
      }
      renderSafely(); return true;
    } catch { return false; }
  }
  function beginWork(kind, description) {
    if (!account || !kinds.includes(kind)) return idleHandle;
    try {
      const entry = { generation, description: String(description ?? ''), projectId: null, since: Date.now() };
      entries.set(kind, entry); renderSafely();
      return {
        update(description, projectId = null) { return update(kind, entry, description, projectId); },
        finish() {
          if (!current(kind, entry)) return false;
          entries.delete(kind); renderSafely(); return true;
        }
      };
    } catch { return idleHandle; }
  }
  function updateProjectWork(kind, projectId, description) {
    const entry = entries.get(kind);
    if (!entry || projectId == null || entry.projectId === null) return false;
    try {
      const id = String(projectId);
      if (!id || id !== entry.projectId) return false;
      return update(kind, entry, description, id);
    } catch { return false; }
  }
  const view = { ...base, beginWork, updateProjectWork };
  for (const name of ['setOnline', 'begin', 'finish', 'track']) {
    view[name] = (...args) => Reflect.apply(base[name], base, args);
  }
  view.mount = (...args) => {
    const result = Reflect.apply(base.mount, base, args);
    stopTimer(); detail = args[1] || null; rows.clear();
    try {
      if (detail) for (const kind of kinds) {
        const row = doc.createElement('p');
        row.setAttribute('data-sync-work-kind', kind); row.hidden = true;
        detail.appendChild(row); rows.set(kind, row);
      }
    } catch { /* A missing display must not change synchronization. */ }
    renderSafely(); return result;
  };
  view.setAccount = (...args) => {
    const next = String(args[0] || '');
    if (next !== account) {
      account = next; generation++; entries.clear(); stopTimer();
    }
    try { return Reflect.apply(base.setAccount, base, args); }
    finally { renderSafely(); }
  };
  view.refresh = (...args) => {
    try { return Reflect.apply(base.refresh, base, args); }
    finally { renderSafely(); }
  };
  return view;
}

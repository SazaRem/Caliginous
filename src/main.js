/* ═══════════════════════════════════════════
   CALIGINOUS v3 — Native Webview Browser Logic
   ═══════════════════════════════════════════ */

'use strict';

const TAURI = window.__TAURI__;
if (!TAURI) {
  console.warn('Tauri API not found. Running in mock mode?');
}

const appWindow = TAURI ? TAURI.window.getCurrentWindow() : null;
const invoke = TAURI ? TAURI.core.invoke : null;

const STORAGE = {
  tabs: 'c_tabs',
  bookmarks: 'c_bm',
  history: 'c_hs',
  settings: 'c_cfg',
  pm_vault: 'c_pm_vault', // Encrypted vault blob
  pm_setup: 'c_pm_setup', // Has user set up PM?
};

// ── State ──────────────────────────────────
const S = {
  tabs: [],
  activeId: null,
  idCounter: 0,
  sidebar: false,
  sidePanel: 'bookmarks',
  overlayOpen: false,
  pmOverlayOpen: false,
  bookmarks: JSON.parse(localStorage.getItem(STORAGE.bookmarks) || '[]'),
  history: JSON.parse(localStorage.getItem(STORAGE.history) || '[]'),
  settings: JSON.parse(localStorage.getItem(STORAGE.settings) || 'null') || {
    homepage: 'https://google.com',
    search: 'https://www.google.com/search?q=',
    trackers: true,
    ads: true,
    fp: true,
    https: true,
    restoreSession: true,
  },
  pm: {
    unlocked: false,
    entries: [],
    setup: localStorage.getItem(STORAGE.pm_setup) === 'true',
  }
};

// ── DOM ────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const tabsEl = $('tabs-container');
const addrEl = $('addressbar');
const acEl = $('autocomplete');
const ntpEl = $('ntp');
const spEl = $('side-panel');
const clockEl = $('ntp-clock');
const loadBar = $('loading-bar');
const lockEl = $('lock-icon');
const webviewArea = $('webview-area');
const settingsOverlay = $('settings-overlay');
const pmOverlay = $('pm-overlay');
const pmContent = $('pm-content');

let acList = [];
let acIdx = -1;
let syncQueued = false;
let sessionSaveQueued = false;
let resizeObserver = null;

// ── Boot ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  void boot();
});

async function boot() {
  bindWindow();
  bindNav();
  bindAddr();
  bindSide();
  bindSettings();
  bindPM();
  bindNTP();
  bindKeys();
  drawCanvas();
  tick();
  setInterval(tick, 1000);

  if (appWindow) {
    resizeObserver = new ResizeObserver(() => requestSyncWebviews());
    resizeObserver.observe(webviewArea);
    window.addEventListener('resize', requestSyncWebviews);
  }

  await restoreSession();
  if (!S.tabs.length) {
    await newTab(S.settings.homepage, { focus: true, persist: false });
  }
  if (appWindow) requestSyncWebviews();
}

// ── Helpers ────────────────────────────────
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : ''}`;
  } catch {
    return String(url || 'New Tab');
  }
}

function titleFromUrl(url) {
  const h = hostFromUrl(url);
  return h.length > 40 ? `${h.slice(0, 37)}…` : h;
}

function serializeTab(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    backStack: tab.backStack || [],
    forwardStack: tab.forwardStack || [],
  };
}

function saveState() {
  if (sessionSaveQueued) return;
  sessionSaveQueued = true;
  setTimeout(() => {
    sessionSaveQueued = false;
    localStorage.setItem(STORAGE.tabs, JSON.stringify({
      activeId: S.activeId,
      idCounter: S.idCounter,
      tabs: S.tabs.map(serializeTab),
    }));
    localStorage.setItem(STORAGE.bookmarks, JSON.stringify(S.bookmarks));
    localStorage.setItem(STORAGE.history, JSON.stringify(S.history));
    localStorage.setItem(STORAGE.settings, JSON.stringify(S.settings));
  }, 0);
}

function getTab(id) {
  return S.tabs.find((t) => t.id === id);
}

function getActiveTab() {
  return getTab(S.activeId);
}

function getBounds() {
  const rect = webviewArea.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

function makeTabLabel(tab, generation) {
  return `tab_${tab.id}_${generation}`.replace(/[^a-zA-Z0-9_\-/:]/g, '_');
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(err);
    return undefined;
  }
}

function requestSyncWebviews() {
  if (syncQueued || !appWindow) return;
  syncQueued = true;
  requestAnimationFrame(async () => {
    syncQueued = false;
    await syncWebviews();
  });
}

async function syncWebviews() {
  if (!appWindow) return;
  const bounds = getBounds();
  for (const tab of S.tabs) {
    if (!tab.webview) continue;
    // In a real Tauri v2 app with WebviewWindow, we manage visibility differently.
    // This is a placeholder for the logic that would show/hide native windows.
    // For now, we rely on the CSS z-index or native window focus.
  }
}

async function restoreSession() {
  const raw = localStorage.getItem(STORAGE.tabs);
  if (!raw || !S.settings.restoreSession) return;

  let saved;
  try { saved = JSON.parse(raw); } catch { return; }
  if (!saved?.tabs?.length) return;

  S.idCounter = Number(saved.idCounter || 0);
  S.tabs = [];
  tabsEl.innerHTML = '';

  const savedTabs = [...saved.tabs];
  const activeId = saved.activeId ?? savedTabs[0]?.id ?? null;

  for (const item of savedTabs) {
    const tab = {
      id: Number(item.id),
      url: item.url || null,
      title: item.title || (item.url ? titleFromUrl(item.url) : 'New Tab'),
      favicon: null,
      loading: false,
      backStack: Array.isArray(item.backStack) ? item.backStack : [],
      forwardStack: Array.isArray(item.forwardStack) ? item.forwardStack : [],
      webview: null,
      loadToken: 0,
    };
    S.tabs.push(tab);
    makeTabEl(tab);
    if (tab.url) {
      // In a real implementation, this would trigger the Rust command to create the webview
      // await loadTab(tab, tab.url, ...);
    }
  }

  if (activeId && getTab(activeId)) activate(activeId, { sync: false });
  else if (S.tabs[0]) activate(S.tabs[0].id, { sync: false });

  renderBM();
  renderHS();
  saveState();
}

// ── Window controls ────────────────────────
function bindWindow() {
  if (!appWindow) return;
  $('btn-minimize').onclick = () => appWindow.minimize();
  $('btn-maximize').onclick = async () => {
    (await appWindow.isMaximized()) ? appWindow.unmaximize() : appWindow.maximize();
  };
  $('btn-close').onclick = () => appWindow.close();
}

// ── Tab management ─────────────────────────
function makeTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = tab.id;
  el.innerHTML = `
    <div class="tab-favicon-placeholder">${(tab.title?.[0] || 'N').toUpperCase()}</div>
    <span class="tab-title"></span>
    <button class="tab-close">✕</button>
  `;
  el.querySelector('.tab-title').textContent = tab.title || 'New Tab';
  el.onclick = (e) => {
    if (!e.target.classList.contains('tab-close')) activate(tab.id);
  };
  el.querySelector('.tab-close').onclick = (e) => {
    e.stopPropagation();
    void closeTab(tab.id);
  };
  tabsEl.appendChild(el);
}

function refreshTabEl(tab) {
  const el = tabsEl.querySelector(`[data-id="${tab.id}"]`);
  if (!el) return;
  const fav = el.querySelector('.tab-favicon,.tab-favicon-placeholder');
  if (fav) {
    fav.outerHTML = tab.favicon
      ? `<img class="tab-favicon" src="${tab.favicon}" onerror="this.style.display='none'" />`
      : `<div class="tab-favicon-placeholder">${(tab.title?.[0] || 'N').toUpperCase()}</div>`;
  }
  el.querySelector('.tab-title').textContent = tab.title || 'New Tab';
}

function updateTabLoading(tab, on) {
  tabsEl.querySelector(`[data-id="${tab.id}"]`)?.classList.toggle('tab-loading', on);
  tab.loading = on;
  if (on) loadBar.classList.add('active');
  else loadBar.classList.remove('active');
}

function activate(id, { sync = true } = {}) {
  const tab = getTab(id);
  if (!tab) return;
  S.activeId = id;
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.id == id));

  if (tab.url) {
    ntpEl.classList.add('hidden');
    addrEl.value = tab.url;
    setLock(tab.url);
    setBookmarkIcon(tab.url);
  } else {
    showNTP();
    addrEl.value = '';
  }

  $('btn-back').disabled = !tab.backStack.length;
  $('btn-forward').disabled = !tab.forwardStack.length;

  if (sync) requestSyncWebviews();
  saveState();
}

async function closeTab(id) {
  const idx = S.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;

  const tab = S.tabs[idx];
  
  // If using Rust backend, call close_tab command here
  if (invoke) {
    try { await invoke('close_tab', { tabId: id }); } catch (e) { console.error(e); }
  }

  S.tabs.splice(idx, 1);
  tabsEl.querySelector(`[data-id="${id}"]`)?.remove();

  if (!S.tabs.length) {
    S.activeId = null;
    saveState();
    await newTab(S.settings.homepage, { focus: true });
    return;
  }

  if (S.activeId === id) {
    const next = S.tabs[Math.min(idx, S.tabs.length - 1)];
    activate(next.id);
  } else {
    requestSyncWebviews();
  }
  saveState();
}

async function loadTab(tab, url, { createHistory = true, showAfterLoad = true, replaceExisting = true } = {}) {
  if (!tab) return;
  const normalized = resolve(url);
  const generation = ++tab.loadToken;
  
  updateTabLoading(tab, true);
  tab.title = titleFromUrl(normalized);
  tab.url = normalized;
  refreshTabEl(tab);
  addrEl.value = S.activeId === tab.id ? normalized : addrEl.value;
  setLock(normalized);
  setBookmarkIcon(normalized);
  ntpEl.classList.add('hidden');

  if (invoke) {
    try {
      await invoke('open_url', { tabId: tab.id, url: normalized });
      // The Rust backend will handle the actual webview creation/navigation
      // and emit events back to update title/url if they change
    } catch (e) {
      console.error("Failed to load URL via Rust:", e);
      // Fallback or error state
    }
  } else {
    // Mock mode for development without Rust
    console.log(`Mock loading: ${normalized}`);
    updateTabLoading(tab, false);
  }

  if (createHistory) pushHistory({ url: normalized, title: tab.title });
  saveState();
}

function showNTP() {
  ntpEl.classList.remove('hidden');
  requestSyncWebviews();
  setTimeout(() => $('ntp-search')?.focus(), 80);
}

async function newTab(url = null, { focus = true, persist = true } = {}) {
  const id = ++S.idCounter;
  const tab = {
    id,
    url: null,
    title: 'New Tab',
    favicon: null,
    loading: false,
    backStack: [],
    forwardStack: [],
    webview: null,
    loadToken: 0,
  };

  S.tabs.push(tab);
  makeTabEl(tab);

  if (url) {
    await loadTab(tab, url, { createHistory: false, showAfterLoad: focus, replaceExisting: false });
  } else {
    showNTP();
  }

  if (focus) activate(id);
  if (persist) saveState();
  return tab;
}

// ── URL handling ───────────────────────────
function resolve(raw) {
  const input = String(raw || '').trim();
  if (!input) return S.settings.homepage;

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // fall through
  }

  const looksLikeHost = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/.*)?$/i.test(input);
  if (looksLikeHost && !input.includes(' ')) {
    return `${S.settings.https ? 'https' : 'http'}://${input}`;
  }

  return `${S.settings.search}${encodeURIComponent(input)}`;
}

async function go(input, id = S.activeId, { replaceHistory = false } = {}) {
  const tab = getTab(id);
  if (!tab) return;
  const url = resolve(input);

  if (tab.url && tab.url !== url && !replaceHistory) {
    tab.backStack.push(tab.url);
    tab.forwardStack = [];
  }

  await loadTab(tab, url, { createHistory: true, showAfterLoad: true, replaceExisting: true });
  activate(tab.id);
}

async function reloadTab() {
  const tab = getActiveTab();
  if (!tab?.url) return;
  await loadTab(tab, tab.url, { createHistory: false, showAfterLoad: true, replaceExisting: true });
  activate(tab.id);
}

async function navigateBack() {
  const tab = getActiveTab();
  if (!tab?.backStack.length) return;
  const previous = tab.backStack.pop();
  if (tab.url) tab.forwardStack.push(tab.url);
  await loadTab(tab, previous, { createHistory: false, showAfterLoad: true, replaceExisting: true });
  activate(tab.id);
}

async function navigateForward() {
  const tab = getActiveTab();
  if (!tab?.forwardStack.length) return;
  const next = tab.forwardStack.pop();
  if (tab.url) tab.backStack.push(tab.url);
  await loadTab(tab, next, { createHistory: false, showAfterLoad: true, replaceExisting: true });
  activate(tab.id);
}

// ── Lock icon ──────────────────────────────
function setLock(url) {
  const secure = /^https:\/\//i.test(url);
  lockEl.classList.toggle('secure', secure);
  lockEl.title = secure ? 'Secure connection' : 'Not secure';
}

// ── Nav buttons ────────────────────────────
function bindNav() {
  $('new-tab-btn').onclick = () => void newTab();
  $('btn-back').onclick = () => void navigateBack();
  $('btn-forward').onclick = () => void navigateForward();
  $('btn-reload').onclick = () => void reloadTab();
  $('btn-home').onclick = () => void go(S.settings.homepage);
  $('btn-bookmark-page').onclick = () => toggleBM();
  $('btn-shield').onclick = () => openSide('shields');
  $('btn-sidebar').onclick = () => toggleSidebar();
}

// ── Address bar ────────────────────────────
function bindAddr() {
  addrEl.addEventListener('focus', () => {
    addrEl.select();
    buildAC(addrEl.value);
  });
  addrEl.addEventListener('input', () => buildAC(addrEl.value));
  addrEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void go(addrEl.value);
      return;
    }
    if (e.key === 'Escape') {
      hideAC();
      addrEl.blur();
      const t = getActiveTab();
      if (t?.url) addrEl.value = t.url;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveAC(1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveAC(-1);
    }
  });
  addrEl.addEventListener('blur', () => setTimeout(hideAC, 160));
}

function buildAC(q) {
  if (!q) { hideAC(); return; }
  const ql = q.toLowerCase();
  const bm = S.bookmarks.filter((b) => b.url?.toLowerCase().includes(ql) || b.title?.toLowerCase().includes(ql)).slice(0, 3).map((b) => ({ ...b, type: 'bm' }));
  const hs = S.history.filter((h) => h.url?.toLowerCase().includes(ql) || h.title?.toLowerCase().includes(ql)).slice(0, 5).map((h) => ({ ...h, type: 'hs' }));
  acList = [...bm, ...hs];
  if (!acList.length) { hideAC(); return; }
  
  acEl.innerHTML = acList.map((item, i) => `
    <div class="ac-row" data-i="${i}">
      <svg class="ac-icon" viewBox="0 0 14 14" fill="none">
        ${item.type === 'bm'
          ? '<path d="M3 2h8a1 1 0 0 1 1 1v9l-4.5-2.7L3 12V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.1"/>'
          : '<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.1"/><path d="M7 4.5V7l1.5 1.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'}
      </svg>
      <div style="flex:1;overflow:hidden;min-width:0">
        <div class="ac-title">${esc(item.title || item.url)}</div>
        <div class="ac-url">${esc(item.url)}</div>
      </div>
    </div>
  `).join('');
  
  acEl.querySelectorAll('.ac-row').forEach((el) => el.onclick = () => void go(acList[+el.dataset.i].url));
  acIdx = -1;
  acEl.classList.add('open');
  const ab = $('addressbar-wrap').getBoundingClientRect();
  Object.assign(acEl.style, { top: `${ab.bottom + 5}px`, left: `${ab.left}px`, width: `${ab.width}px` });
}

function hideAC() {
  acEl.classList.remove('open');
  acIdx = -1;
}

function moveAC(d) {
  const rows = acEl.querySelectorAll('.ac-row');
  if (!rows.length) return;
  rows[acIdx]?.classList.remove('sel');
  acIdx = Math.max(-1, Math.min(rows.length - 1, acIdx + d));
  if (acIdx >= 0) {
    rows[acIdx].classList.add('sel');
    addrEl.value = acList[acIdx].url;
  }
}

// ── Bookmarks ──────────────────────────────
function toggleBM() {
  const tab = getActiveTab();
  if (!tab?.url) return;
  const i = S.bookmarks.findIndex((b) => b.url === tab.url);
  if (i >= 0) S.bookmarks.splice(i, 1);
  else S.bookmarks.unshift({ url: tab.url, title: tab.title || tab.url, ts: Date.now() });
  saveState();
  setBookmarkIcon(tab.url);
  renderBM();
}

function setBookmarkIcon(url) {
  $('btn-bookmark-page')?.classList.toggle('bookmarked', S.bookmarks.some((b) => b.url === url));
}

function renderBM() {
  const p = $('panel-bookmarks');
  if (!S.bookmarks.length) {
    p.innerHTML = '<div class="panel-empty">No bookmarks yet</div>';
    return;
  }
  p.innerHTML = S.bookmarks.map((b) => `
    <div class="panel-item" data-url="${esc(b.url)}">
      <div class="panel-item-title">${esc(b.title || b.url)}</div>
      <div class="panel-item-url">${esc(b.url)}</div>
    </div>`).join('');
  p.querySelectorAll('.panel-item').forEach((el) => el.onclick = () => void go(el.dataset.url));
}

// ── History ────────────────────────────────
function pushHistory(entry) {
  if (!entry.url || entry.url.startsWith('about:')) return;
  if (S.history[0]?.url === entry.url) return;
  S.history.unshift({ ...entry, ts: Date.now() });
  if (S.history.length > 500) S.history.splice(500);
  saveState();
  renderHS();
}

function renderHS() {
  const p = $('panel-history');
  if (!S.history.length) {
    p.innerHTML = '<div class="panel-empty">No history yet</div>';
    return;
  }
  p.innerHTML = S.history.slice(0, 60).map((h) => `
    <div class="panel-item" data-url="${esc(h.url)}">
      <div class="panel-item-title">${esc(h.title || h.url)}</div>
      <div class="panel-item-url">${esc(h.url)}</div>
    </div>`).join('');
  p.querySelectorAll('.panel-item').forEach((el) => el.onclick = () => void go(el.dataset.url));
}

// ── Side panel ─────────────────────────────
function bindSide() {
  $$('.sp-tab').forEach((btn) => btn.onclick = () => openSide(btn.dataset.panel));
  renderBM();
  renderHS();
}

function toggleSidebar() {
  S.sidebar = !S.sidebar;
  spEl.classList.toggle('hidden', !S.sidebar);
  $('btn-sidebar').classList.toggle('active', S.sidebar);
  requestSyncWebviews();
  saveState();
}

function openSide(name) {
  if (!S.sidebar) toggleSidebar();
  S.sidePanel = name;
  $$('.sp-tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $$('.panel-view').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  saveState();
}

// ── Settings ───────────────────────────────
function bindSettings() {
  $('btn-settings').onclick = openSettings;
  $('btn-save-settings').onclick = saveSettings;
  $('btn-clear-history').onclick = () => {
    S.history = [];
    saveState();
    renderHS();
  };
  $$('.close-btn').forEach((b) => b.onclick = () => closeOverlay(b.dataset.target));
  $$('.overlay').forEach((o) => o.querySelector('.overlay-bg').onclick = () => closeOverlay(o.id));
}

function closeOverlay(id) {
  const overlay = $(id);
  if (!overlay) return;
  overlay.classList.add('hidden');
  if (id === 'settings-overlay') S.overlayOpen = false;
  if (id === 'pm-overlay') S.pmOverlayOpen = false;
  requestSyncWebviews();
}

function openSettings() {
  const s = S.settings;
  $('set-homepage').value = s.homepage;
  $('set-search').value = s.search;
  $('set-trackers').checked = s.trackers;
  $('set-ads').checked = s.ads;
  $('set-fp').checked = s.fp;
  $('set-https').checked = s.https;
  settingsOverlay.classList.remove('hidden');
  S.overlayOpen = true;
  requestSyncWebviews();
}

function saveSettings() {
  S.settings = {
    homepage: $('set-homepage').value || 'https://google.com',
    search: $('set-search').value,
    trackers: $('set-trackers').checked,
    ads: $('set-ads').checked,
    fp: $('set-fp').checked,
    https: $('set-https').checked,
    restoreSession: true,
  };
  settingsOverlay.classList.add('hidden');
  S.overlayOpen = false;
  saveState();
  requestSyncWebviews();
}

// ── Password Manager UI ────────────────────
function bindPM() {
  $('btn-pm').onclick = openPMPanel;
}

function openPMPanel() {
  pmOverlay.classList.remove('hidden');
  S.pmOverlayOpen = true;
  renderPMUI();
  requestSyncWebviews();
}

function renderPMUI() {
  if (!S.pm.setup) {
    pmContent.innerHTML = `
      <div class="pm-state">
        <h3>Setup Password Manager</h3>
        <p>Create a master password to encrypt your vault.</p>
        <div class="pm-input-group">
          <label>Master Password</label>
          <input type="password" id="pm-master-pw" placeholder="Min 8 characters" />
        </div>
        <div class="pm-input-group">
          <label>Confirm Password</label>
          <input type="password" id="pm-master-pw-confirm" placeholder="Confirm password" />
        </div>
        <button id="pm-setup-btn" class="primary-btn" style="width:100%">Create Vault</button>
      </div>
    `;
    $('pm-setup-btn').onclick = handlePMSetup;
  } else if (!S.pm.unlocked) {
    pmContent.innerHTML = `
      <div class="pm-state">
        <h3>Unlock Vault</h3>
        <p>Enter your master password to access passwords.</p>
        <div class="pm-input-group">
          <label>Master Password</label>
          <input type="password" id="pm-unlock-pw" placeholder="Password" />
        </div>
        <button id="pm-unlock-btn" class="primary-btn" style="width:100%">Unlock</button>
        <p style="margin-top:10px;font-size:10px;color:var(--t3)">Hint: Vault is stored locally in this demo.</p>
      </div>
    `;
    $('pm-unlock-btn').onclick = handlePMUnlock;
  } else {
    const currentUrl = getActiveTab()?.url || '';
    pmContent.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="font-size:14px;font-style:italic;color:var(--t1)">My Vault</h3>
        <button id="pm-lock-btn" style="font-size:10px;color:var(--t2);background:none;border:none;cursor:pointer">Lock</button>
      </div>
      
      ${currentUrl ? `
        <div style="background:var(--neon-low);padding:8px;border-radius:6px;margin-bottom:12px;border:1px solid var(--neon-mid)">
          <div style="font-size:11px;color:var(--t2);margin-bottom:4px">Current Site</div>
          <div style="font-family:'JetBrains Mono';font-size:12px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${currentUrl}</div>
          <button id="pm-save-current" class="primary-btn" style="margin-top:6px;padding:4px 10px;font-size:10px;width:100%">Save Credentials for this Site</button>
        </div>
      ` : ''}

      <div class="pm-input-group">
        <label>Add New Entry</label>
        <div style="display:flex;gap:4px;margin-bottom:4px">
          <input type="text" id="pm-new-url" placeholder="URL (e.g. github.com)" style="flex:1" />
        </div>
        <div style="display:flex;gap:4px;margin-bottom:4px">
          <input type="text" id="pm-new-user" placeholder="Username" style="flex:1" />
          <input type="password" id="pm-new-pass" placeholder="Password" style="flex:1" />
        </div>
        <button id="pm-add-btn" class="primary-btn" style="width:100%;padding:6px">Add Entry</button>
      </div>

      <div class="pm-entry-list" id="pm-entries-list">
        ${S.pm.entries.length === 0 ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:20px">No entries yet</div>' : ''}
      </div>
    `;
    
    $('pm-lock-btn').onclick = () => { S.pm.unlocked = false; renderPMUI(); };
    
    if ($('pm-save-current')) {
      $('pm-save-current').onclick = () => {
        const url = new URL(currentUrl).hostname;
        $('pm-new-url').value = url;
        $('pm-new-user').focus();
      };
    }
    
    $('pm-add-btn').onclick = handlePMAddEntry;
    renderPMEntriesList();
  }
}

function renderPMEntriesList() {
  const list = $('pm-entries-list');
  if (!list || S.pm.entries.length === 0) return;
  
  list.innerHTML = S.pm.entries.map((e, i) => `
    <div class="pm-entry-item">
      <div class="pm-entry-info">
        <div class="pm-entry-url">${esc(e.url)}</div>
        <div class="pm-entry-user">${esc(e.username)}</div>
      </div>
      <div class="pm-entry-actions">
        <button onclick="navigator.clipboard.writeText('${esc(e.password)}')">Copy</button>
        <button class="delete" onclick="window.caliginousPM.deleteEntry(${i})">Del</button>
      </div>
    </div>
  `).join('');
}

function handlePMSetup() {
  const pw = $('pm-master-pw').value;
  const confirm = $('pm-master-pw-confirm').value;
  if (pw.length < 8) { alert('Password must be at least 8 characters'); return; }
  if (pw !== confirm) { alert('Passwords do not match'); return; }
  
  // In a real app, this would call Rust to hash and store
  S.pm.setup = true;
  S.pm.unlocked = true;
  localStorage.setItem(STORAGE.pm_setup, 'true');
  // Initialize empty vault
  S.pm.entries = []; 
  renderPMUI();
}

function handlePMUnlock() {
  const pw = $('pm-unlock-pw').value;
  // In a real app, verify hash with Rust
  if (pw.length > 0) {
    S.pm.unlocked = true;
    // Load entries from localStorage (simulated)
    const raw = localStorage.getItem(STORAGE.pm_vault);
    if (raw) {
      try { S.pm.entries = JSON.parse(raw); } catch {}
    }
    renderPMUI();
  }
}

function handlePMAddEntry() {
  const url = $('pm-new-url').value.trim();
  const user = $('pm-new-user').value.trim();
  const pass = $('pm-new-pass').value;
  
  if (!url || !user || !pass) { alert('All fields required'); return; }
  
  S.pm.entries.unshift({ url, username: user, password: pass, ts: Date.now() });
  localStorage.setItem(STORAGE.pm_vault, JSON.stringify(S.pm.entries));
  
  $('pm-new-url').value = '';
  $('pm-new-user').value = '';
  $('pm-new-pass').value = '';
  renderPMEntriesList();
}

// Expose delete function globally for inline onclick
window.caliginousPM = {
  deleteEntry: (index) => {
    if (!confirm('Delete this entry?')) return;
    S.pm.entries.splice(index, 1);
    localStorage.setItem(STORAGE.pm_vault, JSON.stringify(S.pm.entries));
    renderPMEntriesList();
  }
};

// ── NTP ────────────────────────────────────
function bindNTP() {
  $('ntp-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('ntp-search').value.trim()) void go($('ntp-search').value.trim());
  });
  $$('.ql').forEach((btn) => btn.onclick = () => void go(btn.dataset.url));
}

// ── Clock ──────────────────────────────────
function tick() {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  if (clockEl) clockEl.textContent = `${days[now.getDay()]}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ── NTP canvas background ──────────────────
function drawCanvas() {
  const canvas = $('ntp-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const resize = () => {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    draw();
  };
  window.addEventListener('resize', resize);
  resize();

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const g1 = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.5);
    g1.addColorStop(0, 'rgba(220,220,255,0.03)');
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    const step = 48;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
}

// ── Keyboard ───────────────────────────────
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 't') { e.preventDefault(); void newTab(); }
    if (e.key === 'w') { e.preventDefault(); void closeTab(S.activeId); }
    if (e.key === 'l') { e.preventDefault(); addrEl.focus(); addrEl.select(); }
    if (e.key === 'r') { e.preventDefault(); void reloadTab(); }
    if (e.key === 'd') { e.preventDefault(); toggleBM(); }
    if (e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) {
      e.preventDefault();
      const t = S.tabs[n - 1];
      if (t) activate(t.id);
    }
  });
}

// ── Util ───────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Listen for Tauri events (Tab updates)
if (TAURI && TAURI.event) {
  TAURI.event.listen('tab-title-updated', (e) => {
    const { tabId, title } = e.payload;
    const tab = getTab(tabId);
    if (tab) {
      tab.title = title;
      refreshTabEl(tab);
      if (tab.id === S.activeId && tab.url) addrEl.value = tab.url; // Optional: update address bar on title change? Usually no.
    }
  });
  
  TAURI.event.listen('tab-url-updated', (e) => {
    const { tabId, url } = e.payload;
    const tab = getTab(tabId);
    if (tab) {
      tab.url = url;
      refreshTabEl(tab);
      if (tab.id === S.activeId) {
        addrEl.value = url;
        setLock(url);
        setBookmarkIcon(url);
      }
    }
  });
}
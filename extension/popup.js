// popup.js — Chrome Extension Popup Logic

const $ = id => document.getElementById(id);

const DEFAULT_EMAIL = 'default-watcher-user@careeratlas.com';
const DEFAULT_API   = 'http://localhost:3001';
const FALLBACK_API  = 'http://localhost:3000';

let currentTabId    = null;
let isWatching      = false;
let captureCount    = 0;
let selectedCompany = null;

// Auto-detect which port the backend is actually running on
async function detectBackendPort() {
  for (const base of [DEFAULT_API, FALLBACK_API]) {
    try {
      const res = await fetch(`${base}/api/watcher/companies`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return base;
    } catch {}
  }
  return DEFAULT_API; // fallback
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  const stored = await chrome.storage.local.get(['careeros_api', 'user_email', 'discovered', 'watching_tab', 'watching_company']);
  const email  = stored.user_email || DEFAULT_EMAIL;

  $('email-input').value = email;
  $('status-api').textContent = 'Detecting backend…';

  // Always auto-detect the correct backend port (ignores stale stored port)
  const apiBase = await detectBackendPort();
  await chrome.storage.local.set({ careeros_api: apiBase });
  $('api-url-input').value = apiBase;

  await loadWatchlist(apiBase, email);

  const discovered = stored.discovered || [];
  captureCount = discovered.length;
  updateCaptureCount();
  discovered.slice(-5).reverse().forEach(ep => renderEndpoint(ep));

  if (stored.watching_tab === currentTabId && stored.watching_company) {
    isWatching      = true;
    selectedCompany = stored.watching_company;
    setWatchingUI();
  }
}

// ─── Watchlist Loading ────────────────────────────────────────────────────────

async function loadWatchlist(apiBase, email) {
  const select = $('company-select');
  select.innerHTML = '<option value="">Loading…</option>';

  try {
    // Use /companies which returns ALL companies regardless of email
    // This avoids email-mismatch issues where the watchlist was saved under a different email
    const res = await fetch(`${apiBase}/api/watcher/companies`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const companies = await res.json();

    select.innerHTML = '';

    if (!Array.isArray(companies) || companies.length === 0) {
      select.innerHTML = '<option value="">— No companies yet. Add one on the CareerOS dashboard. —</option>';
      $('status-api').textContent = '✓ Connected · 0 companies';
      return;
    }

    companies.forEach(item => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({
        companyId:         item.id,
        companyIdentifier: item.company_identifier,
        companyName:       item.company_name,
        careersUrl:        item.careers_url
      });
      opt.textContent = `${item.company_name}  (${item.monitoring_status || 'Pending'})`;
      select.appendChild(opt);
    });

    $('status-api').textContent = `✓ Connected · ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`;

  } catch (err) {
    select.innerHTML = '<option value="">— Could not connect. Check URL & backend. —</option>';
    $('status-api').textContent = '✗ ' + err.message;
    console.error('[CareerOS Popup] Load failed:', err.message);
  }
}

// ─── Start / Stop Watching ────────────────────────────────────────────────────

$('start-btn').addEventListener('click', async () => {
  const raw = $('company-select').value;
  if (!raw) return alert('Select a company from the list first.');

  selectedCompany = JSON.parse(raw);
  isWatching = true;

  const apiBase = $('api-url-input').value.trim() || DEFAULT_API;

  // Save state first — so Stop button works even if sendMessage fails
  await chrome.storage.local.set({ watching_tab: currentTabId, watching_company: selectedCompany });

  try {
    await chrome.runtime.sendMessage({ type: 'START_WATCHING', tabId: currentTabId, ...selectedCompany, apiBase });
  } catch (e) {
    // Background may be sleeping — state is saved, interceptor works via content script
  }

  setWatchingUI();

  // Navigate current tab to the careers page
  if (selectedCompany.careersUrl) {
    chrome.tabs.update(currentTabId, { url: selectedCompany.careersUrl });
  }

  window.close();
});

$('stop-btn').addEventListener('click', async () => {
  // Always reset state immediately — don't let sendMessage failure block the UI
  isWatching      = false;
  selectedCompany = null;

  // Clean up storage first
  await chrome.storage.local.remove(['watching_tab', 'watching_company']);

  // Try to notify background — but don't block on it
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_WATCHING', tabId: currentTabId });
  } catch (e) {
    // Background worker was idle — storage cleanup above is sufficient
  }

  setStoppedUI();
});

// ─── Live messages from background ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ENDPOINT_FOUND') {
    const ep = message.data;
    renderEndpoint({
      requestUrl:  ep.requestUrl,
      method:      ep.method,
      contentType: ep.contentType,
      companyName: ep.company,
      capturedAt:  new Date().toISOString()
    }, true);
    captureCount++;
    updateCaptureCount();
  }

  if (message.type === 'BACKEND_SAVED') {
    const cards = document.querySelectorAll('.endpoint-card');
    if (cards.length > 0) {
      const last  = cards[cards.length - 1];
      last.classList.add('success');
      const badge = document.createElement('span');
      badge.className   = 'endpoint-badge badge-api';
      badge.textContent = `✓ Saved · ${message.data?.analysis?.classification || 'Classified'}`;
      last.appendChild(badge);
    }
  }
});

// ─── Render Endpoint Card ─────────────────────────────────────────────────────

function renderEndpoint(endpoint, animate = false) {
  const log = $('endpoints-log');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'endpoint-card';

  const urlDiv  = document.createElement('div');
  urlDiv.className   = 'endpoint-url';
  urlDiv.textContent = endpoint.requestUrl;

  const meta  = document.createElement('div');
  meta.className   = 'endpoint-meta';
  meta.textContent = `${endpoint.method || 'GET'} · ${(endpoint.contentType || 'application/json').split(';')[0]} · ${new Date(endpoint.capturedAt).toLocaleTimeString()}`;

  card.appendChild(urlDiv);
  card.appendChild(meta);

  if (endpoint.classification) {
    const badge = document.createElement('span');
    badge.className   = 'endpoint-badge badge-api';
    badge.textContent = `✓ ${endpoint.classification}`;
    card.appendChild(badge);
  }

  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

// ─── UI State ─────────────────────────────────────────────────────────────────

function setWatchingUI() {
  $('status-dot').classList.add('active');
  $('start-btn').style.display  = 'none';
  $('stop-btn').style.display   = 'flex';
  $('watching-banner').classList.add('visible');
  $('watching-company-name').textContent = selectedCompany?.companyName || '…';
}

function setStoppedUI() {
  $('status-dot').classList.remove('active');
  $('start-btn').style.display  = 'flex';
  $('stop-btn').style.display   = 'none';
  $('watching-banner').classList.remove('visible');
}

function updateCaptureCount() {
  $('capture-count').textContent = `${captureCount} endpoint${captureCount !== 1 ? 's' : ''} captured`;
}

// ─── Save Settings ────────────────────────────────────────────────────────────

$('save-settings-btn').addEventListener('click', async () => {
  const apiBase = $('api-url-input').value.trim().replace(/\/$/, '') || DEFAULT_API;
  const email   = $('email-input').value.trim() || DEFAULT_EMAIL;

  await chrome.storage.local.set({ careeros_api: apiBase, user_email: email });
  await chrome.runtime.sendMessage({ type: 'SET_API', url: apiBase });
  await loadWatchlist(apiBase, email);

  $('save-settings-btn').textContent = '✓ Saved';
  setTimeout(() => { $('save-settings-btn').textContent = 'Save'; }, 1500);
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

init();

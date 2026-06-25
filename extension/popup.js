// popup.js — Chrome Extension Popup Logic for CareerOS Discovery Assistant

const $ = id => document.getElementById(id);

const DEFAULT_EMAIL = 'default-watcher-user@careeratlas.com';
const DEFAULT_API   = 'http://localhost:3001';
const FALLBACK_API  = 'http://localhost:3000';

let isWatching      = false;
let selectedCompany = null;
let currentApiBase  = DEFAULT_API;

// ─── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  // Bind Tab Switching Events
  $('tab-discover').addEventListener('click', () => switchTab('discover'));
  $('tab-debug').addEventListener('click', () => switchTab('debug'));

  // Load stored settings
  const stored = await chrome.storage.local.get([
    'careeros_api',
    'user_email',
    'watching_tab',
    'watching_company',
    'custom_url'
  ]);

  const email = stored.user_email || DEFAULT_EMAIL;
  $('email-input').value = email;
  $('status-api').textContent = 'Detecting backend…';

  // Automatically detect which port the backend is active on
  currentApiBase = await detectBackendPort();
  await chrome.storage.local.set({ careeros_api: currentApiBase });
  $('api-url-input').value = currentApiBase;

  // Load companies
  await loadWatchlist(currentApiBase, email);

  // Restore custom URL input
  if (stored.custom_url) {
    $('custom-url').value = stored.custom_url;
  }

  // Restore current watching state UI
  if (stored.watching_tab && stored.watching_company) {
    isWatching = true;
    selectedCompany = stored.watching_company;
    setWatchingUI();
    startStatsPolling();
  } else {
    setStoppedUI();
  }

  // Bind forms & triggers
  $('start-btn').addEventListener('click', startDiscovery);
  $('stop-btn').addEventListener('click', stopDiscovery);
  $('save-settings-btn').addEventListener('click', saveSettings);
}

// ─── Tab Switching ────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  $(`tab-${tabName}`).classList.add('active');
  $(`content-${tabName}`).classList.add('active');

  if (tabName === 'debug') {
    updateDebugPanel();
  }
}

// ─── Backend Connection ───────────────────────────────────────────────────────

async function detectBackendPort() {
  for (const base of [DEFAULT_API, FALLBACK_API]) {
    try {
      const res = await fetch(`${base}/api/watcher/companies`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return base;
    } catch (e) {}
  }
  return DEFAULT_API;
}

async function loadWatchlist(apiBase, email) {
  const select = $('company-select');
  select.innerHTML = '<option value="">Loading…</option>';

  try {
    const res = await fetch(`${apiBase}/api/watcher/companies`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const companies = await res.json();

    select.innerHTML = '';

    if (!Array.isArray(companies) || companies.length === 0) {
      select.innerHTML = '<option value="">— No companies found —</option>';
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
      opt.textContent = `${item.company_name} (${item.monitoring_status || 'Pending'})`;
      select.appendChild(opt);
    });

    $('status-api').textContent = `✓ Connected · ${companies.length} companies`;
    $('footer-status-text').textContent = 'Connected';
    $('footer-status-text').style.color = '#10b981';

  } catch (err) {
    select.innerHTML = '<option value="">— Could not connect to backend —</option>';
    $('status-api').textContent = '✗ ' + err.message;
    $('footer-status-text').textContent = 'Disconnected';
    $('footer-status-text').style.color = '#ef4444';
  }
}

// ─── Start / Stop Discovery ──────────────────────────────────────────────────

async function startDiscovery() {
  const rawCompany = $('company-select').value;
  if (!rawCompany) {
    alert('Please select a company to watch.');
    return;
  }

  selectedCompany = JSON.parse(rawCompany);
  
  // Use custom URL if specified, otherwise fall back to registry careers URL
  const customUrl = $('custom-url').value.trim();
  const targetUrl = customUrl || selectedCompany.careersUrl;

  if (!targetUrl) {
    alert('Please specify a careers URL (or save one in the dashboard).');
    return;
  }

  // Update company record with actual target URL
  selectedCompany.careersUrl = targetUrl;
  await chrome.storage.local.set({ custom_url: customUrl });

  isWatching = true;

  // Open the career page in a new window/tab
  chrome.tabs.create({ url: targetUrl }, async (newTab) => {
    const targetTabId = newTab.id;

    // Persist active watching state
    await chrome.storage.local.set({
      watching_tab: targetTabId,
      watching_company: selectedCompany,
      captured_count: 0,
      ignored_count: 0,
      candidate_count: 0,
      highest_confidence: 0,
      highest_confidence_url: 'None',
      latest_ignored_reason: 'None',
      latest_preview: 'None',
      candidates: []
    });

    // Send start message to background script
    try {
      await chrome.runtime.sendMessage({
        type: 'START_WATCHING',
        tabId: targetTabId,
        companyIdentifier: selectedCompany.companyIdentifier,
        companyName: selectedCompany.companyName,
        careersUrl: targetUrl,
        companyId: selectedCompany.companyId
      });
    } catch (e) {}

    // Inject interceptor immediately to capture early load requests
    try {
      chrome.scripting.executeScript({
        target: { tabId: targetTabId, allFrames: true },
        files: ['interceptor.js'],
        world: 'MAIN'
      });
    } catch (e) {}

    setWatchingUI();
    startStatsPolling();
  });
}

async function stopDiscovery() {
  isWatching = false;
  
  const stored = await chrome.storage.local.get('watching_tab');
  const targetTabId = stored.watching_tab;

  // Clear monitoring storage fields
  await chrome.storage.local.remove(['watching_tab', 'watching_company']);

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_WATCHING', tabId: targetTabId });
  } catch (e) {}

  setStoppedUI();
  stopStatsPolling();
}

// ─── Stats Polling & Candidate Display ────────────────────────────────────────

let statsInterval = null;

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  updateStats();
  statsInterval = setInterval(updateStats, 1000);
}

function stopStatsPolling() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

async function updateStats() {
  const data = await chrome.storage.local.get([
    'captured_count',
    'ignored_count',
    'candidate_count',
    'latest_ignored_reason',
    'candidates'
  ]);

  $('metric-captured').textContent = data.captured_count || 0;
  $('metric-ignored').textContent = data.ignored_count || 0;
  $('metric-candidates').textContent = data.candidate_count || 0;

  if (data.latest_ignored_reason && data.latest_ignored_reason !== 'None') {
    $('ignored-banner-text').textContent = `Ignored: ${data.latest_ignored_reason}`;
  } else {
    $('ignored-banner-text').textContent = 'Listening for requests...';
  }

  renderCandidates(data.candidates || []);
}

function renderCandidates(candidates) {
  const container = $('candidates-list');
  
  if (candidates.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">⏳</div>
        <div class="empty-txt">
          Awaiting candidate APIs...<br>
          Navigate the careers tab to capture requests.
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  candidates.forEach((cand, index) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';

    // Header info (Click to expand)
    const header = document.createElement('div');
    header.className = 'candidate-header';
    header.addEventListener('click', () => toggleDetails(index));

    const top = document.createElement('div');
    top.className = 'candidate-top';

    const url = document.createElement('span');
    url.className = 'candidate-url';
    url.textContent = cand.requestUrl;

    const badges = document.createElement('div');
    badges.className = 'candidate-badges';

    const methodB = document.createElement('span');
    methodB.className = 'badge badge-method';
    methodB.textContent = cand.method;

    const provB = document.createElement('span');
    provB.className = 'badge badge-provider';
    provB.textContent = cand.provider;

    const confB = document.createElement('span');
    confB.className = 'badge badge-conf';
    confB.textContent = `${cand.confidence}%`;

    badges.appendChild(methodB);
    badges.appendChild(provB);
    badges.appendChild(confB);
    top.appendChild(url);
    top.appendChild(badges);

    const sub = document.createElement('div');
    sub.className = 'candidate-sub';
    sub.innerHTML = `
      <span>Detected jobs: <strong>${cand.detectedJobsCount}</strong></span>
      <span style="color:#10b981;">Click to inspect & validate</span>
    `;

    header.appendChild(top);
    header.appendChild(sub);

    // Expandable details block
    const details = document.createElement('div');
    details.className = 'candidate-details';
    details.id = `details-${index}`;

    // Request payload template block (e.g. GraphQL Query)
    const payloadSec = document.createElement('div');
    payloadSec.className = 'detail-section';
    payloadSec.innerHTML = `
      <div class="detail-label">Payload Template</div>
      <pre class="detail-code">${cand.payload ? escapeHtml(cand.payload) : 'None (GET Request)'}</pre>
    `;

    // Safe Request headers (security filtered)
    const headersSec = document.createElement('div');
    headersSec.className = 'detail-section';
    headersSec.innerHTML = `
      <div class="detail-label">Request Headers (Filtered)</div>
      <pre class="detail-code">${JSON.stringify(cand.requestHeaders, null, 2)}</pre>
    `;

    // Response preview (first item detail)
    const previewSec = document.createElement('div');
    previewSec.className = 'detail-section';
    previewSec.innerHTML = `
      <div class="detail-label">First Detected Item Preview</div>
      <pre class="detail-code">${cand.firstJobPreview ? escapeHtml(cand.firstJobPreview) : 'None'}</pre>
    `;

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'candidate-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-sm-action btn-confirm';
    confirmBtn.textContent = '✓ Confirm & Save to Dashboard';
    confirmBtn.addEventListener('click', () => confirmCandidate(cand, confirmBtn));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-sm-action btn-reject';
    rejectBtn.textContent = '✗ Reject';
    rejectBtn.addEventListener('click', () => rejectCandidate(cand.requestUrl));

    actions.appendChild(confirmBtn);
    actions.appendChild(rejectBtn);

    details.appendChild(payloadSec);
    details.appendChild(headersSec);
    details.appendChild(previewSec);
    details.appendChild(actions);

    card.appendChild(header);
    card.appendChild(details);
    container.appendChild(card);
  });
}

function toggleDetails(index) {
  const details = $(`details-${index}`);
  if (details) {
    details.classList.toggle('active');
  }
}

// ─── Actions & Backend Relay ─────────────────────────────────────────────────

async function confirmCandidate(cand, btn) {
  btn.textContent = 'Saving...';
  btn.disabled = true;

  const stored = await chrome.storage.local.get(['careeros_api', 'user_email']);
  const apiBase = stored.careeros_api || currentApiBase;
  const email = stored.user_email || DEFAULT_EMAIL;

  try {
    // Send to discover endpoint
    const response = await fetch(`${apiBase}/api/watcher/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyIdentifier: selectedCompany.companyIdentifier,
        companyName: selectedCompany.companyName,
        careersUrl: selectedCompany.careersUrl,
        requestUrl: cand.requestUrl,
        method: cand.method,
        headers: cand.requestHeaders,
        payload: cand.payload || undefined,
        responseBody: cand.responseBody || undefined,
        contentType: cand.contentType
      })
    });

    if (response.ok) {
      btn.textContent = '✓ Saved to Backend!';
      btn.style.background = '#059669';
      setTimeout(() => {
        stopDiscovery();
      }, 1500);
    } else {
      throw new Error(`Server returned ${response.status}`);
    }
  } catch (err) {
    alert(`Failed to save configuration: ${err.message}`);
    btn.textContent = 'Try Again';
    btn.disabled = false;
  }
}

async function rejectCandidate(requestUrl) {
  const data = await chrome.storage.local.get('candidates');
  const filtered = (data.candidates || []).filter(c => c.requestUrl !== requestUrl);
  await chrome.storage.local.set({
    candidates: filtered,
    candidate_count: filtered.length
  });
  updateStats();
}

// ─── Debug Panel Updates ──────────────────────────────────────────────────────

async function updateDebugPanel() {
  const data = await chrome.storage.local.get([
    'captured_count',
    'ignored_count',
    'candidate_count',
    'highest_confidence',
    'highest_confidence_url',
    'latest_ignored_reason',
    'latest_preview'
  ]);

  $('debug-captured-count').textContent = data.captured_count || 0;
  $('debug-ignored-count').textContent = data.ignored_count || 0;
  $('debug-candidate-count').textContent = data.candidate_count || 0;
  $('debug-highest-conf').textContent = `${data.highest_confidence || 0}%`;
  $('debug-highest-url').textContent = data.highest_confidence_url || 'None';
  $('debug-ignored-detail').textContent = data.latest_ignored_reason || 'None';
  
  if (data.latest_preview && data.latest_preview !== 'None') {
    $('debug-json-preview').textContent = data.latest_preview;
  } else {
    $('debug-json-preview').textContent = 'No payloads inspected yet.';
  }
}

// ─── Save Settings ────────────────────────────────────────────────────────────

async function saveSettings() {
  const btn = $('save-settings-btn');
  const apiBase = $('api-url-input').value.trim().replace(/\/$/, '') || DEFAULT_API;
  const email   = $('email-input').value.trim() || DEFAULT_EMAIL;

  currentApiBase = apiBase;
  await chrome.storage.local.set({ careeros_api: apiBase, user_email: email });
  await chrome.runtime.sendMessage({ type: 'SET_API', url: apiBase });
  
  // Reload watchlist with new URL
  await loadWatchlist(apiBase, email);

  btn.textContent = '✓ Settings Saved';
  btn.style.background = '#10b981';
  btn.style.color = '#fff';
  
  setTimeout(() => {
    btn.textContent = 'Save Settings';
    btn.style.background = '';
    btn.style.color = '';
  }, 1500);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setWatchingUI() {
  $('status-dot').classList.add('active');
  $('view-inactive').style.display = 'none';
  $('view-active').style.display = 'block';
  $('watching-company-name').textContent = selectedCompany?.companyName || '...';
}

function setStoppedUI() {
  $('status-dot').classList.remove('active');
  $('view-inactive').style.display = 'block';
  $('view-active').style.display = 'none';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

init();

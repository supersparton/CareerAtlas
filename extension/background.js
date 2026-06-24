// background.js — Service Worker
// Intercepts real network responses via chrome.webRequest,
// analyses them for job-related JSON, and sends to CareerOS backend.

const CAREEROS_API = 'http://localhost:3000';

// Patterns we consider "job-related" in a response body
const JOB_KEYWORDS = ['title', 'location', 'job', 'position', 'requisition', 'posting', 'role', 'department'];

// Track which tabs are being watched and their company info
const watchedTabs = {}; // tabId -> { companyIdentifier, companyName, careersUrl, companyId }

// Track which requests we've already processed per tab to avoid duplicates
const processedRequests = {}; // tabId -> Set of requestUrls

// ─── Extension Lifecycle ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CareerOS] Extension installed.');
  chrome.storage.local.set({ careeros_api: CAREEROS_API, discovered: [] });
});

// ─── Message from popup / content script ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_WATCHING') {
    const tabId = sender.tab?.id || message.tabId;
    if (tabId) {
      watchedTabs[tabId] = {
        companyIdentifier: message.companyIdentifier,
        companyName: message.companyName,
        careersUrl: message.careersUrl,
        companyId: message.companyId
      };
      processedRequests[tabId] = new Set();
      console.log(`[CareerOS] Now watching tab ${tabId} for ${message.companyName}`);
      sendResponse({ ok: true });
    }
  }

  if (message.type === 'STOP_WATCHING') {
    // Popup has no tab context, so tabId is passed explicitly in the message
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      delete watchedTabs[tabId];
      delete processedRequests[tabId];
    }
    sendResponse({ ok: true });
  }

  if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['careeros_api', 'discovered', 'watchlists'], (data) => {
      sendResponse(data);
    });
    return true; // async
  }

  if (message.type === 'NETWORK_CAPTURED') {
    // From content script injected interceptor
    handleCapturedRequest(sender.tab?.id, message.data);
    sendResponse({ ok: true });
  }

  if (message.type === 'SET_API') {
    chrome.storage.local.set({ careeros_api: message.url });
    sendResponse({ ok: true });
  }

  return true; // keep port open for async
});

// ─── Handle requests captured by the page-side XHR/Fetch interceptor ────────

async function handleCapturedRequest(tabId, data) {
  if (!tabId || !watchedTabs[tabId]) return;

  const { requestUrl, method, requestHeaders, responseBody, contentType, statusCode } = data;
  const company = watchedTabs[tabId];

  // Skip non-2xx, non-JSON, and already processed
  if (statusCode < 200 || statusCode >= 300) return;
  if (!contentType?.includes('json') && !contentType?.includes('javascript')) return;
  if (processedRequests[tabId]?.has(requestUrl)) return;

  // Check if response body looks like job listings
  if (!looksLikeJobData(responseBody)) return;

  // Mark as processed
  processedRequests[tabId].add(requestUrl);

  console.log(`[CareerOS] 🎯 Captured potential job API endpoint: ${requestUrl}`);

  // Broadcast to popup immediately for live display
  chrome.runtime.sendMessage({
    type: 'ENDPOINT_FOUND',
    data: {
      requestUrl,
      method,
      contentType,
      company: company.companyName,
      responsePreview: responseBody?.substring(0, 500)
    }
  }).catch(() => {}); // popup may not be open

  // Show browser notification
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'CareerOS: Job API Found!',
    message: `Discovered endpoint for ${company.companyName}: ${new URL(requestUrl).pathname}`
  });

  // Send to CareerOS backend
  await sendToBackend(company, requestUrl, method, requestHeaders, responseBody, contentType);
}

// ─── Analyse body heuristically ─────────────────────────────────────────────

function looksLikeJobData(body) {
  if (!body || body.length < 10) return false;
  try {
    const parsed = JSON.parse(body);
    const bodyStr = body.toLowerCase();

    // Must contain job-related keywords
    const keywordHits = JOB_KEYWORDS.filter(k => bodyStr.includes(k)).length;
    if (keywordHits < 2) return false;

    // Must be an array or an object containing an array
    if (Array.isArray(parsed) && parsed.length > 0) return true;
    if (parsed && typeof parsed === 'object') {
      const arrays = Object.values(parsed).filter(v => Array.isArray(v) && v.length > 0);
      return arrays.length > 0;
    }
  } catch {
    return false;
  }
  return false;
}

// ─── Send discovered endpoint to CareerOS backend ───────────────────────────

async function sendToBackend(company, requestUrl, method, requestHeaders, responseBody, contentType) {
  const { careeros_api } = await chrome.storage.local.get('careeros_api');
  const apiBase = careeros_api || CAREEROS_API;

  try {
    const res = await fetch(`${apiBase}/api/watcher/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyIdentifier: company.companyIdentifier,
        companyName: company.companyName,
        careersUrl: company.careersUrl,
        requestUrl,
        method: method || 'GET',
        headers: requestHeaders || {},
        responseBody: responseBody?.substring(0, 4000), // truncate huge payloads
        contentType: contentType || 'application/json'
      })
    });

    if (res.ok) {
      const result = await res.json();
      console.log(`[CareerOS] ✅ Backend accepted endpoint. Classification: ${result.analysis?.classification}`);

      // Store in local discovered list
      const { discovered = [] } = await chrome.storage.local.get('discovered');
      discovered.push({
        companyName: company.companyName,
        requestUrl,
        method,
        classification: result.analysis?.classification,
        confidenceScore: result.analysis?.confidenceScore,
        capturedAt: new Date().toISOString()
      });
      chrome.storage.local.set({ discovered });

      // Tell popup to refresh
      chrome.runtime.sendMessage({ type: 'BACKEND_SAVED', data: result }).catch(() => {});
    }
  } catch (err) {
    console.error('[CareerOS] Error sending to backend:', err.message);
  }
}

// ─── Tab cleanup ─────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete watchedTabs[tabId];
  delete processedRequests[tabId];
});

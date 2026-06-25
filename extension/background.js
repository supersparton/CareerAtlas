// background.js — Service Worker for CareerOS Network Discovery Assistant

const DEFAULT_API = 'http://localhost:3001';
const FALLBACK_API = 'http://localhost:3000';

// Heuristic keywords
const URL_KEYWORDS = ['job', 'jobs', 'career', 'careers', 'vacancy', 'vacancies', 'opening', 'openings', 'position', 'positions', 'graphql'];
const BODY_KEYWORDS = ['title', 'location', 'department', 'employmenttype', 'posteddate', 'applyurl', 'description'];
const IGNORE_URL_KEYWORDS = ['analytics', 'metrics', 'tracking', 'events', 'telemetry', 'ads', 'google-analytics', 'mixpanel', 'sentry', 'hotjar'];

// ─── Message Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_WATCHING') {
    const tabId = message.tabId;
    if (tabId) {
      // Reset stats for the discovery session
      chrome.storage.local.set({
        watching_tab: tabId,
        watching_company: {
          companyIdentifier: message.companyIdentifier,
          companyName: message.companyName,
          careersUrl: message.careersUrl,
          companyId: message.companyId
        },
        captured_count: 0,
        ignored_count: 0,
        candidate_count: 0,
        highest_confidence: 0,
        highest_confidence_url: 'None',
        latest_ignored_reason: 'None',
        latest_preview: 'None',
        candidates: []
      });
      console.log(`[Discovery Assistant] Started monitoring tab ${tabId} for ${message.companyName}`);
    }
    sendResponse({ ok: true });
  }

  if (message.type === 'START_DISCOVERY_FROM_PAGE') {
    const company = message.data;
    if (company && company.careersUrl) {
      chrome.tabs.create({ url: company.careersUrl }, async (newTab) => {
        const targetTabId = newTab.id;

        // Persist active watching state
        await chrome.storage.local.set({
          watching_tab: targetTabId,
          watching_company: {
            companyId: company.companyId,
            companyIdentifier: company.companyIdentifier,
            companyName: company.companyName,
            careersUrl: company.careersUrl
          },
          captured_count: 0,
          ignored_count: 0,
          candidate_count: 0,
          highest_confidence: 0,
          highest_confidence_url: 'None',
          latest_ignored_reason: 'None',
          latest_preview: 'None',
          candidates: []
        });

        // Inject immediately
        try {
          chrome.scripting.executeScript({
            target: { tabId: targetTabId, allFrames: true },
            files: ['interceptor.js'],
            world: 'MAIN'
          });
        } catch (e) {
          console.error('[Discovery Assistant] Immediate injection from page trigger failed:', e.message);
        }
      });
    }
    sendResponse({ ok: true });
  }

  if (message.type === 'STOP_WATCHING') {
    chrome.storage.local.remove(['watching_tab', 'watching_company']);
    console.log('[Discovery Assistant] Stopped monitoring.');
    sendResponse({ ok: true });
  }

  if (message.type === 'NETWORK_CAPTURED') {
    const tabId = sender.tab?.id;
    if (tabId) {
      handleCapturedRequest(tabId, message.data);
    }
    sendResponse({ ok: true });
  }

  return true;
});

// ─── Main Request Handler & Heuristics ────────────────────────────────────────

async function handleCapturedRequest(tabId, data) {
  const stored = await chrome.storage.local.get([
    'watching_tab',
    'watching_company',
    'captured_count',
    'ignored_count',
    'candidate_count',
    'highest_confidence',
    'highest_confidence_url',
    'latest_ignored_reason',
    'latest_preview',
    'candidates'
  ]);

  if (!stored.watching_tab || stored.watching_tab !== tabId) {
    return; // Ignore requests from other tabs entirely
  }

  const { requestUrl, method, requestHeaders, responseBody, contentType, statusCode } = data;
  const urlLower = requestUrl.toLowerCase();

  // 1. IGNORE LOGIC
  let isIgnored = false;
  let ignoreReason = '';

  // Ignore status codes outside 200-299
  if (statusCode < 200 || statusCode >= 300) {
    isIgnored = true;
    ignoreReason = `HTTP ${statusCode}`;
  }
  // Ignore non-JSON content types
  else if (contentType && !contentType.includes('json') && !contentType.includes('javascript')) {
    isIgnored = true;
    ignoreReason = `Non-JSON type: ${contentType.split(';')[0]}`;
  }
  // Ignore assets, fonts, css, images, etc.
  else if (
    urlLower.match(/\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot|css|mp4|webm|ogv)$/) ||
    urlLower.includes('/assets/') ||
    urlLower.includes('/static/css/') ||
    urlLower.includes('/static/js/main.')
  ) {
    isIgnored = true;
    ignoreReason = 'Static Asset/Media';
  }
  // Ignore analytics, telemetry, tracking
  else if (IGNORE_URL_KEYWORDS.some(keyword => urlLower.includes(keyword))) {
    isIgnored = true;
    ignoreReason = 'Analytics/Tracking URL';
  }

  if (isIgnored) {
    const newIgnoredCount = (stored.ignored_count || 0) + 1;
    await chrome.storage.local.set({
      ignored_count: newIgnoredCount,
      latest_ignored_reason: `${ignoreReason} (${requestUrl.substring(0, 50)}...)`
    });
    // Broadcast status update to popup
    chrome.runtime.sendMessage({ type: 'STATS_UPDATED' }).catch(() => {});
    return;
  }

  // Increment captured count
  const newCapturedCount = (stored.captured_count || 0) + 1;
  await chrome.storage.local.set({ captured_count: newCapturedCount });

  // 2. PARSE BODY & SCORE HEURISTICS
  let confidenceScore = 0;
  let detectedProvider = 'Custom API';
  let detectedJobsCount = 0;
  let firstJobPreview = null;
  let parsedBody = null;

  try {
    parsedBody = JSON.parse(responseBody);
  } catch (e) {
    // If not valid JSON, ignore
    const newIgnoredCount = (stored.ignored_count || 0) + 1;
    await chrome.storage.local.set({
      ignored_count: newIgnoredCount,
      latest_ignored_reason: `JSON parsing failed`
    });
    chrome.runtime.sendMessage({ type: 'STATS_UPDATED' }).catch(() => {});
    return;
  }

  // Heuristic A: URL Keywords (+10 each)
  URL_KEYWORDS.forEach(keyword => {
    if (urlLower.includes(keyword)) {
      confidenceScore += 10;
    }
  });

  // Heuristic B: Response Body Content (inspect values & keys)
  const bodyStringLower = responseBody.toLowerCase();
  BODY_KEYWORDS.forEach(keyword => {
    if (bodyStringLower.includes(`"${keyword}"`)) {
      confidenceScore += 10;
    }
  });

  // Heuristic C: JSON structure (Arrays of objects)
  let jobArray = null;
  if (Array.isArray(parsedBody)) {
    jobArray = parsedBody;
  } else if (parsedBody && typeof parsedBody === 'object') {
    // Check if any property of the object is a non-empty array of objects
    for (const key in parsedBody) {
      if (Array.isArray(parsedBody[key]) && parsedBody[key].length > 0 && typeof parsedBody[key][0] === 'object') {
        jobArray = parsedBody[key];
        break;
      }
    }
  }

  if (jobArray && jobArray.length > 0) {
    confidenceScore += 20; // contains arrays of objects
    detectedJobsCount = jobArray.length;
    
    // Inspect the first item for job attributes
    const firstItem = jobArray[0];
    firstJobPreview = firstItem;

    // Check properties of first item
    const keys = Object.keys(firstItem).map(k => k.toLowerCase());
    const hasTitle = keys.some(k => k.includes('title') || k.includes('role') || k.includes('name'));
    const hasLocation = keys.some(k => k.includes('location') || k.includes('city') || k.includes('country'));
    const hasReqId = keys.some(k => k.includes('id') || k.includes('req') || k.includes('key') || k.includes('code'));
    const hasUrl = keys.some(k => k.includes('url') || k.includes('link') || k.includes('href') || k.includes('apply'));

    if (hasTitle) confidenceScore += 10;
    if (hasLocation) confidenceScore += 10;
    if (hasReqId) confidenceScore += 10;
    if (hasUrl) confidenceScore += 10;

    // Check for bad indicators (feature flags, preferences, localization)
    const isConfig = keys.some(k => k.includes('feature') || k.includes('flag') || k.includes('locale') || k.includes('lang') || k.includes('theme'));
    if (isConfig) {
      confidenceScore -= 40;
    }
  } else {
    // No array of objects found -> likely config or localization
    confidenceScore -= 30;
  }

  // Heuristic D: URL Penalties
  IGNORE_URL_KEYWORDS.forEach(keyword => {
    if (urlLower.includes(keyword)) {
      confidenceScore -= 30;
    }
  });

  // Heuristic E: ATS Recognition
  if (urlLower.includes('boards.greenhouse.io') || urlLower.includes('greenhouse.io')) {
    detectedProvider = 'Greenhouse';
    confidenceScore += 50;
  } else if (urlLower.includes('jobs.lever.co') || urlLower.includes('api.lever.co')) {
    detectedProvider = 'Lever';
    confidenceScore += 50;
  } else if (urlLower.includes('ashbyhq.com')) {
    detectedProvider = 'Ashby';
    confidenceScore += 50;
  } else if (urlLower.includes('workday') || urlLower.includes('/wday/')) {
    detectedProvider = 'Workday';
    confidenceScore += 50;
  } else if (urlLower.includes('smartrecruiters.com')) {
    detectedProvider = 'SmartRecruiters';
    confidenceScore += 50;
  }

  // Bound the final score
  confidenceScore = Math.max(0, Math.min(100, confidenceScore));

  // Security constraints: Strip Auth/Cookie headers
  const safeHeaders = {};
  if (requestHeaders) {
    Object.keys(requestHeaders).forEach(k => {
      const kLower = k.toLowerCase();
      if (!kLower.includes('cookie') && !kLower.includes('authorization') && !kLower.includes('token') && !kLower.includes('session')) {
        safeHeaders[k] = requestHeaders[k];
      }
    });
  }

  // Store if it qualifies as a candidate (score >= 25)
  if (confidenceScore >= 25) {
    const candidates = stored.candidates || [];
    
    // De-duplicate candidates by request URL
    const existingIdx = candidates.findIndex(c => c.requestUrl === requestUrl);
    
    const candidateData = {
      requestUrl,
      method: method || 'GET',
      requestHeaders: safeHeaders,
      payload: data.payload || null,
      responseBody: responseBody ? responseBody.substring(0, 3000) : null,
      contentType,
      provider: detectedProvider,
      confidence: confidenceScore,
      detectedJobsCount,
      firstJobPreview: firstJobPreview ? JSON.stringify(firstJobPreview, null, 2) : 'None'
    };

    if (existingIdx >= 0) {
      candidates[existingIdx] = candidateData;
    } else {
      candidates.push(candidateData);
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    const highestConf = candidates[0]?.confidence || 0;
    const highestConfUrl = candidates[0]?.requestUrl || 'None';

    await chrome.storage.local.set({
      candidates,
      candidate_count: candidates.length,
      highest_confidence: highestConf,
      highest_confidence_url: highestConfUrl,
      latest_preview: responseBody ? responseBody.substring(0, 150) + '...' : 'None'
    });
  }

  // Notify popup of update
  chrome.runtime.sendMessage({ type: 'STATS_UPDATED' }).catch(() => {});
}

// ─── Tab cleanup & Injection ─────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.local.get(['watching_tab'], (stored) => {
      if (stored.watching_tab === tabId) {
        console.log(`[Discovery Assistant] watched tab ${tabId} loading. Injecting interceptor into MAIN world.`);
        chrome.scripting.executeScript({
          target: { tabId: tabId, allFrames: true },
          files: ['interceptor.js'],
          world: 'MAIN'
        }).catch(err => {
          console.error('[Discovery Assistant] Injection failed:', err.message);
        });
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await chrome.storage.local.get('watching_tab');
  if (stored.watching_tab === tabId) {
    await chrome.storage.local.remove(['watching_tab', 'watching_company']);
    console.log(`[Discovery Assistant] Watched tab ${tabId} closed. Stopped watching.`);
  }
});

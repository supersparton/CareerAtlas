// content.js — runs in extension context on every page
// Injects interceptor.js into the page context (so it can patch fetch/XHR)
// then listens for captured data and relays it to background.js

// ── Guard: skip restricted / internal pages ───────────────────────────────────
const origin = window.location.origin;
if (
  origin.startsWith('chrome') ||
  origin.startsWith('chrome-extension') ||
  origin.startsWith('about') ||
  origin.startsWith('devtools')
) {
  // Do nothing on extension/browser internal pages
} else {
  // ── 1. Inject interceptor.js into the page context ──────────────────────────
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    // Ignore if extension context already invalidated at inject time
  }

  // ── 2. Relay intercepted messages from page → background ────────────────────
  window.addEventListener('message', (event) => {
    if (!event.data?.__careeros) return;

    // Guard: check chrome.runtime is still valid before calling
    if (!chrome.runtime?.id) return;

    try {
      chrome.runtime.sendMessage({
        type: 'NETWORK_CAPTURED',
        data: event.data.data
      }).catch(() => {
        // Swallow rejected promises (background worker inactive)
      });
    } catch (e) {
      // Swallow synchronous "Extension context invalidated" errors
      // This happens when the extension is reloaded while the page is open
    }
  });

  // ── 3. Listen for messages from background ───────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'INJECT_WATCH') {
        console.log('[CareerOS] Content script active, interceptor running.');
      }
    });
  } catch (e) {
    // Extension context invalidated
  }
}

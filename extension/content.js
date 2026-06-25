// content.js — runs in extension context on every page
// Relays intercepted network data from the page context (MAIN world) to the background worker.

try {
  // Listen for intercepted messages from page context (interceptor.js in MAIN world)
  window.addEventListener('message', (event) => {
    if (!event.data?.__careeros) return;

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({
          type: 'NETWORK_CAPTURED',
          data: event.data.data
        }).catch(() => {
          // Swallow rejected promises
        });
      }
    } catch (e) {
      // Swallow context invalidated errors
    }
  });

  // Verify content script is active
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_WATCH') {
      console.log('[CareerOS Content] Active and listening for messages.');
      sendResponse({ ok: true });
    }
  });

  // Listen for custom trigger from the web dashboard page
  document.addEventListener('CAREEROS_DISCOVER_API', (event) => {
    const detail = event.detail;
    if (detail && detail.careersUrl) {
      console.log('[CareerOS Content] Received CAREEROS_DISCOVER_API trigger:', detail);
      chrome.runtime.sendMessage({
        type: 'START_DISCOVERY_FROM_PAGE',
        data: detail
      }).catch(() => {});
    }
  });
} catch (e) {
  // Context invalidated
}

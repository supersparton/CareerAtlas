// interceptor.js — injected INTO the page context (not extension context)
// Monkey-patches window.XMLHttpRequest and window.fetch to capture real network calls.

(function () {
  if (window.__careeros_interceptor_active) return;
  window.__careeros_interceptor_active = true;

  const ORIGIN = window.location.origin;

  function dispatch(data) {
    window.postMessage({ __careeros: true, data }, '*');
  }

  // ── Patch fetch ────────────────────────────────────────────────────────────
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const request = args[0];
    const init = args[1] || {};
    const url = typeof request === 'string' ? request : request?.url;
    const method = init.method || (typeof request === 'object' ? request.method : 'GET') || 'GET';
    const requestHeaders = {};

    // Collect request headers
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { requestHeaders[k] = v; });
    }

    // Collect request body (payload)
    let payload = null;
    if (init.body) {
      if (typeof init.body === 'string') {
        payload = init.body;
      } else if (init.body instanceof URLSearchParams) {
        payload = init.body.toString();
      } else {
        try {
          payload = JSON.stringify(init.body);
        } catch (e) {}
      }
    }

    let response;
    try {
      response = await originalFetch(...args);
    } catch (err) {
      throw err;
    }

    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      const statusCode = clone.status;

      // Only intercept JSON/JS responses
      if (contentType.includes('json') || contentType.includes('javascript')) {
        clone.text().then((body) => {
          dispatch({
            requestUrl: url,
            method: method.toUpperCase(),
            requestHeaders,
            payload,
            responseBody: body,
            contentType,
            statusCode
          });
        }).catch(() => {});
      }
    } catch {}

    return response;
  };

  // ── Patch XMLHttpRequest ───────────────────────────────────────────────────
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OriginalXHR();
    let _method = 'GET';
    let _url = '';
    const _requestHeaders = {};
    let _payload = null;

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _method = method.toUpperCase();
      _url = url;
      return origOpen(method, url, ...rest);
    };

    const origSetHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (k, v) {
      _requestHeaders[k] = v;
      return origSetHeader(k, v);
    };

    const origSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      if (body) {
        if (typeof body === 'string') {
          _payload = body;
        } else {
          try {
            _payload = JSON.stringify(body);
          } catch (e) {}
        }
      }
      return origSend(body);
    };

    xhr.addEventListener('load', function () {
      try {
        const contentType = xhr.getResponseHeader('content-type') || '';
        const statusCode = xhr.status;

        if ((contentType.includes('json') || contentType.includes('javascript')) &&
          statusCode >= 200 && statusCode < 300) {
          dispatch({
            requestUrl: _url,
            method: _method,
            requestHeaders: _requestHeaders,
            payload: _payload,
            responseBody: xhr.responseText,
            contentType,
            statusCode
          });
        }
      } catch {}
    });

    return xhr;
  };
  window.XMLHttpRequest.prototype = OriginalXHR.prototype;

  console.log('[CareerOS] Network interceptor active on', ORIGIN);
})();

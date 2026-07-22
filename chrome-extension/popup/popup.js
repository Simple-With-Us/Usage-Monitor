/* global chrome */
// Usage Monitor launcher popup.
// Stores only a non-secret dashboard URL and opens it in a new tab.
// It never reads cookies, site storage, page content, or any credential,
// and it never transmits data to any endpoint.

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('dashboardUrl');
  const openBtn = document.getElementById('openBtn');
  const openAppBtn = document.getElementById('openAppBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  function setStatus(message) {
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 2000);
  }

  // Require HTTPS for remote dashboards. Plain HTTP is accepted only for
  // loopback development, where no network hop can expose a login credential.
  function normalizeUrl(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      const loopback = parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '::1'
        || parsed.hostname === '[::1]';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return '';
      return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  chrome.storage.local.get(['dashboardUrl'], (result) => {
    if (result.dashboardUrl) urlInput.value = result.dashboardUrl;
  });

  saveBtn.addEventListener('click', () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      setStatus('Use HTTPS (or HTTP on localhost)');
      return;
    }
    urlInput.value = url;
    chrome.storage.local.set({ dashboardUrl: url }, () => setStatus('Saved'));
  });

  openBtn.addEventListener('click', () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      setStatus('Use HTTPS (or HTTP on localhost)');
      return;
    }
    chrome.storage.local.set({ dashboardUrl: url }, () => {
      chrome.tabs.create({ url });
      window.close();
    });
  });

  openAppBtn.addEventListener('click', () => {
    window.location.href = 'usagemonitor://dashboard';
  });
});

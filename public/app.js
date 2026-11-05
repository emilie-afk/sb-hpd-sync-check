(function () {
  'use strict';

  var API_HEADERS = { 'Content-Type': 'application/json', 'X-HPD-Request': '1' };
  var $ = function (id) { return document.getElementById(id); };

  // Older versions kept the raw password in sessionStorage. Remove it.
  try { sessionStorage.removeItem('hpd_pw'); } catch (_) {}

  // DOM helpers: all upstream text is inserted with textContent, never as HTML.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function nameCell(r, badge) {
    var td = el('td', 'td-name');
    var title = r.commonName ? String(r.title || '').replace(/\s*\([^)]+\)\s*$/, '') : String(r.title || '');
    td.appendChild(document.createTextNode(title));
    if (r.commonName) {
      td.appendChild(document.createTextNode(' '));
      td.appendChild(el('span', 'common', '(' + r.commonName + ')'));
    }
    if (badge) td.appendChild(el('span', 'badge-review', badge));
    return td;
  }

  function table(cls, headers, rows) {
    var wrap = el('div', 'table-wrap' + (cls ? ' ' + cls : ''));
    var t = el('table');
    var thead = el('thead');
    var hr = el('tr');
    headers.forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    var tbody = el('tbody');
    rows.forEach(function (r) { tbody.appendChild(r); });
    t.appendChild(thead);
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  var WARNING_TEXT = {
    hpd_truncated: 'The HPD catalog has more pages than this check reads; some products were not compared.',
    hpd_empty: 'The HPD catalog returned no products.',
    inventory_empty: 'The inventory sheet returned no SKUs.',
    reference_empty: 'The Products Master sheet returned no Shopify-mapped SKUs.',
    storefront_unverified: 'Some storefront checks failed. Those products are listed separately below and are not counted as missing.'
  };

  function render(data) {
    var d = new Date(data.ts);
    var meta = data.count + ' product' + (data.count !== 1 ? 's' : '') + ' not yet synced' +
      '  ·  Last refreshed ' + d.toLocaleDateString() + ' at ' + d.toLocaleTimeString();
    if (data.cached) meta += '  ·  cached result (' + (data.cachedAgeSeconds || 0) + 's old)';
    if (!data.complete) meta = 'INCOMPLETE — ' + meta;
    $('meta').textContent = meta;

    var content = $('content');
    content.textContent = '';

    if (!data.complete) {
      var w = el('div', 'warn-box');
      w.appendChild(el('strong', null, '⚠️ Partial result — this is not a complete comparison.'));
      (data.warnings || []).forEach(function (code) {
        w.appendChild(el('div', null, WARNING_TEXT[code] || 'A data source returned incomplete data.'));
      });
      content.appendChild(w);
    }

    var rows = (data.results || []).map(function (r, i) {
      var tr = el('tr');
      tr.appendChild(el('td', 'td-num', i + 1));
      tr.appendChild(nameCell(r));
      return tr;
    });
    content.appendChild(table('', ['#', 'Product Name'], rows));

    if (data.review && data.review.length) {
      content.appendChild(el('div', 'section-label review', '⚠️ Needs Review — found on Shopify but out of stock'));
      content.appendChild(table('review', ['#', 'Product Name', 'Note'], data.review.map(function (r, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'td-num', i + 1));
        tr.appendChild(nameCell(r, '⚠ verify'));
        tr.appendChild(el('td', 'td-note', r.note || ''));
        return tr;
      })));
    }

    if (data.unverified && data.unverified.length) {
      content.appendChild(el('div', 'section-label unverified', '⛔ Could not verify — storefront check failed'));
      content.appendChild(table('unverified', ['#', 'Product Name', 'Note'], data.unverified.map(function (r, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'td-num', i + 1));
        tr.appendChild(nameCell(r, 'unverified'));
        tr.appendChild(el('td', 'td-note', r.note || ''));
        return tr;
      })));
    }

    var s = data.stats || {};
    $('footer').textContent =
      (s.hpd || 0) + ' HPD products scanned  ·  ' +
      (s.inStockSkus || 0) + ' in-stock SKUs  ·  ' +
      (s.shopifyMapped || 0) + ' Shopify-mapped SKUs';
  }

  function showLoading() {
    var c = $('content');
    c.textContent = '';
    var box = el('div', 'loading');
    box.appendChild(el('div', 'spinner'));
    box.appendChild(document.createTextNode('Fetching live data from HPD & Google Sheets…'));
    c.appendChild(box);
    $('footer').textContent = '';
    $('meta').textContent = 'Loading…';
    $('refreshBtn').disabled = true;
  }

  function showError(msg) {
    var c = $('content');
    c.textContent = '';
    c.appendChild(el('div', 'error-box', '⚠️ ' + msg));
    $('meta').textContent = 'No comparison available';
    $('footer').textContent = '';
  }

  function showGate(msg) {
    cancelPendingCheck();
    hideNotice();
    $('app').hidden = true;
    $('gate').hidden = false;
    $('gateError').textContent = msg || '';
    $('pwInput').value = '';
    $('pwInput').focus();
  }

  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts));
  }

  async function errorText(res) {
    try { var j = await res.json(); if (j && j.error) return j.error; } catch (_) {}
    return 'HTTP ' + res.status;
  }

  // Each check gets a generation number. Signing out (or a newer check)
  // bumps it and aborts the request, so a late response is never rendered.
  var generation = 0;
  var inflight = null;

  function cancelPendingCheck() {
    generation++;
    if (inflight) { try { inflight.abort(); } catch (_) {} inflight = null; }
  }

  async function load() {
    cancelPendingCheck();
    var gen = generation;
    var ctrl = new AbortController();
    inflight = ctrl;
    hideNotice();
    showLoading();
    try {
      var res = await api('/api/check', { method: 'POST', headers: API_HEADERS, body: '{}', signal: ctrl.signal });
      if (gen !== generation) return;
      if (res.status === 401) { showGate('Your session has ended. Please sign in again.'); return; }
      if (!res.ok) { var msg = await errorText(res); if (gen !== generation) return; throw new Error(msg); }
      var data = await res.json();
      if (gen !== generation) return;
      render(data);
    } catch (e) {
      if (gen !== generation) return;
      showError((e && e.message) || 'Unknown error.');
    } finally {
      if (gen === generation) { inflight = null; $('refreshBtn').disabled = false; }
    }
  }

  function showNotice(msg) { var n = $('notice'); n.textContent = msg; n.hidden = false; }
  function hideNotice() { var n = $('notice'); n.textContent = ''; n.hidden = true; }

  async function unlock(ev) {
    if (ev) ev.preventDefault();
    var pw = $('pwInput').value;
    if (!pw.trim()) return;
    $('unlockBtn').disabled = true;
    $('gateError').textContent = '';
    try {
      var res = await api('/api/login', { method: 'POST', headers: API_HEADERS, body: JSON.stringify({ password: pw }) });
      $('pwInput').value = '';
      if (res.ok) { showApp(); load(); return; }
      $('gateError').textContent = res.status === 401 ? 'Incorrect password.' : await errorText(res);
    } catch (_) {
      $('gateError').textContent = 'Could not reach the server.';
    } finally {
      $('unlockBtn').disabled = false;
    }
  }

  async function signOut() {
    var hadPendingCheck = !!inflight;
    cancelPendingCheck();
    hideNotice();
    if (hadPendingCheck) {
      $('content').textContent = '';
      $('footer').textContent = '';
      $('meta').textContent = 'Check cancelled';
    }
    var btn = $('signoutBtn');
    btn.disabled = true;
    $('refreshBtn').disabled = true;
    btn.textContent = 'Signing out…';
    var ok = false;
    var failure = 'Sign out failed — you are still signed in. Please try again.';
    try {
      var res = await api('/api/logout', { method: 'POST', headers: API_HEADERS, body: '{}' });
      ok = res.ok;
      if (!ok) failure = 'Sign out failed (' + (await errorText(res)) + ') — you are still signed in. Please try again.';
    } catch (_) {
      failure = 'Could not reach the server to sign out — you are still signed in. Please try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign out';
      $('refreshBtn').disabled = false;
    }
    if (!ok) { showNotice(failure); return; }
    $('content').textContent = '';
    $('footer').textContent = '';
    showGate('');
  }

  $('gateForm').addEventListener('submit', unlock);
  $('refreshBtn').addEventListener('click', load);
  $('signoutBtn').addEventListener('click', signOut);

  // Restore an existing session after a reload.
  api('/api/session', { headers: { 'X-HPD-Request': '1' } })
    .then(function (res) { if (res.ok) { showApp(); load(); } else { showGate(''); } })
    .catch(function () { showGate('Could not reach the server.'); });
})();

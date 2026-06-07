// ==UserScript==
// @name         FC Pack Automation v5
// @namespace    fc-pack-automation
// @version      5.0
// @description  PackApp → ShipApp auto-ship — all known bugs fixed
// @author       youryanh
// @match        https://packapp-sptc-prod-na.aka.corp.amazon.com/mix/index.html
// @match        https://fcswat-us.aka.amazon.com/workflow/init
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ─────────────────────────────────────────────────────────────────
  const STORAGE_KEY   = 'fc_pending_order_v5';
  const POLL_MS       = 800;
  const SP_SEND_DELAY = 2000;  // ms after SP00 scan before saving order
  const BOX_WAIT_MS   = 1200;  // ms after SP00 accepted before sending box

  const BOX_MAP = {
    PB2: 'FSA', PM4: 'FRQ', PM5: 'FRR', OWNBOX: 'OWNBOX', SIOC: 'OWNBOX',
  };

  if (location.href.includes('packapp-sptc-prod-na')) runPackApp();
  else if (location.href.includes('fcswat-us.aka.amazon.com'))  runShipApp();

  // ═══════════════════════════════════════════════════════════════════════════
  //  PACKAPP
  // ═══════════════════════════════════════════════════════════════════════════
  function runPackApp() {
    let buffer     = '';
    let toteScanned = false;

    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#1a6e1a', color: '#fff',
      padding: '6px 12px', fontSize: '14px', fontWeight: 'bold',
      zIndex: '9999', textAlign: 'center', display: 'none',
    });
    document.body.appendChild(banner);

    function showBanner(msg, color = '#1a6e1a', ms = 5000) {
      banner.textContent = msg;
      banner.style.background = color;
      banner.style.display = 'block';
      clearTimeout(banner._t);
      banner._t = setTimeout(() => { banner.style.display = 'none'; }, ms);
    }

    // FIX: no reset timer — only flush on Enter to prevent truncation
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const raw = buffer.trim();
        buffer = '';
        if (raw) onScan(raw);
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    }, true); // capture phase

    function onScan(input) {
      if (!toteScanned && !/^sp/i.test(input)) {
        toteScanned = true;
        console.log('[FC v5 Pack] Tote:', input);
        return;
      }

      if (/^sp/i.test(input) && input.length >= 8) {
        console.log('[FC v5 Pack] SP00:', input);
        setTimeout(() => {
          const box     = detectBox();
          const barcode = box && (BOX_MAP[box] || BOX_MAP[box.toUpperCase()]);
          if (!box || !barcode) {
            showBanner('⚠ Box type not detected', '#b55a00', 6000);
            return;
          }
          const order = { sp00: input, box, barcode, ts: Date.now() };
          GM_setValue(STORAGE_KEY, JSON.stringify(order));
          showBanner(`✓ Sent to ShipApp — ${input}  [${box} → ${barcode}]`);
          toteScanned = false;
        }, SP_SEND_DELAY);
      }
    }

    function detectBox() {
      const text = document.body.innerText.toUpperCase();
      for (const key of Object.keys(BOX_MAP)) {
        if (new RegExp(`\\b${key}\\b`).test(text)) return key;
      }
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SHIPAPP
  // ═══════════════════════════════════════════════════════════════════════════
  function runShipApp() {
    let busy = false;

    // ── Overlay ───────────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', bottom: '8px', right: '8px',
      background: 'rgba(0,0,0,0.82)', color: '#fff',
      padding: '8px 12px', borderRadius: '8px', fontSize: '13px',
      zIndex: '99999', maxWidth: '400px', lineHeight: '1.6',
      boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
    });
    const sLine = document.createElement('div');
    const dLine = document.createElement('div');
    Object.assign(dLine.style, { fontSize: '11px', color: '#aaa', marginTop: '2px' });
    overlay.append(sLine, dLine);
    document.body.appendChild(overlay);
    const status = m => { sLine.textContent = m; };
    const debug  = m => { dLine.textContent = m; };
    status('⏳ FC Auto v5: waiting for order…');

    // ── Poll + visibility trigger ─────────────────────────────────────────────
    setInterval(poll, POLL_MS);
    // FIX: fire immediately when user switches to this tab
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !busy) poll();
    });

    async function poll() {
      if (busy) return;

      const raw = GM_getValue(STORAGE_KEY, '');
      if (!raw) return;

      let order;
      try { order = JSON.parse(raw); }
      catch (_) { GM_setValue(STORAGE_KEY, ''); return; }

      if (Date.now() - order.ts > 5 * 60 * 1000) {
        GM_setValue(STORAGE_KEY, '');
        return;
      }

      const bodyText = document.body.innerText;
      if (!bodyText.includes('Scan the SP')) return;

      busy = true;

      // FIX: clear order from storage immediately — prevents duplicate processing
      GM_setValue(STORAGE_KEY, '');

      await processOrder(order);
      busy = false;
    }

    async function processOrder(order) {
      status(`▶ Sending SP00: ${order.sp00}…`);
      debug('Attempting input…');

      sendBarcode(order.sp00);

      status(`⏳ Waiting for BOX screen…`);
      debug(`SP00 sent: ${order.sp00}`);

      // FIX: wait for "Scan the BOX" — the page HEADING, not the column header "BOX BARCODE"
      const boxReady = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('Scan the BOX') || t.includes('scan the box');
      }, 10000);

      if (!boxReady) {
        // FIX: detect FAILURE state explicitly
        const failed = document.body.innerText.includes('FAILURE') ||
                       document.body.innerText.includes('Invalid');
        if (failed) {
          status(`⚠ ShipApp rejected SP00: ${order.sp00}`);
          debug('FAILURE — SP00 may be expired or invalid. Re-scan in PackApp.');
        } else {
          const page = document.body.innerText.substring(0, 100).replace(/\n/g,' ');
          status(`⚠ Timed out waiting for BOX screen`);
          debug(`Page: "${page}"`);
        }
        return;
      }

      await sleep(BOX_WAIT_MS);
      status(`▶ Sending box: ${order.barcode}…`);
      debug(`Box type: ${order.box}`);

      sendBarcode(order.barcode);

      // Wait for success or failure
      const result = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('SUCCESS') || t.includes('success') ||
               t.includes('FAILURE') || t.includes('Invalid');
      }, 10000);

      if (!result) {
        status(`⚠ Timed out waiting for result`);
        debug('Check ShipApp manually');
        return;
      }

      const pageText = document.body.innerText;
      if (pageText.includes('SUCCESS') || pageText.includes('success')) {
        status(`✅ Shipped! ${order.sp00} / ${order.box} (${order.barcode})`);
        debug('Label printed. Ready for next order.');
      } else {
        status(`⚠ Box scan failed`);
        debug(`Page: "${pageText.substring(0,100).replace(/\n/,' ')}"`);
      }

      await sleep(3000);
      status('⏳ FC Auto v5: waiting for order…');
      debug('');
    }

    // ── Input: send all chars synchronously (no sleep = works in background tab)
    function sendBarcode(barcode) {
      // Try Angular scope injection first
      if (tryAngular(barcode)) return;

      // Fallback: dispatch keypress events synchronously to document.body
      // FIX: fire chars WITHOUT sleep between them — avoids background tab throttling
      // FIX: dispatch to document.body ONLY (bubbles to window) — no duplicate window dispatch
      for (const char of barcode) {
        fireChar(char);
      }
      fireEnter();
    }

    function tryAngular(barcode) {
      try {
        const ng = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).angular;
        if (!ng) return false;
        const els = document.querySelectorAll('[ng-controller],[data-ng-controller]');
        for (const el of els) {
          const scope = ng.element(el).scope();
          if (!scope) continue;
          if (typeof scope.publishBuffer === 'function') {
            scope.$apply(() => {
              scope.keystrokeBuffer = barcode;
              scope.publishBuffer();
            });
            debug(`Angular scope: publishBuffer("${barcode}")`);
            return true;
          }
          for (const m of ['submitBarcode','handleBarcode','processInput','submit']) {
            if (typeof scope[m] === 'function') {
              scope.$apply(() => scope[m](barcode));
              debug(`Angular scope: ${m}("${barcode}")`);
              return true;
            }
          }
        }
      } catch (e) {
        debug(`Angular failed: ${e.message}`);
      }
      return false;
    }

    function makeKE(type, char, code) {
      const e = new KeyboardEvent(type, {
        key: char, charCode: code, keyCode: code, which: code,
        bubbles: true, cancelable: true, composed: true,
      });
      try { Object.defineProperty(e, 'keyCode',  { value: code }); } catch(_) {}
      try { Object.defineProperty(e, 'charCode', { value: code }); } catch(_) {}
      try { Object.defineProperty(e, 'which',    { value: code }); } catch(_) {}
      return e;
    }

    function fireChar(char) {
      const code = char.charCodeAt(0);
      document.body.dispatchEvent(makeKE('keydown',  char, code));
      document.body.dispatchEvent(makeKE('keypress', char, code));
    }

    function fireEnter() {
      document.body.dispatchEvent(makeKE('keydown',  'Enter', 13));
      document.body.dispatchEvent(makeKE('keypress', 'Enter', 13));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function waitFor(predFn, ms) {
      return new Promise(resolve => {
        if (predFn()) return resolve(true);
        const start = Date.now();
        const t = setInterval(() => {
          if (predFn()) { clearInterval(t); resolve(true); }
          else if (Date.now() - start > ms) { clearInterval(t); resolve(false); }
        }, 300);
      });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  }

})();

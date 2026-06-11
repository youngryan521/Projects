// ==UserScript==
// @name         FC Pack Automation v5
// @namespace    fc-pack-automation
// @version      5.4
// @description  PackApp -> ShipApp auto-ship -- adaptive box detection, trimmed delays, optimized
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

  // --- CONFIG -----------------------------------------------------------------
  const STORAGE_KEY       = 'fc_pending_order_v5';
  const POLL_MS           = 400;   // ShipApp storage poll interval (was 800)
  const BOX_DETECT_MAX_MS = 2000;  // max wait for box type to appear in PackApp DOM
  const BOX_SEND_DELAY_MS = 600;   // wait after BOX screen before sending barcode (was 1200)

  // Box type -> ShipApp barcode map
  const BOX_MAP = {
    PB2: 'FSA', PM4: 'FRQ', PM5: 'FRR', OWNBOX: 'OWNBOX', SIOC: 'OWNBOX',
  };

  // Pre-compiled regexes -- created once at startup, reused on every detectBox() call
  const BOX_REGEX = Object.fromEntries(
    Object.keys(BOX_MAP).map(k => [k, new RegExp(`\\b${k}\\b`)])
  );

  // --- Shared utilities (used by both PackApp and ShipApp) --------------------

  // Polls predFn every intervalMs until it returns truthy or timeoutMs elapses.
  // Returns true on success, false on timeout.
  function waitFor(predFn, timeoutMs, intervalMs = 100) {
    return new Promise(resolve => {
      if (predFn()) return resolve(true);
      const start = Date.now();
      const id = setInterval(() => {
        if (predFn()) { clearInterval(id); resolve(true); }
        else if (Date.now() - start >= timeoutMs) { clearInterval(id); resolve(false); }
      }, intervalMs);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  if (location.href.includes('packapp-sptc-prod-na')) runPackApp();
  else if (location.href.includes('fcswat-us.aka.amazon.com')) runShipApp();

  // ===========================================================================
  //  PACKAPP
  // ===========================================================================
  function runPackApp() {
    let buffer      = '';
    let toteScanned = false;
    let pslipCode   = null; // set when PSLIP barcode is scanned; cleared after SP00

    // -- Status banner ---------------------------------------------------------
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#1a6e1a', color: '#fff',
      padding: '6px 12px', fontSize: '14px', fontWeight: 'bold',
      zIndex: '9999', textAlign: 'center', display: 'none',
    });
    document.body.appendChild(banner);

    function showBanner(msg, color = '#1a6e1a', ms = 4000) {
      banner.textContent = msg;
      banner.style.background = color;
      banner.style.display = 'block';
      clearTimeout(banner._t);
      banner._t = setTimeout(() => { banner.style.display = 'none'; }, ms);
    }

    // -- PSLIP state watcher ---------------------------------------------------
    // Shows a persistent orange banner while PackApp shows "Scan PSLIP".
    // PSLIP barcodes start with uppercase "S"; SP00 always starts with lowercase
    // "sp" -- case-sensitive check prevents any misdetection between the two.
    let pslipVisible = false;
    setInterval(() => {
      const nowVisible = /scan\s+pslip/i.test(document.body.innerText);
      if (nowVisible && !pslipVisible) {
        pslipVisible = true;
        banner.textContent = '⚠ PSLIP order -- scan slip from printer, then scan SP00  |  Slip not printed? Press (p) -> (a)';
        banner.style.background = '#7b4400';
        banner.style.display = 'block';
        clearTimeout(banner._t);
      } else if (!nowVisible && pslipVisible) {
        pslipVisible = false;
        if (!pslipCode) banner.style.display = 'none';
      }
    }, 600);

    // -- Scanner buffer --------------------------------------------------------
    // Capture phase -- fires before PackApp's own handlers.
    // Only flushes on Enter -- prevents truncation from fast scanner bursts.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const raw = buffer.trim();
        buffer = '';
        if (raw) onScan(raw);
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    }, true);

    function onScan(input) {
      // -- Tote: first scan that is neither SP00 nor PSLIP --
      if (!toteScanned && !/^sp/.test(input) && !/^S[A-Za-z0-9]/.test(input)) {
        toteScanned = true;
        return;
      }

      // -- PSLIP barcode: uppercase S prefix, length >= 8, prompt visible --
      // Captured for completeness; ShipApp confirmed not to need it (tested 2026-06-10).
      if (/^S[A-Za-z0-9]/.test(input) && input.length >= 8 && pslipVisible) {
        pslipCode = input;
        showBanner('✓ PSLIP scanned -- now scan SP00', '#7b4400', 4000);
        return;
      }

      // -- SP00 --
      if (/^sp/.test(input) && input.length >= 8) {
        // Guard: only block if PSLIP prompt is visible AND slip hasn't been scanned.
        // Using pslipCode flag avoids re-reading DOM which may lag during transition.
        if (pslipVisible && !pslipCode) {
          showBanner('⚠ Scan PSLIP first -- then scan SP00 again', '#7b4400', 5000);
          return;
        }

        // Adaptive box detection: poll every 100ms until box type appears in DOM.
        // Box type is usually already rendered before SP00 step, so this fires
        // almost immediately rather than waiting the old fixed 2000ms delay.
        waitFor(() => !!detectBox(), BOX_DETECT_MAX_MS).then(found => {
          const box     = found && detectBox();
          const barcode = box && BOX_MAP[box];
          if (!box || !barcode) {
            showBanner('⚠ Box type not detected', '#b55a00', 6000);
            return;
          }
          GM_setValue(STORAGE_KEY, JSON.stringify({ sp00: input, box, barcode, ts: Date.now() }));
          showBanner(`✓ Sent to ShipApp -- ${input}  [${box} -> ${barcode}]`);
          toteScanned = false;
          pslipCode   = null;
        });
      }
    }

    // Uses pre-compiled BOX_REGEX -- no RegExp construction on each call
    function detectBox() {
      const text = document.body.innerText.toUpperCase();
      for (const key of Object.keys(BOX_MAP)) {
        if (BOX_REGEX[key].test(text)) return key;
      }
      return null;
    }
  }

  // ===========================================================================
  //  SHIPAPP
  // ===========================================================================
  function runShipApp() {
    let busy = false;

    // -- Status overlay --------------------------------------------------------
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

    // -- Poll + immediate visibility trigger -----------------------------------
    setInterval(poll, POLL_MS);
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

      // Discard stale orders (older than 5 minutes)
      if (Date.now() - order.ts > 5 * 60 * 1000) { GM_setValue(STORAGE_KEY, ''); return; }

      if (!document.body.innerText.includes('Scan the SP')) return;

      busy = true;
      GM_setValue(STORAGE_KEY, ''); // clear before processing -- prevents duplicate sends
      await processOrder(order);
      busy = false;
    }

    async function processOrder(order) {
      // -- Step 1: send SP00 ----------------------------------------------------
      status(`▶ Sending SP00: ${order.sp00}…`);
      debug('');
      sendBarcode(order.sp00);

      // -- Step 2: wait for BOX screen ------------------------------------------
      // PSLIP confirmed NOT required in ShipApp (tested 2026-06-10).
      // Flow: Scan SP00 -> Scan BOX -> label prints.
      const boxReady = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('Scan the BOX') || t.includes('scan the box') ||
               t.includes('FAILURE') || t.includes('Invalid');
      }, 10000);

      if (!boxReady) {
        status('⚠ Timed out after SP00');
        debug(`Page: "${document.body.innerText.substring(0, 120).replace(/\n/g, ' ')}"`);
        return;
      }

      if (document.body.innerText.includes('FAILURE') ||
          document.body.innerText.includes('Invalid')) {
        status(`⚠ ShipApp rejected SP00: ${order.sp00}`);
        debug('SP00 may be expired or already used. Re-scan in PackApp.');
        return;
      }

      // -- Step 3: send box barcode ---------------------------------------------
      await sleep(BOX_SEND_DELAY_MS);
      status(`▶ Sending box: ${order.barcode}…`);
      debug(`Box: ${order.box} -> ${order.barcode}`);
      sendBarcode(order.barcode);

      // -- Step 4: wait for result ----------------------------------------------
      const result = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('SUCCESS') || t.includes('success') ||
               t.includes('FAILURE') || t.includes('Invalid');
      }, 10000);

      if (!result) {
        status('⚠ Timed out waiting for result');
        debug(`Page: "${document.body.innerText.substring(0, 120).replace(/\n/g, ' ')}"`);
        return;
      }

      const pageText = document.body.innerText;
      if (pageText.includes('SUCCESS') || pageText.includes('success')) {
        status(`✅ Shipped! ${order.sp00}  [${order.box} -> ${order.barcode}]`);
        debug('Label printed. Ready for next order.');
      } else {
        status('⚠ Box scan failed');
        debug(`Page: "${pageText.substring(0, 120).replace(/\n/g, ' ')}"`);
      }

      await sleep(2000);
      status('⏳ FC Auto v5: waiting for order…');
      debug('');
    }

    // -- Barcode input ---------------------------------------------------------
    // Strategy 1: Angular scope injection (fast-path if ShipApp exposes methods).
    // Strategy 2: synchronous keyboard events to document.body -- confirmed working.
    // Events dispatched without sleep between chars -- avoids background tab throttling.
    function sendBarcode(barcode) {
      if (tryAngular(barcode)) return;
      for (const char of barcode) fireChar(char);
      fireEnter();
    }

    function tryAngular(barcode) {
      try {
        const ng = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).angular;
        if (!ng) return false;
        for (const el of document.querySelectorAll('[ng-controller],[data-ng-controller]')) {
          const scope = ng.element(el).scope();
          if (!scope) continue;
          if (typeof scope.publishBuffer === 'function') {
            scope.$apply(() => { scope.keystrokeBuffer = barcode; scope.publishBuffer(); });
            debug(`Angular: publishBuffer("${barcode}")`);
            return true;
          }
          for (const m of ['submitBarcode', 'handleBarcode', 'processInput', 'submit']) {
            if (typeof scope[m] === 'function') {
              scope.$apply(() => scope[m](barcode));
              debug(`Angular: ${m}("${barcode}")`);
              return true;
            }
          }
        }
      } catch (e) { debug(`Angular: ${e.message}`); }
      return false;
    }

    function makeKE(type, char, code) {
      const e = new KeyboardEvent(type, {
        key: char, charCode: code, keyCode: code, which: code,
        bubbles: true, cancelable: true, composed: true,
      });
      try { Object.defineProperty(e, 'keyCode',  { value: code }); } catch (_) {}
      try { Object.defineProperty(e, 'charCode', { value: code }); } catch (_) {}
      try { Object.defineProperty(e, 'which',    { value: code }); } catch (_) {}
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
  }

})();

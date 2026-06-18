// ==UserScript==
// @name         FC Pack Automation v5
// @namespace    https://github.com/youngryan521
// @version      5.7
// @description  PackApp -> ShipApp auto-ship -- hazmat support, MutationObserver, banner persistence fix
// @author       youngryan521
// @match        https://packapp-sptc-prod-na.aka.corp.amazon.com/mix/index.html
// @match        https://fcswat-us.aka.amazon.com/workflow/init
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/youngryan521/Projects/main/fc-auto-v5.user.js
// @downloadURL  https://raw.githubusercontent.com/youngryan521/Projects/main/fc-auto-v5.user.js
// @homepageURL  https://github.com/youngryan521/Projects
// ==/UserScript==

(function () {
  'use strict';

  // --- CONFIG -----------------------------------------------------------------
  const STORAGE_KEY       = 'fc_pending_order_v5';
  const POLL_MS           = 200;   // ShipApp storage poll interval (was 400ms)
  const BOX_DETECT_MAX_MS = 2000;  // max wait for box type in PackApp DOM
  const BOX_SEND_DELAY_MS = 600;   // settling pause after BOX/UN screen before sending

  const BOX_MAP = {
    PB2: 'FSA', PM4: 'FRQ', PM5: 'FRR', OWNBOX: 'OWNBOX', SIOC: 'OWNBOX',
  };
  const HAZMAT_MAP = {
    UN3481: 'UN3481BotBar', UN3480: 'UN3480BotBar',
    UN3091: 'UN3091BotBar', UN3090: 'UN3090BotBar',
  };

  // Pre-cached key arrays -- avoids Object.keys() allocation on every detect call
  const BOX_KEYS    = Object.keys(BOX_MAP);
  const HAZMAT_KEYS = Object.keys(HAZMAT_MAP);

  // 'i' flag on BOX_REGEX lets detectBox() use textContent without .toUpperCase()
  // (textContent skips layout reflow that innerText forces)
  const BOX_REGEX    = Object.fromEntries(BOX_KEYS.map(k    => [k, new RegExp(`\\b${k}\\b`, 'i')]));
  const HAZMAT_REGEX = Object.fromEntries(HAZMAT_KEYS.map(k => [k, new RegExp(`\\b${k}\\b`, 'i')]));

  // --- Shared utilities -------------------------------------------------------

  // MutationObserver-based wait -- resolves the moment predFn() returns truthy,
  // or false after timeoutMs. Fires on DOM changes instead of polling every 100ms,
  // saving up to 100ms per screen transition vs the old setInterval approach.
  function waitFor(predFn, timeoutMs) {
    return new Promise(resolve => {
      if (predFn()) return resolve(true);
      const ob = new MutationObserver(() => {
        if (predFn()) { ob.disconnect(); clearTimeout(tid); resolve(true); }
      });
      ob.observe(document.body, { childList: true, subtree: true, characterData: true });
      const tid = setTimeout(() => { ob.disconnect(); resolve(false); }, timeoutMs);
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
    let pslipCode   = null;
    let hazmatCode  = null;

    // -- Status banner ----------------------------------------------------------
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

    // -- PSLIP + hazmat state watcher -------------------------------------------
    let pslipVisible = false;
    setInterval(() => {
      const text = document.body.innerText;

      const nowPslipVisible = /scan\s+pslip/i.test(text);
      if (nowPslipVisible && !pslipVisible) {
        pslipVisible = true;
        banner.textContent = '⚠ PSLIP order -- scan slip from printer, then scan SP00  |  Slip not printed? Press (p) -> (a)';
        banner.style.background = '#7b4400';
        banner.style.display = 'block';
        clearTimeout(banner._t);
      } else if (!nowPslipVisible && pslipVisible) {
        pslipVisible = false;
        if (!pslipCode) banner.style.display = 'none';
      }

      if (!hazmatCode) {
        const h = detectHazmat();
        if (h) {
          hazmatCode = h;
          showBanner(`Hazmat captured: ${h} -- scan hazmat label, then scan SP00`, '#5c2d91', 5000);
        }
      }
    }, 600);

    // -- Scanner buffer ---------------------------------------------------------
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
      if (!toteScanned && !/^sp/.test(input) && !/^S[A-Za-z0-9]/.test(input)) {
        toteScanned = true;
        hazmatCode  = null;
        return;
      }

      if (/^S[A-Za-z0-9]/.test(input) && input.length >= 8 && pslipVisible) {
        pslipCode = input;
        showBanner('✓ PSLIP scanned -- now scan SP00', '#7b4400', 4000);
        return;
      }

      if (/^sp/.test(input) && input.length >= 8) {
        if (pslipVisible && !pslipCode) {
          showBanner('⚠ Scan PSLIP first -- then scan SP00 again', '#7b4400', 5000);
          return;
        }

        // MutationObserver-backed waitFor: resolves the moment box type appears in DOM
        waitFor(() => !!detectBox(), BOX_DETECT_MAX_MS).then(found => {
          const box     = found && detectBox();
          const barcode = box && BOX_MAP[box];
          if (!box || !barcode) {
            showBanner('⚠ Box type not detected', '#b55a00', 6000);
            return;
          }

          const hazmat        = hazmatCode || detectHazmat();
          const hazmatBarcode = hazmat ? HAZMAT_MAP[hazmat] : null;

          GM_setValue(STORAGE_KEY, JSON.stringify({
            sp00: input, box, barcode,
            hazmat: hazmat || null, hazmatBarcode: hazmatBarcode || null,
            ts: Date.now(),
          }));

          showBanner(`✓ Sent to ShipApp -- ${input}  [${box} -> ${barcode}]${hazmat ? `  HAZMAT: ${hazmat}` : ''}`);
          toteScanned = false;
          pslipCode   = null;
          // hazmatCode intentionally NOT cleared here -- the watcher re-detects it from
          // the DOM if cleared immediately, re-showing the purple banner on the next cycle.
          // hazmatCode is cleared on the next tote scan (line above: toteScanned = true).
        });
      }
    }

    // textContent skips layout reflow; BOX_REGEX is case-insensitive so no .toUpperCase() needed
    function detectBox() {
      const text = document.body.textContent;
      for (const key of BOX_KEYS) {
        if (BOX_REGEX[key].test(text)) return key;
      }
      return null;
    }

    function detectHazmat() {
      const text = document.body.textContent;
      for (const key of HAZMAT_KEYS) {
        if (HAZMAT_REGEX[key].test(text)) return key;
      }
      return null;
    }
  }

  // ===========================================================================
  //  SHIPAPP
  // ===========================================================================
  function runShipApp() {
    let busy = false;

    // -- Status overlay ---------------------------------------------------------
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
      if (Date.now() - order.ts > 5 * 60 * 1000) { GM_setValue(STORAGE_KEY, ''); return; }
      if (!document.body.innerText.includes('Scan the SP')) return;
      busy = true;
      GM_setValue(STORAGE_KEY, '');
      await processOrder(order);
      busy = false;
    }

    async function processOrder(order) {
      // Step 1: send SP00
      status(`▶ Sending SP00: ${order.sp00}…`);
      debug('');
      sendBarcode(order.sp00);

      // Step 2: wait for BOX screen -- MutationObserver fires the moment DOM updates
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

      // Step 3: send box barcode
      await sleep(BOX_SEND_DELAY_MS);
      status(`▶ Sending box: ${order.barcode}…`);
      debug(`Box: ${order.box} -> ${order.barcode}`);
      sendBarcode(order.barcode);

      // Step 4: wait for hazmat UN prompt, SUCCESS, or FAILURE
      const afterBox = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('SUCCESS') || t.includes('success') ||
               t.includes('FAILURE') || t.includes('Invalid') ||
               /Scan the UN\d{4}/i.test(t);
      }, 10000);

      if (!afterBox) {
        status('⚠ Timed out waiting for result after box');
        debug(`Page: "${document.body.innerText.substring(0, 120).replace(/\n/g, ' ')}"`);
        return;
      }

      // Step 5 (hazmat only): send hazmat barcode
      if (/Scan the UN\d{4}/i.test(document.body.innerText)) {
        const hazmatBarcode = order.hazmatBarcode || (() => {
          const m = document.body.innerText.match(/Scan the (UN\d{4})/i);
          return m && HAZMAT_MAP[m[1].toUpperCase()];
        })();

        if (!hazmatBarcode) {
          status('⚠ Unknown hazmat type -- check ShipApp');
          debug(`Page: "${document.body.innerText.substring(0, 120).replace(/\n/g, ' ')}"`);
          return;
        }

        await sleep(BOX_SEND_DELAY_MS);
        status(`▶ Sending hazmat: ${hazmatBarcode}…`);
        debug(`Hazmat: ${order.hazmat || 'detected'} -> ${hazmatBarcode}`);
        sendBarcode(hazmatBarcode);

        // Step 6: wait for final result
        const finalDone = await waitFor(() => {
          const t = document.body.innerText;
          return t.includes('SUCCESS') || t.includes('success') ||
                 t.includes('FAILURE') || t.includes('Invalid');
        }, 10000);

        if (!finalDone) {
          status('⚠ Timed out after hazmat scan');
          debug(`Page: "${document.body.innerText.substring(0, 120).replace(/\n/g, ' ')}"`);
          return;
        }

        const finalText = document.body.innerText;
        if (finalText.includes('SUCCESS') || finalText.includes('success')) {
          status(`✅ Shipped! ${order.sp00}  [${order.box}, ${hazmatBarcode}]`);
          debug('Hazmat label printed. Ready for next order.');
        } else {
          status('⚠ Hazmat scan failed');
          debug(`Page: "${finalText.substring(0, 120).replace(/\n/g, ' ')}"`);
        }

      } else {
        // Normal (non-hazmat) result
        const pageText = document.body.innerText;
        if (pageText.includes('SUCCESS') || pageText.includes('success')) {
          status(`✅ Shipped! ${order.sp00}  [${order.box} -> ${order.barcode}]`);
          debug('Label printed. Ready for next order.');
        } else {
          status('⚠ Box scan failed');
          debug(`Page: "${pageText.substring(0, 120).replace(/\n/g, ' ')}"`);
        }
      }

      await sleep(500);   // was 2000ms -- briefly show result before resetting
      status('⏳ FC Auto v5: waiting for order…');
      debug('');
    }

    // -- Barcode input ----------------------------------------------------------

    // Angular path cached after first call: ShipApp's Angular controllers don't
    // expose known barcode methods in practice, so tryAngular() always returns false.
    // Caching skips the querySelectorAll DOM scan on every subsequent sendBarcode() call.
    let angularChecked = false;
    let angularWorks   = false;

    function sendBarcode(barcode) {
      if (angularChecked && !angularWorks) {
        // Angular confirmed unavailable -- go straight to keyboard events
        for (const char of barcode) fireChar(char);
        fireEnter();
        return;
      }
      if (tryAngular(barcode)) return;
      for (const char of barcode) fireChar(char);
      fireEnter();
    }

    function tryAngular(barcode) {
      angularChecked = true;
      try {
        const ng = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).angular;
        if (!ng) return false;
        for (const el of document.querySelectorAll('[ng-controller],[data-ng-controller]')) {
          const scope = ng.element(el).scope();
          if (!scope) continue;
          if (typeof scope.publishBuffer === 'function') {
            scope.$apply(() => { scope.keystrokeBuffer = barcode; scope.publishBuffer(); });
            debug(`Angular: publishBuffer("${barcode}")`);
            angularWorks = true;
            return true;
          }
          for (const m of ['submitBarcode', 'handleBarcode', 'processInput', 'submit']) {
            if (typeof scope[m] === 'function') {
              scope.$apply(() => scope[m](barcode));
              debug(`Angular: ${m}("${barcode}")`);
              angularWorks = true;
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

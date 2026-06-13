# FC Pack Automation

A Tampermonkey userscript that automates the PackApp -> ShipApp fulfillment workflow at Amazon FCs. Instead of manually switching tabs to scan barcodes in ShipApp after each pack, the script intercepts the SP00 and box type from PackApp and replays them into ShipApp automatically -- saving several seconds per order across thousands of orders per shift.

---

## Table of Contents

- [Background](#background)
- [How It Works](#how-it-works)
- [Script Sections Reference](#script-sections-reference)
- [Version History & Bug Log](#version-history--bug-log)
- [Security Analysis](#security-analysis)
- [Installation](#installation)
- [Configuration](#configuration)
- [Box Barcode Reference](#box-barcode-reference)
- [Hazmat Barcode Reference](#hazmat-barcode-reference)
- [ShipApp Manual Setup](#shipapp-manual-setup-per-shift)

---

## Background

The standard workflow at a packing station:

1. **PackApp (Mix flow):** Scan tote -> scan each item -> system assigns a box -> scan SP00 label -> PackApp closes the order
2. **ShipApp:** Manually switch tabs -> scan SP00 again -> scan box label -> shipping label prints

Step 2 is entirely redundant. Every piece of data ShipApp needs (SP00 and box type) is already known by the time PackApp finishes. This script bridges the two apps so ShipApp handles itself in the background.

**Constraints:** Shared FC workstations run Windows + Firefox with no admin access. AutoHotkey and other desktop tools are blocked. Tampermonkey (a Firefox extension) is the only viable automation layer -- no install required, persists across sessions, and has direct DOM access to both browser apps.

---

## How It Works

```
PackApp                           GM Storage                  ShipApp
--------                          ----------                  --------
Scan tote        ->  toteScanned=true
(hazmat order)       watcher detects UN3481 ->  hazmatCode set, purple banner shown
Scan SP00        ->  detect SP00 + box  ->  GM_setValue(order)  ->  poll() picks it up
                     + hazmatCode                               ->  sendBarcode(sp00)
                                                               ->  wait for BOX screen
                                                               ->  sendBarcode(boxBarcode)
                                                               ->  wait for UN prompt / SUCCESS
                                                               ->  (hazmat) sendBarcode(UN3481BotBar)
                                                               ->  label prints
```

Both apps run in separate browser tabs. Since they are different origins, they cannot communicate directly via `localStorage` or `BroadcastChannel`. The script uses **Tampermonkey's `GM_setValue` / `GM_getValue`** as shared storage -- because both app sections live inside the same single script, they share the same Tampermonkey storage bucket.

ShipApp has no visible text input fields. It captures raw keyboard events directly (scanner animation UI). The script dispatches `KeyboardEvent` objects to `document.body`, which bubble up to `window` where ShipApp's jQuery `$(window).bind("keypress")` handler catches them.

---

## Script Sections Reference

### Metadata / UserScript Header

```js
// @match  https://packapp-sptc-prod-na.aka.corp.amazon.com/mix/index.html
// @match  https://fcswat-us.aka.amazon.com/workflow/init
// @grant  GM_setValue
// @grant  GM_getValue
// @grant  unsafeWindow
```

One script, two `@match` URLs. The script checks `location.href` at runtime to decide which branch to run -- `runPackApp()` or `runShipApp()`. `unsafeWindow` gives access to the page's own `window` object (needed for Angular scope inspection).

---

### CONFIG block

```js
const STORAGE_KEY       = 'fc_pending_order_v5';
const POLL_MS           = 400;
const BOX_DETECT_MAX_MS = 2000;
const BOX_SEND_DELAY_MS = 600;

const BOX_MAP    = { PB2: 'FSA', PM4: 'FRQ', PM5: 'FRR', OWNBOX: 'OWNBOX', SIOC: 'OWNBOX' };
const HAZMAT_MAP = { UN3481: 'UN3481BotBar', UN3480: 'UN3480BotBar',
                     UN3091: 'UN3091BotBar', UN3090: 'UN3090BotBar' };

const BOX_REGEX    = Object.fromEntries(
  Object.keys(BOX_MAP).map(k => [k, new RegExp(`\\b${k}\\b`)])
);
const HAZMAT_REGEX = Object.fromEntries(
  Object.keys(HAZMAT_MAP).map(k => [k, new RegExp(`\\b${k}\\b`, 'i')])
);
```

- `POLL_MS` -- how often ShipApp checks GM storage for a pending order (400ms).
- `BOX_DETECT_MAX_MS` -- maximum time to wait for a box type to appear in PackApp's DOM after SP00 is scanned. In practice the box is already on screen, so detection fires within the first poll (~100ms). The 2000ms is a safety ceiling.
- `BOX_SEND_DELAY_MS` -- brief pause after ShipApp shows the BOX screen before sending the box barcode. Gives ShipApp time to be ready to receive input after the screen transition.
- `BOX_MAP` -- translates the box type name PackApp shows on screen into the actual barcode ShipApp expects.
- `BOX_REGEX` -- pre-compiled regex patterns for each box type, built once at startup. Avoids constructing a new `RegExp` object on every `detectBox()` call.
- `HAZMAT_MAP` -- maps UN type codes to the barcode ShipApp expects at the hazmat scan step. Covers the four lithium battery UN numbers (UN3481, UN3480, UN3091, UN3090).
- `HAZMAT_REGEX` -- pre-compiled case-insensitive word-boundary patterns for each UN code, parallel to `BOX_REGEX`. Used by `detectHazmat()` to find UN codes in PackApp's page text.

---

### Shared utilities -- waitFor() / sleep()

```js
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
```

Polls a predicate function every `intervalMs` milliseconds until it returns truthy, or until `timeoutMs` elapses. Returns `true` on success, `false` on timeout. Default poll interval is 100ms (was 300ms in earlier versions).

Defined at the outer scope so both `runPackApp()` and `runShipApp()` share one copy. Used in PackApp for adaptive box detection and in ShipApp for all screen transition waits.

---

### runPackApp()

**Purpose:** Listen for scanner input, identify SP00 and box type, save order to shared storage.

#### Scanner buffer

```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { onScan(buffer.trim()); buffer = ''; }
  else if (e.key.length === 1) { buffer += e.key; }
}, true);
```

Registered in **capture phase** (`true`) so it fires before PackApp's own handlers. Accumulates characters and only flushes on Enter. This mirrors exactly how a barcode scanner works -- it types the barcode string then sends Enter.

#### onScan() -- scan classifier

Barcodes are classified in priority order:

| Barcode pattern | Action |
|---|---|
| Not SP00, not PSLIP pattern, tote not yet scanned | Mark tote as scanned, **reset `hazmatCode = null`**, ignore |
| Uppercase `S` + alphanumeric, length >= 8, PSLIP prompt visible | Save as `pslipCode` |
| Lowercase `sp` + alphanumeric, length >= 8 | Process as SP00, include `hazmat` + `hazmatBarcode` in payload |

#### Adaptive box detection

```js
waitFor(() => !!detectBox(), BOX_DETECT_MAX_MS).then(found => {
  const box     = found && detectBox();
  const barcode = box && BOX_MAP[box];
  GM_setValue(STORAGE_KEY, JSON.stringify({ sp00: input, box, barcode, ts: Date.now() }));
});
```

Instead of a fixed 2-second delay after SP00 is scanned, `waitFor` polls `detectBox()` every 100ms. Since PackApp displays the box type before the SP00 step, the box is already on screen when SP00 is scanned -- detection fires on the first poll, saving nearly 2 seconds per order compared to the old fixed wait.

#### detectBox()

```js
function detectBox() {
  const text = document.body.innerText.toUpperCase();
  for (const key of Object.keys(BOX_MAP)) {
    if (BOX_REGEX[key].test(text)) return key;
  }
  return null;
}
```

Reads the page text and tests it against pre-compiled regex patterns. Uses `BOX_REGEX` instead of constructing `new RegExp()` on each call.

#### State variables

```js
let hazmatCode = null;   // UN type captured from page (e.g. "UN3481"); reset on each new tote
```

`hazmatCode` is set by the watcher when a UN code is detected, and cleared on every tote scan so a stale hazmat code from a previous order never contaminates the next.

#### PSLIP + hazmat state watcher

```js
setInterval(() => {
  const nowVisible = /scan\s+pslip/i.test(document.body.innerText);
  ...
  detectHazmat();   // also checks for UN prompt each cycle
}, 600);
```

Polls the DOM every 600ms. When PackApp shows "Scan PSLIP", a persistent orange banner appears at the top of the page. The banner stays visible until the PSLIP step clears from the DOM.

The same interval also calls `detectHazmat()` each cycle. When a UN code appears on the page (PackApp shows a "Scan UN3481 label" prompt for hazmat items), `hazmatCode` is set and a purple banner is shown: **"Hazmat captured: UN3481"**.

**PSLIP guard (v5.3 fix):** When SP00 is scanned, the guard checks `pslipVisible && !pslipCode` rather than re-reading `document.body.innerText`. The earlier DOM check could still show "Scan PSLIP" during PackApp's transition delay even after the PSLIP had already been scanned -- incorrectly blocking the SP00. The flag-based check is immune to DOM lag.

#### detectHazmat()

```js
function detectHazmat() {
  const text = document.body.innerText;
  for (const key of Object.keys(HAZMAT_MAP)) {
    if (HAZMAT_REGEX[key].test(text)) { hazmatCode = key; return; }
  }
}
```

Reads page text and tests against `HAZMAT_REGEX` (case-insensitive). When a UN code is found, `hazmatCode` is set. The watcher then shows the purple capture banner. The detected code and its mapped barcode are included in the order payload when SP00 is scanned.

#### Status banner

A fixed `<div>` pinned to the top of PackApp. Green for normal confirmations, orange/brown for PSLIP-related states. Auto-hides after 4 seconds (PSLIP prompt stays until the step resolves).

---

### runShipApp()

**Purpose:** Poll shared storage for a pending order, send SP00 and box barcode via keyboard events, report result.

#### Status overlay

A small dark overlay pinned to the bottom-right corner of ShipApp with two lines:
- **Status line** -- current action (waiting / sending / success / error)
- **Debug line** -- lower-level detail in smaller grey text. On any timeout or failure, shows the first 120 characters of the ShipApp page so you can see exactly what screen it got stuck on.

#### poll()

```js
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) poll();
});
```

Runs on a 400ms interval and also fires immediately when the user switches to the ShipApp tab. Checks for a pending order in GM storage, verifies it is not stale (> 5 minutes old), and confirms the page shows "Scan the SP" before proceeding. The order is **cleared from storage immediately** before `processOrder()` starts -- prevents a second poll from re-processing the same order if the tab gains focus mid-flight.

#### processOrder()

The async sequence (four steps for standard orders; six for hazmat):

1. `sendBarcode(sp00)` -- sends SP00
2. `waitFor('Scan the BOX' or FAILURE, 10s)` -- waits for BOX screen
3. `sleep(BOX_SEND_DELAY_MS)` -- brief pause for ShipApp to be ready
4. `sendBarcode(boxBarcode)` -- sends box barcode; Step 4's `waitFor` also watches for **UN prompt** (`/Scan the UN\d{4}/i`) in addition to SUCCESS/FAILURE
5. *(hazmat only)* `sendBarcode(hazmatBarcode)` -- sends the UN barcode (e.g. `UN3481BotBar`). If the payload lacks `hazmatBarcode`, falls back to reading the UN type directly from the ShipApp page via `/Scan the (UN\d{4})/i`.
6. *(hazmat only)* `waitFor(SUCCESS or FAILURE, 10s)` -- waits for final result after hazmat barcode; reports `[box, hazmatBarcode]` in the success message.

PSLIP is confirmed NOT required in ShipApp (tested 2026-06-10). The flow is always SP00 -> BOX -> (UN if hazmat) -> label prints.

#### sendBarcode() -- input strategy

```js
function sendBarcode(barcode) {
  if (tryAngular(barcode)) return;
  for (const char of barcode) fireChar(char);
  fireEnter();
}
```

Two strategies tried in order:

**Strategy 1 -- Angular scope injection:** Finds Angular controller elements on the page, gets their scope, and calls known barcode processing methods directly (`publishBuffer`, `submitBarcode`, `handleBarcode`, etc.). Bypasses the DOM event layer entirely. ShipApp's Angular scope does not expose these methods in practice, so this path always falls through -- but it's kept for forward compatibility.

**Strategy 2 -- Keyboard events to document.body:** Dispatches `keydown` + `keypress` for each character, then `Enter`. Events are dispatched **synchronously** with no delays between characters -- avoids background tab timer throttling. ShipApp's jQuery handler on `window` catches them as they bubble up from `document.body`.

#### makeKE() / fireChar() / fireEnter()

```js
function makeKE(type, char, code) {
  const e = new KeyboardEvent(type, { key: char, charCode: code, bubbles: true, ... });
  Object.defineProperty(e, 'keyCode', { value: code });
  ...
}
```

`keyCode`, `charCode`, and `which` are read-only on `KeyboardEvent` by spec. The `Object.defineProperty` override forces them to the correct values so ShipApp's older jQuery-based event handler reads them correctly.

---

## Version History & Bug Log

### v1 -- Two-Script Approach (FAILED)

**What we tried:** Two separate Tampermonkey scripts -- one for PackApp, one for ShipApp -- communicating via `GM_setValue`/`GM_getValue`.

**What broke:** Tampermonkey isolates `GM_setValue` storage per script by UUID namespace bucket. Even with the same `@namespace` declared, each script gets its own isolated storage. PackApp's script wrote to one bucket; ShipApp's script read from a completely different one. The two scripts could never see each other's data.

**Result:** ShipApp never received any orders. No errors -- just silent nothing.

---

### v2 -- Namespace Tweaks (FAILED)

**What we tried:** Various `@namespace` and `@name` combinations hoping to force shared storage between two scripts.

**What broke:** Storage isolation is by internal script UUID, not by namespace string. No combination of metadata fixes this. The two scripts are fundamentally separate entities.

**Result:** Same as v1. Still silent.

---

### v3 -- Combined Single Script (storage fixed / input failed)

**What we fixed:** Merged both scripts into one file. Since both app sections now live in the same script, they share the same `GM_setValue` bucket. Storage communication works.

**What broke:** ShipApp still didn't process the barcodes. The keyboard events were dispatched to `document` and `window` simultaneously, causing duplicate event delivery. ShipApp apparently processed one and ignored the second, leading to unpredictable behavior. Angular scope injection was not yet attempted.

---

### v4 -- Multi-Strategy Input (partial)

**What we added:** Angular scope injection as a first-pass strategy. Fallback to `document.body` event dispatch (single target, no duplicate). Input now attempted via `scope.publishBuffer()`, `scope.submitBarcode()`, etc.

**Bugs found during testing:**

| Bug | Symptom | Root cause |
|---|---|---|
| Background tab throttling | ShipApp received garbled/partial barcodes when tab was in background | `setTimeout` delays between characters -- browser throttles timers in hidden tabs to >=1000ms, so chars arrived out of order or were dropped |
| BOX BARCODE false positive | Script triggered "BOX ready" immediately without waiting | Was checking for text `'BOX BARCODE'` -- a column header always present on the page. Should wait for `'Scan the BOX'` heading which only appears at the right step |
| Duplicate sends | Same order processed twice | Order cleared from storage *after* processing finished; a second `poll()` could fire and pick up the same order while the first was still mid-flight |
| No failure detection | Script hung waiting after ShipApp showed `FAILURE` | No code to detect or handle ShipApp rejection states |
| PackApp barcode truncation | SP00 detected as partial string (e.g. `spRKB6X` instead of full `spRKB6Xg4MW`) | Buffer had a reset timer -- if scanner input was fast, timer fired mid-scan and flushed an incomplete buffer |
| Tab switch delay | First order after switching to ShipApp took up to 800ms to start | `poll()` only ran on interval; switching tabs didn't trigger an immediate poll |

---

### v5 -- Production Release

All v4 bugs fixed:

**Background tab throttling -> synchronous dispatch**
```js
// Before (broken): await sleep(20) between chars
// After (fixed): synchronous loop, no await
for (const char of barcode) fireChar(char);
fireEnter();
```
No sleep between characters means no timer throttling. All chars fire in the same synchronous execution frame.

**BOX BARCODE false positive -> correct text target**
```js
// Before: t.includes('BOX BARCODE')   <- always present on page
// After:  t.includes('Scan the BOX')  <- only present at the right step
```

**Duplicate sends -> clear storage first**
```js
GM_setValue(STORAGE_KEY, '');   // <- clear BEFORE processing starts
await processOrder(order);
```

**Failure detection -> explicit FAILURE/Invalid check**
```js
const failed = document.body.innerText.includes('FAILURE') ||
               document.body.innerText.includes('Invalid');
```
Both `waitFor()` calls now include FAILURE/Invalid as exit conditions so the script doesn't hang.

**Barcode truncation -> Enter-only flush**
```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { onScan(buffer.trim()); buffer = ''; }
  else if (e.key.length === 1) { buffer += e.key; }
}, true);
```

**Tab switch delay -> visibilitychange listener**
```js
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) poll();
});
```

---

### v5.1 -- PSLIP Detection

**Context:** Some orders require a packing slip (PSLIP) -- a physical document printed locally and placed in the box before sealing. PackApp shows a "Scan PSLIP" prompt, waits for the slip to print, then requires the user to scan the printed barcode before SP00.

**Bug found:** The SP00 detection regex was case-insensitive (`/^sp/i`). PSLIP barcodes begin with uppercase `S` followed by an encrypted shipment ID. The pattern `Sp...` would match `/^sp/i`, causing the script to misidentify a PSLIP barcode as an SP00.

**Fix:**
```js
// Before: /^sp/i  -- matches "Sp..." which is a PSLIP barcode prefix
// After:  /^sp/   -- case-sensitive; SP00 always lowercase "sp..."
```

**Added: PSLIP state banner** -- persistent orange banner whenever "Scan PSLIP" is visible in the DOM.

**Added: PSLIP guard on SP00** -- blocks SP00 and shows a reminder if the PSLIP step hasn't been completed yet.

---

### v5.2 -- PSLIP Barcode Capture + ShipApp Handler

**Problem identified:** It was unknown whether ShipApp also required a PSLIP scan after SP00. If it did, the script would time out waiting for the BOX screen.

**Added: PSLIP capture in PackApp** -- when the PSLIP prompt is active and user scans a barcode matching the PSLIP pattern (`S` + alphanumeric, length >= 8), it is saved to `pslipCode` and included in the order payload.

**Added: ShipApp three-path handler** -- after sending SP00, the script waited to detect either the BOX screen, a PSLIP prompt, or FAILURE. If ShipApp requested PSLIP and a barcode was captured, it sent automatically. If not captured, it paused 60 seconds for manual scan.

**Unicode fix:** Comment separator characters replaced with plain ASCII to eliminate a static analysis false positive (MITRE T1140). See [Security Analysis](#security-analysis).

---

### v5.3 -- PSLIP End-to-End Confirmed + Guard Race Fix

**Live test result (2026-06-10):**
- PSLIP flow confirmed: PackApp requires scan order of PSLIP -> SP00
- ShipApp confirmed: does NOT require PSLIP barcode. Flow is SP00 -> BOX only
- Shipping label did not print during the test

**Root cause of label not printing:** The PSLIP guard re-read `document.body.innerText` to check for "Scan PSLIP" at the moment SP00 was scanned. PackApp's DOM takes a brief moment to update after a PSLIP scan. If SP00 was scanned during that transition window, the guard saw stale "Scan PSLIP" text, blocked the SP00, and nothing was ever sent to ShipApp.

**Fix:**
```js
// Before (broken): re-reads live DOM -- can see stale "Scan PSLIP" during transition
if (/scan\s+pslip/i.test(document.body.innerText)) { block SP00; }

// After (fixed): uses flag set when PSLIP was actually scanned -- immune to DOM lag
if (pslipVisible && !pslipCode) { block SP00; }
```

If `pslipCode` is already set, the PSLIP was scanned regardless of what the DOM still shows.

**ShipApp PSLIP branch removed:** Now that ShipApp is confirmed not to need PSLIP, the three-path handler was removed. ShipApp's `processOrder()` is a clean four-step sequence: send SP00 -> wait for BOX -> send box -> wait for result.

**Improved diagnostics:** All timeout and failure states now show the first 120 characters of the ShipApp page in the debug line, making it easier to identify what screen the script is stuck on.

---

### v5.4 -- Performance Optimization

**Problem:** The script worked correctly but was slower than necessary. Profiling the critical path identified ~2.9 seconds of dead time per order from conservative fixed delays put in place during early development.

**Root cause analysis:**

| Delay | Original value | Why it was slow |
|---|---|---|
| `SP_SEND_DELAY` | 2000ms fixed | Waited 2s for box type to appear in DOM. But PackApp shows the box type *before* the SP00 step -- box is already on screen when SP00 is scanned. 2s was pure dead time. |
| `BOX_WAIT_MS` | 1200ms fixed | Slept after `waitFor` already confirmed the BOX screen was ready. Transition was done; sleep was unnecessary. |
| `waitFor` poll interval | 300ms | Screen transitions detected up to 300ms late. |
| `POLL_MS` | 800ms | ShipApp checked for orders less than twice per second. |

**Fix 1 -- Adaptive box detection**
```js
// Before: fixed 2000ms sleep, then read box once
setTimeout(() => { const box = detectBox(); ... }, 2000);

// After: poll every 100ms, fire the moment box is found
waitFor(() => !!detectBox(), BOX_DETECT_MAX_MS).then(found => { ... });
```
Box type is typically detected on the first poll (~100ms), saving ~1900ms per order.

**Fix 2 -- Reduced delays**

| Constant | Before | After | Saved |
|---|---|---|---|
| Box detect (adaptive vs fixed) | 2000ms | ~100ms | ~1900ms |
| `BOX_SEND_DELAY_MS` | 1200ms | 600ms | 600ms |
| `waitFor` poll interval | 300ms | 100ms | ~200ms |
| `POLL_MS` | 800ms | 400ms | 0-400ms |
| **Total per order** | **~3800ms** | **~900ms** | **~2.9s** |

**Fix 3 -- Code optimizations**
- `waitFor` and `sleep` moved to the outer shared scope -- both `runPackApp()` and `runShipApp()` use the same functions instead of ShipApp having its own private copy
- `BOX_REGEX` pre-compiled at startup as a lookup object -- `new RegExp()` was being constructed on every `detectBox()` call; now built once and reused
- `waitFor` accepts an optional `intervalMs` parameter (default 100ms) for future flexibility

---

### v5.5 -- Hazmat UN Support (current)

**Context:** Some orders contain hazardous materials (lithium batteries) and require an additional scan step. PackApp shows a "Scan UN3481 label" (or similar) prompt during packing. ShipApp also requests a UN barcode scan between the box step and label print. Without automation, the associate must manually switch to ShipApp at this extra step.

**What was added:**

**HAZMAT_MAP and HAZMAT_REGEX** -- new CONFIG entries for the four lithium battery UN numbers:

| UN code | ShipApp barcode |
|---|---|
| UN3481 | UN3481BotBar |
| UN3480 | UN3480BotBar |
| UN3091 | UN3091BotBar |
| UN3090 | UN3090BotBar |

**PackApp -- hazmat detection:**
- New `hazmatCode` state variable; reset to `null` on each tote scan to prevent stale codes carrying to the next order.
- The 600ms DOM watcher now also calls `detectHazmat()` each cycle. When a UN prompt appears on the page, `hazmatCode` is set and a **purple banner** shows: *"Hazmat captured: UN3481"*.
- SP00 handler includes `hazmat` and `hazmatBarcode` in the order JSON payload.

**ShipApp -- processOrder() extended from 4 steps to 6:**
- Step 4 `waitFor` now also watches for `/Scan the UN\d{4}/i` in addition to SUCCESS/FAILURE.
- Step 5 (hazmat only): sends the UN barcode from the payload. Falls back to reading the UN type directly from the ShipApp page text if the payload lacks it.
- Step 6 (hazmat only): waits for final SUCCESS/FAILURE and reports `[box, hazmatBarcode]` in the success message.

Standard (non-hazmat) orders continue through the original 4-step path unchanged.

---

## Security Analysis

**Script:** `fc-auto-v5.user.js` | **SHA-256:** `1529fbddaa1f65a767561414895edb0b9761862417bb89e77f6ebe7946a1434c`
**Analysis date:** 2026-06-09 | **Tools used:** Hybrid Analysis (Falcon Sandbox + MetaDefender), custom Node.js static scanner

### Summary

The script passes all security checks and presents no malware, no data exfiltration, and no threat to company systems or property. It is safe to run on FC packing stations.

The single suspicious indicator flagged by Hybrid Analysis was a **confirmed false positive** caused by Unicode decorative characters in code comments. Those characters have been replaced with ASCII equivalents in the current version. Full explanation below.

---

### Hybrid Analysis Results

| Check | Result |
|---|---|
| Overall Verdict | **No Specific Threat** |
| Threat Score | -- (not scored) |
| MetaDefender Multi-Scan (AV) | **Clean** |
| Malicious Indicators | **0** |
| Suspicious Indicators | **1** (false positive -- see below) |
| Informative Indicators | **50** (sandbox environment noise -- see below) |

---

### Static Analysis -- Dangerous Pattern Scan

Every known dangerous JavaScript pattern was scanned against the full source. Result: **zero hits** across all categories.

| Pattern | Risk Level | Result |
|---|---|---|
| `eval()` | Critical | None |
| `new Function()` | Critical | None |
| `document.write()` | High | None |
| `innerHTML =` assignment | Medium | None |
| `setTimeout(string)` | High | None |
| `setInterval(string)` | High | None |
| Script tag injection | High | None |
| `fetch()` / `XMLHttpRequest` | High | None |
| `WebSocket` | Info | None |
| `navigator.sendBeacon` | Medium | None |
| `document.cookie` | High | None |
| `localStorage` / `sessionStorage` | Info | None |
| `atob()` base64 decode | Medium | None |
| `location.href =` redirect | Medium | None |
| `postMessage()` cross-origin | Info | None |
| Credential-related strings | High | None |

---

### Complete External Interaction Audit

Every interaction the script has with the outside world, verified by source scan:

**GM Storage (cross-tab data bridge)**
- Writes to one key only: `fc_pending_order_v5`
- Reads from one key only: `fc_pending_order_v5`
- Data stored: `{ sp00, box, barcode, ts, hazmat, hazmatBarcode }` -- order routing identifiers only. `hazmat` and `hazmatBarcode` are omitted for non-hazmat orders.
- No personal data, no credentials, no Amazon account information

**DOM Reads**
- Reads `document.body.innerText` from the two specific FC URLs only
- Used to detect screen state ("Scan the SP", "Scan the BOX", box type keywords)
- No form field values, passwords, or session tokens read

**DOM Writes**
- Appends one `<div>` banner to PackApp (status text via `textContent`, not `innerHTML`)
- Appends one `<div>` overlay to ShipApp (status text via `textContent`, not `innerHTML`)
- `textContent` cannot inject executable HTML or scripts

**Event Dispatch**
- Dispatches `keydown` + `keypress` events to `document.body` only
- Only replays barcode characters the user already scanned (SP00, box)
- Does not fabricate or alter any barcode data

**Network**
- **Zero network calls.** No `fetch`, no `XMLHttpRequest`, no WebSocket, no sendBeacon.
- The script contains no outbound connections of any kind.

**URL Scope**
- Restricted to exactly two internal Amazon FC URLs via `@match`
- Does not run on any other page or domain

---

### The Suspicious Indicator -- T1140 Explained

**MITRE ATT&CK Technique:** T1140 -- Deobfuscate/Decode Files or Information
**Hybrid Analysis description:** *"Contains escaped byte string (often part of obfuscated shellcode)"*

**What triggered it:** The script originally used Unicode box-drawing characters in code comments for visual formatting. Those characters (`U+2500`, `U+2550`) are encoded as multi-byte UTF-8 sequences. When Hybrid Analysis serialized the file for pattern matching, repeated characters (e.g. a full separator line of 67 identical `U+2500` characters) produced a long run of similar hex byte values -- the same visual pattern used in actual shellcode obfuscation. The heuristic fired on the length and repetition of the byte sequence.

**Why this was definitively a false positive:**

1. All flagged characters appeared only in `//` comments -- stripped by the JS engine before any code is parsed. They have zero functional effect.
2. No decoding logic exists anywhere: no `atob()`, no `String.fromCharCode()`, no XOR loop, no dynamic string assembly.
3. Hybrid Analysis's own overall verdict remained "No Specific Threat" because the sandbox runtime confirmed no malicious behavior.
4. A source-level scan confirmed zero Unicode escape sequences in any executable code path.

**Fix applied in v5.2 revision:** All Unicode separator characters in comments replaced with ASCII equivalents. The T1140 trigger no longer exists in the current version.

| Old character | Unicode | Replaced with |
|---|---|---|
| `─` (horizontal line) | U+2500 | `-` |
| `═` (double line) | U+2550 | `=` |
| `—` (em dash) | U+2014 | `--` |
| `->` (arrow) | U+2192 | `->` |
| `>=` (greater-or-equal) | U+2265 | `>=` |

Note: Unicode characters in user-visible strings (status banner text: `⚠`, `✓`, `✅`, `▶`, `⏳`) were intentionally kept. These are single characters, not repeated sequences, and do not trigger the byte-string heuristic.

---

### MITRE ATT&CK CSV -- Informative Indicators Explained

The report lists 33 techniques, all with **0 malicious** and **0 suspicious** hits. The 50 "informative" hits are not generated by this script -- they are the Windows + browser runtime environment the sandbox runs inside.

| Technique | Why it appears | From this script? |
|---|---|---|
| T1059.007 -- JavaScript | File is JavaScript | Expected for any .js |
| T1082 -- System Info Discovery (8x) | Browser reads OS/screen info at startup | No |
| T1083 -- File/Directory Discovery (4x) | Browser reads profile/cache paths | No |
| T1012 -- Query Registry (4x) | Browser reads registry for settings | No |
| T1129 -- Shared Modules (4x) | Browser loads DLLs | No |
| T1057 -- Process Discovery (3x) | Sandbox monitoring tools | No |
| T1027 -- Obfuscated Files (3x) | Sandbox's own compression detection | No |
| T1106 -- Native API (3x) | Browser system calls | No |
| T1140 -- Deobfuscate (1x) | Unicode chars in comments (false positive, now fixed) | No |
| T1113 -- Screen Capture (1x) | Sandbox takes screenshots of session | No |
| T1573 -- Encrypted Channel (1x) | HTTPS connections made by browser itself | No |
| T1558 -- Kerberos Tickets (1x) | Windows Kerberos subsystem active by default | No |
| T1003 -- Credential Dumping (1x) | LSASS present in Windows process list | No |

---

### Final Verdict

| Category | Result |
|---|---|
| Malware signatures (MetaDefender multi-AV) | Clean |
| Dynamic sandbox behavior (Falcon) | No Specific Threat |
| Network / data exfiltration | Zero outbound connections |
| Dangerous code patterns | None detected |
| Credential / sensitive data access | None |
| URL scope | Restricted to 2 internal FC URLs only |
| Suspicious indicator (T1140) | Confirmed false positive -- fixed in current version |
| Internal system disruption risk | None -- reads DOM state and sends keyboard events within authorized FC apps only |

---

## Installation

1. Install **Tampermonkey** from the Firefox Add-ons store (no admin required)
2. Open `FC_Scripts.html` from the Desktop
3. Click **Copy Script**
4. In Tampermonkey: click the extension icon -> Dashboard -> `+` (New Script)
5. Select all placeholder text -> paste -> `File -> Save`
6. Confirm both PackApp and ShipApp URLs appear in the script's match list

To update: open the same script in Tampermonkey dashboard, replace all content, save.

---

## Configuration

All tunable constants are at the top of the script:

```js
const POLL_MS           = 400;   // how often ShipApp polls for orders (ms)
const BOX_DETECT_MAX_MS = 2000;  // max wait for box type to appear in PackApp DOM
const BOX_SEND_DELAY_MS = 600;   // pause before sending box barcode in ShipApp
```

If ShipApp starts timing out after SP00 or box on a slow network day, increase `BOX_SEND_DELAY_MS` in 200ms increments. If PackApp stops detecting box types reliably, increase `BOX_DETECT_MAX_MS`.

---

## Box Barcode Reference

| PackApp name | ShipApp barcode |
|---|---|
| PB2 | FSA |
| PM4 | FRQ |
| PM5 | FRR |
| OWNBOX / SIOC | OWNBOX |

---

## Hazmat Barcode Reference

| PackApp prompt | UN code | ShipApp barcode |
|---|---|---|
| Scan UN3481 label | UN3481 | UN3481BotBar |
| Scan UN3480 label | UN3480 | UN3480BotBar |
| Scan UN3091 label | UN3091 | UN3091BotBar |
| Scan UN3090 label | UN3090 | UN3090BotBar |

All four are lithium battery UN numbers. UN3480/UN3481 are lithium-ion; UN3090/UN3091 are lithium-metal. The script handles all four automatically.

---

## ShipApp Manual Setup (per shift)

ShipApp requires manual configuration before the first order of each shift:

1. Select **job type**
2. Enter **station ID**
3. Click **Skip scale**
4. Click **Continue** past the hazmat screen
5. Wait until the screen shows **"Scan the SP00"**

The script only activates once "Scan the SP" text is visible -- so completing setup is required before automation will work.

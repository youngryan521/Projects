# FC Pack Automation

A Tampermonkey userscript that automates the PackApp → ShipApp fulfillment workflow at Amazon FCs. Instead of manually switching tabs to scan barcodes in ShipApp after each pack, the script intercepts the SP00 and box type from PackApp and replays them into ShipApp automatically — saving several seconds per order across thousands of orders per shift.

---

## Table of Contents

- [Background](#background)
- [How It Works](#how-it-works)
- [Script Sections Reference](#script-sections-reference)
- [Version History & Bug Log](#version-history--bug-log)
- [Known Issue: PSLIP Printing](#known-issue-pslip-printing)
- [Installation](#installation)
- [Configuration](#configuration)
- [Box Barcode Reference](#box-barcode-reference)
- [ShipApp Manual Setup](#shipapp-manual-setup-per-shift)

---

## Background

The standard workflow at a packing station:

1. **PackApp (Mix flow):** Scan tote → scan each item → system assigns a box → scan SP00 label → PackApp closes the order
2. **ShipApp:** Manually switch tabs → scan SP00 again → scan box label → shipping label prints

Step 2 is entirely redundant. Every piece of data ShipApp needs (SP00 and box type) is already known by the time PackApp finishes. This script bridges the two apps so ShipApp handles itself in the background.

**Constraints:** Shared FC workstations run Windows + Firefox with no admin access. AutoHotkey and other desktop tools are blocked. Tampermonkey (a Firefox extension) is the only viable automation layer — no install required, persists across sessions, and has direct DOM access to both browser apps.

---

## How It Works

```
PackApp                           GM Storage                  ShipApp
────────                          ──────────                  ────────
Scan tote        →  toteScanned=true
Scan SP00        →  detect SP00 + box  →  GM_setValue(order)  →  poll() picks it up
                                                               →  sendBarcode(sp00)
                                                               →  wait for BOX screen
                                                               →  sendBarcode(boxBarcode)
                                                               →  label prints ✅
```

Both apps run in separate browser tabs. Since they are different origins, they cannot communicate directly via `localStorage` or `BroadcastChannel`. The script uses **Tampermonkey's `GM_setValue` / `GM_getValue`** as shared storage — because both app sections live inside the same single script, they share the same Tampermonkey storage bucket.

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

One script, two `@match` URLs. The script checks `location.href` at runtime to decide which branch to run — `runPackApp()` or `runShipApp()`. `unsafeWindow` gives access to the page's own `window` object (needed for Angular scope inspection).

---

### CONFIG block

```js
const STORAGE_KEY   = 'fc_pending_order_v5';
const POLL_MS       = 800;
const SP_SEND_DELAY = 2000;
const BOX_WAIT_MS   = 1200;
const BOX_MAP = { PB2: 'FSA', PM4: 'FRQ', PM5: 'FRR', OWNBOX: 'OWNBOX', SIOC: 'OWNBOX' };
```

- `SP_SEND_DELAY` — time (ms) between SP00 scan in PackApp and saving the order. Gives PackApp time to render the box type on screen before `detectBox()` reads it.
- `BOX_WAIT_MS` — time (ms) after SP00 is accepted in ShipApp before sending the box barcode. Gives ShipApp time to transition to the BOX screen.
- `BOX_MAP` — translates the box type name PackApp shows on screen into the actual barcode ShipApp expects.

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

Registered in **capture phase** (`true`) so it fires before PackApp's own handlers. Accumulates characters and only flushes on Enter. This mirrors exactly how a barcode scanner works (types the barcode then sends Enter).

#### onScan() — scan classifier

Barcodes are classified in priority order:

| Barcode pattern | Action |
|---|---|
| Not SP00, not PSLIP, tote not yet scanned | Mark tote as scanned, ignore |
| Uppercase `S` + alphanumeric, length ≥ 8, PSLIP prompt visible | Save as `pslipCode` |
| Lowercase `sp` + alphanumeric, length ≥ 8 | Process as SP00 |

#### detectBox()

```js
function detectBox() {
  const text = document.body.innerText.toUpperCase();
  for (const key of Object.keys(BOX_MAP)) {
    if (new RegExp(`\\b${key}\\b`).test(text)) return key;
  }
  return null;
}
```

Reads the page text and looks for a known box type keyword. Called after `SP_SEND_DELAY` to ensure PackApp has rendered the assigned box on screen.

#### PSLIP state watcher

```js
setInterval(() => {
  const nowVisible = /scan\s+pslip/i.test(document.body.innerText);
  ...
}, 600);
```

Polls the DOM every 600ms. When PackApp shows "Scan PSLIP", an orange persistent banner appears at the top of the page instructing the user what to do. The banner stays until the PSLIP step clears from the DOM.

#### Status banner

A fixed `<div>` pinned to the top of PackApp. Green for normal confirmations, orange for PSLIP-related states. Auto-hides after 5 seconds (except PSLIP state, which stays until resolved).

---

### runShipApp()

**Purpose:** Poll shared storage for a pending order, send SP00 and box barcode via keyboard events, report result.

#### Status overlay

A small dark overlay pinned to the bottom-right corner of ShipApp with two lines:
- **Status line** — current action (waiting / sending / success / error)
- **Debug line** — lower-level detail in smaller grey text

#### poll()

```js
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) poll();
});
```

Runs on an 800ms interval and also fires immediately when the user switches to the ShipApp tab. Checks for a pending order in GM storage, verifies it is not stale (> 5 minutes old), and confirms the page currently shows "Scan the SP" before proceeding.

#### processOrder()

The main async processing sequence:

1. `sendBarcode(sp00)` — sends SP00
2. `waitFor(BOX or PSLIP or FAILURE, 10s)` — waits for next screen
3. If ShipApp shows "Scan PSLIP" — sends stored PSLIP barcode (or pauses 60s for manual scan if not captured)
4. `sleep(BOX_WAIT_MS)` — brief delay before sending box
5. `sendBarcode(boxBarcode)` — sends box barcode
6. `waitFor(SUCCESS or FAILURE, 10s)` — waits for result
7. Reports outcome in overlay

The order is **cleared from storage at the start** of `processOrder`, before any sending begins. This prevents a second poll from re-processing the same order if the tab gains focus mid-flight.

#### sendBarcode() — input strategy

```js
function sendBarcode(barcode) {
  if (tryAngular(barcode)) return;   // try Angular scope injection first
  for (const char of barcode) fireChar(char);  // fallback: keyboard events
  fireEnter();
}
```

Two strategies tried in order:

**Strategy 1 — Angular scope injection:** Finds Angular controller elements on the page, gets their scope, and calls known barcode processing methods directly (`publishBuffer`, `submitBarcode`, `handleBarcode`, etc.). This bypasses the DOM event layer entirely. In practice, ShipApp's Angular scope does not expose these methods, so this path always falls through.

**Strategy 2 — Keyboard events to document.body:** Dispatches `keydown` + `keypress` for each character, then `Enter`. Events are dispatched **synchronously** (no `await`/`setTimeout` between characters). ShipApp's jQuery handler on `window` catches them as they bubble up from `document.body`.

#### makeKE() / fireChar() / fireEnter()

```js
function makeKE(type, char, code) {
  const e = new KeyboardEvent(type, { key: char, charCode: code, ... bubbles: true });
  Object.defineProperty(e, 'keyCode', { value: code });  // read-only override
  ...
}
```

`keyCode`, `charCode`, and `which` are read-only on `KeyboardEvent` by spec. The `Object.defineProperty` override forces them to the correct values so ShipApp's older jQuery-based event handler reads them correctly.

#### waitFor() / sleep()

```js
function waitFor(predFn, ms) {
  return new Promise(resolve => {
    const t = setInterval(() => {
      if (predFn()) { clearInterval(t); resolve(true); }
      else if (Date.now() - start > ms) { clearInterval(t); resolve(false); }
    }, 300);
  });
}
```

Polls a predicate every 300ms up to a maximum timeout. Returns `true` if the condition was met, `false` if it timed out. Used to wait for ShipApp screen transitions between steps.

---

## Version History & Bug Log

### v1 — Two-Script Approach ❌

**What we tried:** Two separate Tampermonkey scripts — one for PackApp, one for ShipApp — communicating via `GM_setValue`/`GM_getValue`.

**What broke:** Tampermonkey isolates `GM_setValue` storage per script by UUID namespace bucket. Even with the same `@namespace` declared, each script gets its own isolated storage. PackApp's script wrote to one bucket; ShipApp's script read from a completely different one. The two scripts could never see each other's data.

**Result:** ShipApp never received any orders. No errors — just silent nothing.

---

### v2 — Namespace Tweaks ❌

**What we tried:** Various `@namespace` and `@name` combinations hoping to force shared storage between two scripts.

**What broke:** Storage isolation is by internal script UUID, not by namespace string. No combination of metadata fixes this. The two scripts are fundamentally separate entities.

**Result:** Same as v1. Still silent.

---

### v3 — Combined Single Script ✅ (storage fixed) ❌ (input failed)

**What we fixed:** Merged both scripts into one file. Since both app sections now live in the same script, they share the same `GM_setValue` bucket. Storage communication works.

**What broke:** ShipApp still didn't process the barcodes. The keyboard events were dispatched to `document` and `window` simultaneously, causing duplicate event delivery. ShipApp apparently processed one and ignored the second, leading to unpredictable behavior. Angular scope injection was not yet attempted.

---

### v4 — Multi-Strategy Input ⚠️ (partial)

**What we added:** Angular scope injection as a first-pass strategy. Fallback to `document.body` event dispatch (single target, no duplicate). Input now attempted via `scope.publishBuffer()`, `scope.submitBarcode()`, etc.

**Bugs found during testing:**

| Bug | Symptom | Root cause |
|---|---|---|
| Background tab throttling | ShipApp received garbled/partial barcodes when tab was in background | `setTimeout` delays between characters — browser throttles timers in hidden tabs to ≥1000ms, so chars arrived out of order or were dropped |
| BOX BARCODE false positive | Script triggered "BOX ready" immediately without waiting | Was checking for text `'BOX BARCODE'` — a column header always present on the page. Should wait for `'Scan the BOX'` heading which only appears at the right step |
| Duplicate sends | Same order processed twice | Order cleared from storage *after* processing finished; a second `poll()` could fire and pick up the same order while the first was still mid-flight |
| No failure detection | Script hung waiting after ShipApp showed `FAILURE` | No code to detect or handle ShipApp rejection states |
| PackApp barcode truncation | SP00 detected as partial string (e.g. `spRKB6X` instead of full `spRKB6Xg4MW`) | Buffer had a reset timer — if scanner input was fast, timer fired mid-scan and flushed an incomplete buffer |
| Tab switch delay | First order after switching to ShipApp took up to 800ms to start | `poll()` only ran on interval; switching tabs didn't trigger an immediate poll |

---

### v5 — Production Release ✅

All v4 bugs fixed:

**Background tab throttling → synchronous dispatch**
```js
// Before (broken): await sleep(20) between chars
// After (fixed): synchronous loop, no await
for (const char of barcode) fireChar(char);
fireEnter();
```
No sleep between characters means no timer throttling. All chars fire in the same synchronous execution frame.

**BOX BARCODE false positive → correct text target**
```js
// Before: t.includes('BOX BARCODE')   ← always present on page
// After:  t.includes('Scan the BOX')  ← only present at the right step
```

**Duplicate sends → clear storage first**
```js
GM_setValue(STORAGE_KEY, '');   // ← clear BEFORE processing starts
await processOrder(order);
```

**Failure detection → explicit FAILURE/Invalid check**
```js
const failed = document.body.innerText.includes('FAILURE') ||
               document.body.innerText.includes('Invalid');
```
Both `waitFor()` calls now include FAILURE/Invalid as exit conditions so the script doesn't hang.

**Barcode truncation → Enter-only flush**
```js
// Before: had a setTimeout reset timer that could fire mid-scan
// After: buffer only flushes on Enter key — exactly when scanner sends it
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { onScan(buffer.trim()); buffer = ''; }
  else if (e.key.length === 1) { buffer += e.key; }
}, true);
```

**Tab switch delay → visibilitychange listener**
```js
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) poll();
});
```
Fires poll immediately when user switches to ShipApp tab.

---

### v5.1 — PSLIP Detection

**Context:** Some orders require a packing slip (PSLIP) — a physical document printed locally and placed in the box before sealing. PackApp shows a "Scan PSLIP" prompt, waits for the slip to print, then requires the user to scan the printed barcode before allowing SP00 to be scanned.

**Bug found:** The SP00 detection regex was case-insensitive: `/^sp/i`. PSLIP barcodes begin with uppercase `S` followed by an encrypted shipment ID (format: `"S" + encryptedShipmentId` from PackApp source). The pattern `Sp...` would match `/^sp/i`, causing the script to misidentify a PSLIP barcode as an SP00.

**Fix:**
```js
// Before: /^sp/i  — matches "Sp..." which is a PSLIP barcode prefix
// After:  /^sp/   — case-sensitive; SP00 always lowercase "sp..."
```

**Added: PSLIP state banner**
A persistent orange banner appears at the top of PackApp whenever "Scan PSLIP" is visible in the DOM. Message: `⚠ PSLIP order — scan slip from printer, then scan SP00 | Slip not printed? Press (p) → (a)`

**Added: PSLIP guard on SP00**
If the user scans SP00 while "Scan PSLIP" is still showing (scanned out of order), the script blocks it and shows a reminder rather than saving a premature order.

---

### v5.2 — PSLIP Barcode Capture + ShipApp Handler (current)

**Problem identified:** After PackApp completes a PSLIP order, it's unknown whether ShipApp also requires a PSLIP scan step in its own flow (SP00 → [Scan PSLIP?] → BOX). If it does, the v5.1 script would time out on the BOX screen wait after sending SP00.

**Added: PSLIP capture in PackApp**
```js
if (/^S[A-Za-z0-9]/.test(input) && input.length >= 8 && pslipVisible) {
  pslipCode = input;
}
```
When the PSLIP prompt is active and the user scans a barcode matching the PSLIP pattern, it's saved to `pslipCode` and included in the order payload sent to ShipApp.

**Added: ShipApp PSLIP handler (three-path)**

| Scenario | Behavior |
|---|---|
| ShipApp goes directly to BOX screen | Normal flow, no change |
| ShipApp shows "Scan PSLIP" + barcode was captured | Script sends PSLIP barcode automatically, then continues to BOX |
| ShipApp shows "Scan PSLIP" + no barcode (bypass was used) | Script pauses and gives user 60 seconds to scan manually |

---

## Known Issue: PSLIP Printing

**Status: Under investigation — fix planned for v5.3**

### What happens

When PackApp assigns a PSLIP order, it sends a print request via WebSocket to a locally connected thermal printer at the station. The slip prints and the user scans it. In testing, the slip **failed to print** — PackApp showed the "Scan PSLIP" prompt but the printer produced nothing.

### Why the script can't fix this

The PSLIP printing is entirely managed by PackApp's backend WebSocket connection to the station's printer. The script runs in the browser page sandbox and has no access to WebSocket traffic, printer drivers, or local hardware. This is not a script bug — it is a hardware/network issue at the station level.

### Current workaround

PackApp has a built-in "Can't Print PSLIP" problem flow:
- Press `p` → opens the Problem menu
- Press `a` → selects "Can't Print PSLIP"

This bypasses the PSLIP requirement and allows the order to continue to SP00. When this bypass is used, no PSLIP barcode is scanned in PackApp — so `pslipCode` will be `null` in the stored order.

### What v5.2 does with the bypass

If ShipApp still requires a PSLIP scan after the bypass, the script detects the "Scan PSLIP" prompt in ShipApp, shows a warning in the overlay, and waits 60 seconds for manual input. This path has not been tested end-to-end because testing requires a PSLIP order where the printer is working and/or the bypass can be cleanly triggered.

### Planned fix for v5.3

Once a full PSLIP order can be tested end-to-end (slip prints → scanned → SP00 → ShipApp), we'll confirm:
1. Whether ShipApp requires its own PSLIP scan at all
2. Whether the `pslipCode` capture + auto-send path works correctly

Based on the results, v5.3 will either confirm the current implementation is correct or add any adjustments to the ShipApp PSLIP detection logic.

---

## Installation

1. Install **Tampermonkey** from the Firefox Add-ons store (no admin required)
2. Open `FC_Scripts.html` from the Desktop
3. Click **Copy Script**
4. In Tampermonkey: click the extension icon → Dashboard → `+` (New Script)
5. Select all placeholder text → paste → `File → Save`
6. Confirm both PackApp and ShipApp URLs appear in the script's match list

To update: open the same script in Tampermonkey dashboard, replace all content, save.

---

## Configuration

At the top of the script:

```js
const SP_SEND_DELAY = 2000;  // increase if PackApp is slow to show box type
const BOX_WAIT_MS   = 1200;  // increase if ShipApp is slow to transition to BOX screen
```

If ShipApp times out after SP00 or box on a slow network day, bump these values up in 500ms increments.

---

## Box Barcode Reference

| PackApp name | ShipApp barcode |
|---|---|
| PB2 | FSA |
| PM4 | FRQ |
| PM5 | FRR |
| OWNBOX / SIOC | OWNBOX |

---

## ShipApp Manual Setup (per shift)

ShipApp requires manual configuration each time before the first order of a shift:

1. Select **job type**
2. Enter **station ID**
3. Click **Skip scale**
4. Click **Continue** past the hazmat screen
5. Wait until the screen shows **"Scan the SP00"**

The script only activates once "Scan the SP" text is visible — so completing setup is required before automation will work.

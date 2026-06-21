
# FC Pack Automation -- AutoHotkey Edition

An AutoHotkey v2 background process that automates the PackApp -> ShipApp fulfillment workflow at Amazon FCs. This is a branch of the [Tampermonkey edition](README.md), rebuilt at the OS level for workstations where browser extensions are unavailable or a standalone executable is preferred.

Instead of running inside Firefox, this version runs silently from the Windows system tray. It intercepts scanner keystrokes globally, reads Firefox page content via the Windows accessibility API (MSAA), and sends barcodes to ShipApp using real OS-level keystrokes.

---

## Table of Contents

- [Background](#background)
- [Differences from Tampermonkey Version](#differences-from-tampermonkey-version)
- [How It Works](#how-it-works)
- [Script Sections Reference](#script-sections-reference)
- [Version History](#version-history)
- [Compiling to EXE](#compiling-to-exe)
- [Installation](#installation)
- [Configuration](#configuration)
- [Box Barcode Reference](#box-barcode-reference)
- [ShipApp Manual Setup](#shipapp-manual-setup-per-shift)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Background

The standard FC packing workflow requires switching to ShipApp after every PackApp order to re-scan the SP00 and box barcode. The TM edition automates this by running inside the browser with direct DOM access. The AHK edition does the same thing from outside the browser, using Windows APIs instead of JavaScript.

**Why a separate AHK version:**

- FC workstations with group policy restrictions may block Tampermonkey or browser extensions
- A compiled `.exe` requires no browser setup -- copy the file and run it
- AutoHotkey's global `InputHook` captures scanner input at the OS level, regardless of which app is active
- Once compiled, the `.exe` embeds the AHK runtime -- no AHK installation required on target machines

**Constraint:** The AHK version cannot access browser DOM directly. It reads page content through Windows MSAA (Microsoft Active Accessibility / IAccessible2), which Firefox exposes by default. ShipApp **must be the active tab** in its Firefox window -- Windows MSAA only exposes the currently visible tab's content.

---

## Differences from Tampermonkey Version

| Aspect | Tampermonkey Edition | AHK Edition |
|---|---|---|
| Runs inside | Firefox (browser sandbox) | Windows OS (system tray process) |
| Page content access | `document.body.innerText` (direct DOM) | `WinGetText()` via Windows MSAA |
| Cross-tab data bridge | `GM_setValue` / `GM_getValue` | Temp file: `%TEMP%\fc_auto_order.json` |
| Scanner input capture | `document.addEventListener('keydown')` in capture phase | Global `InputHook("V C")` -- OS-level hook |
| Barcode sending to ShipApp | `KeyboardEvent` dispatch via JS | `SendText()` + `Send("{Enter}")` -- real OS keystrokes |
| Status display | Fixed `<div>` injected into page | `ToolTip()` near cursor (auto-dismisses) |
| PSLIP banner | Persistent colored `<div>` banner | Persistent `ToolTip()` in slot 2 |
| Install requirement | Tampermonkey extension (no admin) | AHK v2 to run as script; no AHK needed for compiled `.exe` |
| ShipApp tab constraint | None (runs in tab, always has DOM access) | ShipApp must be the **active tab** |
| Timing model | `setInterval` / `Promise` / `async-await` | `SetTimer` / `Sleep` (AHK single-threaded) |

The scan classification logic, box detection patterns, PSLIP guard, hazmat detection, order TTL, and all timing constants mirror TM v5.7.

---

## How It Works

```
Scanner (physical)
      |
      | keystrokes -> active window (Firefox)
      |
 InputHook (OS-level, "V C" mode)
      |
      | char by char to g_buffer
      | flushes on Enter (vk=13)
      |
   _OnScan()
      |
      |-- tote?   -> g_toteScanned = true
      |-- PSLIP?  -> g_pslipCode = input  (if pslip prompt visible)
      |-- SP00?   -> g_pendingSP00 = input  (hand off to timer)
      |
_WatchPackApp() [100ms timer]
      |
      | WinGetText(active Firefox) -> i) regex match for PB2/PM4/PM5/OWNBOX/SIOC
      |
      | box found -> _WriteOrder() -> %TEMP%\fc_auto_order.json
      |
_WatchPackState() [600ms timer]
      |
      | WinGetText(active Firefox) -> _DetectHazmat() -> g_hazmatCode
      | RegExMatch(i)scan\s+pslip) -> ToolTip slot 2
      |
_PollShipApp() [200ms timer]
      |
      | FileExist -> FileRead -> _ParseJson -> TTL check
      | _FindFirefoxWithText("Scan the SP") -> hwnd
      |
   _ProcessOrder(order, hwnd)
      |
      | WinActivate(hwnd)
      | _SendBarcode(sp00)      -- SendText + {Enter}
      | _WaitForWindowText("Scan the BOX", 10s)
      | Sleep(600)
      | _SendBarcode(boxBarcode) -- SendText + {Enter}
      | _WaitForWindowText("SUCCESS", 10s)
      | ShowTip("Shipped!")
```

**Two ToolTip slots run in parallel:**
- Slot 1: Status messages (timed, auto-dismiss after N ms)
- Slot 2: Persistent PSLIP banner (stays until PSLIP step clears from DOM)

---

## Script Sections Reference

### CONFIG block

```autohotkey
global ORDER_FILE      := A_Temp "\fc_auto_order.json"
global POLL_MS         := 200      ; ShipApp order-poll interval (ms) -- halved in v1.1
global PSLIP_POLL_MS   := 600      ; PSLIP + hazmat watcher interval (ms)
global PACK_POLL_MS    := 100      ; PackApp box-detection poll interval (ms)
global BOX_DETECT_MAX  := 2000     ; max wait for box type in PackApp (ms)
global BOX_SEND_DELAY  := 600      ; settling pause before sending each barcode (ms)
global ORDER_TTL       := 300000   ; discard orders older than 5 minutes (ms)

global HAZMAT_MAP := Map(
    "UN3481", "UN3481BotBar",
    "UN3480", "UN3480BotBar",
    "UN3091", "UN3091BotBar",
    "UN3090", "UN3090BotBar"
)
```

- `POLL_MS` -- halved from 400ms to 200ms in v1.1 (mirrors TM v5.6).
- `HAZMAT_MAP` -- maps UN type codes to the ShipApp barcode expected at the hazmat scan step. Mirrors TM v5.5 `HAZMAT_MAP` exactly.

All other timing values mirror TM v5.7. `A_Temp` resolves to the user's `%TEMP%` directory, which is always writable without admin rights.

---

### InputHook setup

```autohotkey
global g_ih := InputHook("V C")
g_ih.EndKeys := ""
g_ih.KeyOpt("{Enter}", "VN")
g_ih.KeyOpt("{BS}", "VN")
g_ih.OnChar    := _OnChar
g_ih.OnKeyDown := _OnKeyDown
g_ih.Start()
```

- **`"V"` (Visible):** Characters pass through to the active window -- the scanner still types into PackApp fields normally.
- **`"C"` (Case-sensitive):** Preserves case. Critical: `sp` (SP00) vs `S` (PSLIP) are distinguished by case -- without `C`, both would arrive lowercase and the PSLIP classifier would miss its barcodes.
- **`EndKeys := ""`:** By default AHK's `InputHook` ends on Enter, which would halt the capture loop. Clearing `EndKeys` keeps the hook running indefinitely.
- **`KeyOpt("{Enter}", "VN")`:** "V" = pass Enter through to Firefox (so PackApp receives the scan), "N" = notify via `_OnKeyDown` so we can flush the buffer.
- **`KeyOpt("{BS}", "VN")`:** Pass backspace through and allow erasing the last buffered character (defensive -- scanners don't send backspace, but manual typing can).

**Important:** AHK v2 does not allow `return` (or `break`/`continue`) on the same line as `if`. All flow-control exits are written on the following line:

```autohotkey
; Correct AHK v2 syntax
if (condition)
    return

; This will throw a parse error: "reserved word must not be used as variable"
if (condition) return
```

---

### _OnChar / _OnKeyDown (InputHook callbacks)

`_OnChar` appends each printable character to `g_buffer`. `_OnKeyDown` handles Enter (vk=13) and Backspace (vk=8):

```autohotkey
_OnKeyDown(ih, vk, sc) {
    global g_buffer
    if (vk = 8) {
        if StrLen(g_buffer) > 0
            g_buffer := SubStr(g_buffer, 1, -1)
        return
    }
    if (vk = 13) {
        raw      := Trim(g_buffer)
        g_buffer := ""
        if (raw != "" && WinActive("ahk_class MozillaWindowClass"))
            _OnScan(raw)
    }
}
```

The `WinActive("ahk_class MozillaWindowClass")` guard ensures `_OnScan` only fires when Firefox is the active application. Keystrokes typed into any other app are buffered but silently discarded on Enter.

---

### _OnScan (scan classifier)

Mirrors TM v5.7 `onScan()` exactly, with one addition: a **barcode gate** that pre-filters manual keyboard input:

```autohotkey
if !RegExMatch(input, "^[\w-]{6,50}$")
    return
```

This rejects URLs, search text, form input, and anything with spaces or special characters. Barcode scanners produce clean alphanumeric strings (plus hyphen); normal typed text does not match `^\w` with no spaces at length 6+.

Classification order:

| Pattern | Action |
|---|---|
| Not SP00, not PSLIP, tote not yet seen | `g_toteScanned = true`, **`g_hazmatCode = ""`**, tip shown |
| `^S[A-Za-z0-9]`, length >= 8, PSLIP prompt visible | Save to `g_pslipCode` |
| `^sp`, length >= 8 | Set `g_pendingSP00`; hand to box-detection timer |

`^sp` is case-sensitive by default in AHK v2 regex (unlike AHK v1). No flags needed.

---

### _WatchPackApp (100ms timer)

Polls for a box type after SP00 is captured. Non-blocking: sets `g_pendingSP00` and returns -- the timer fires again in 100ms if no box is found yet.

```autohotkey
_WatchPackApp() {
    if (g_pendingSP00 = "") return        ; nothing pending
    if (A_TickCount - g_pendingTick >= BOX_DETECT_MAX) { ... timeout ... }

    hwnd := WinActive("ahk_class MozillaWindowClass")
    if !hwnd return                        ; Firefox not active; keep waiting

    box := _DetectBox(hwnd)
    if (box = "") return                   ; not found yet; retry in 100ms

    _WriteOrder(g_pendingSP00, box, BOX_MAP[box])
    ...
}
```

`_WatchPackApp` reads MSAA text only when a SP00 is actually pending. At all other times it returns immediately on the first line -- negligible CPU cost.

---

### _WatchPackState (600ms timer)

Reads the active Firefox window's MSAA text every 600ms. Sets/clears `g_pslipVisible`, manages the persistent PSLIP ToolTip in slot 2, and calls `_DetectHazmat()` each cycle to watch for UN codes in PackApp:

```autohotkey
text       := WinGetText("ahk_id " hwnd)
nowVisible := RegExMatch(text, "i)scan\s+pslip") != 0
```

The `i)` prefix makes the regex case-insensitive (AHK v2 inline modifier). This is the only place case-insensitive matching is used -- page text from MSAA has no guaranteed casing.

---

### _DetectBox

```autohotkey
_DetectBox(hwnd) {
    text := WinGetText("ahk_id " hwnd)
    for key, _ in BOX_MAP {
        if RegExMatch(text, "i)\b" key "\b")
            return key
    }
    return ""
}
```

`StrUpper` replaced with the `i)` inline flag -- avoids creating an uppercase copy of the full MSAA string on every poll cycle. `\b` prevents partial matches (e.g. "OWNBOXES" falsely matching "OWNBOX").

`WinGetText` reads Firefox's accessibility tree via Windows MSAA/IAccessible2. Firefox exposes all visible text content from the active tab. The output includes newlines between elements and may include UI chrome text (address bar, tab titles) -- but PackApp's box labels (PB2, PM4, etc.) are distinct enough that false positives are not a concern.

---

### _PollShipApp (200ms timer)

Reads the order file, finds the ShipApp Firefox window, and dispatches to `_ProcessOrder`. Uses `try/finally` to guarantee `g_busy` is cleared even if `_ProcessOrder` throws:

```autohotkey
g_busy := true
try {
    _DeleteOrder()          ; clear before processing -- prevents duplicate sends
    _ProcessOrder(order, hwnd)
} finally {
    g_busy := false
}
```

`_FindFirefoxWithText("Scan the SP")` enumerates all `MozillaWindowClass` windows and returns the first one whose MSAA text contains "Scan the SP". This handles multiple Firefox windows but not background tabs -- MSAA only exposes the active tab in each window.

---

### _ProcessOrder (4-step standard / 6-step hazmat)

```
Step 1: WinActivate + WinWaitActive + _SendBarcode(sp00)
Step 2: _WaitForWindowText(["Scan the BOX", "FAILURE", "Invalid"], 10s)
Step 3: Sleep(BOX_SEND_DELAY) + WinActivate + _SendBarcode(boxBarcode)
Step 4: _WaitForWindowText(["Scan the UN", "SUCCESS", "FAILURE", "Invalid"], 10s)
Step 5: (hazmat) Sleep(BOX_SEND_DELAY) + WinActivate + _SendBarcode(hazmatBarcode)
Step 6: (hazmat) _WaitForWindowText(["SUCCESS", "FAILURE", "Invalid"], 10s)
```

`WinActivate` brings the ShipApp Firefox window to the foreground before each barcode send (SP00, box, and hazmat). This is necessary because `SendText` sends keystrokes to the **active window** -- unlike the TM version which dispatches events directly to a DOM node regardless of tab visibility.

**Hazmat note:** Step 4 always watches for `"Scan the UN"` in addition to SUCCESS/FAILURE. If ShipApp prompts for a UN barcode, Step 5 sends it (from the order payload, or read directly from the ShipApp MSAA text as fallback).

**PSLIP note:** ShipApp does NOT require a PSLIP barcode (confirmed live test 2026-06-10). The flow is always SP00 -> BOX -> (UN if hazmat) -> label prints.

---

### _SendBarcode

```autohotkey
_SendBarcode(barcode) {
    SendText(barcode)
    Send("{Enter}")
    Sleep(50)
}
```

`SendText` is used instead of `Send` to prevent AHK from interpreting special characters in the barcode as hotkey modifiers (`{`, `!`, `^`, `+`, `#`). `SendText` sends each character as a literal keystroke.

`Send("{Enter}")` is a separate call because `{Enter}` is a special key name, not a printable character, and `SendText` would send it as literal text.

These real OS-level keystrokes travel through Firefox's normal WM_KEYDOWN/WM_CHAR message pipeline. ShipApp's jQuery keystroke listener receives them identically to physical scanner input.

---

### _WaitForWindowText

```autohotkey
_WaitForWindowText(hwnd, needles, timeoutMs) {
    startTick := A_TickCount
    loop {
        text := WinGetText("ahk_id " hwnd)
        for _, needle in needles {
            if InStr(text, needle)
                return true
        }
        if (A_TickCount - startTick >= timeoutMs)
            return false
        Sleep(100)
    }
}
```

Polls MSAA text every 100ms. In AHK v2, `for index, value in array` provides both index and value -- `_` discards the index. `A_TickCount` is milliseconds since system boot (Windows `GetTickCount()`).

This function blocks its calling thread (AHK is single-threaded by default). Other `SetTimer` callbacks are queued and execute after `_ProcessOrder` completes. The `InputHook` is a separate OS-level hook and continues capturing scanner input uninterrupted during this time.

---

### Order File (temp file bridge)

Replaces `GM_setValue` / `GM_getValue` from the TM version. A single flat JSON file:

```json
{"sp00":"spRKB6Xg4MW","box":"PB2","barcode":"FSA","hazmat":"UN3481","hazmatBarcode":"UN3481BotBar","ts":12345678}
```

Written by `_WriteOrder`, read by `_ReadOrder`, deleted before `_ProcessOrder` starts.

`ts` is `A_TickCount` at write time. On read, `(A_TickCount - ts) > ORDER_TTL` discards orders older than 5 minutes. `A_TickCount` wraps after ~49.7 days of system uptime -- negligible risk for a 5-minute TTL on a workstation that reboots regularly.

`_ParseJson` is a minimal hand-rolled parser for this flat format only. It supports quoted string values and unquoted integer values. No external dependencies.

---

### ShowTip

```autohotkey
ShowTip(msg, ms := 4000, *) {
    ToolTip(msg)
    if (ms > 0)
        SetTimer(() => ToolTip(), -ms)
}
```

`ToolTip()` (no args) clears the tip. Negative `SetTimer` delay = run once after N ms (one-shot timer). The `*` parameter absorbs any extra args passed accidentally (defensive).

**Two slots:**
- Slot 1 (default): status messages via `ShowTip()` -- auto-dismiss
- Slot 2: persistent PSLIP banner via `ToolTip(msg, , , 2)` -- cleared by `ToolTip(, , , 2)`

The two slots are independent. A short-lived status tip in slot 1 does not clear the persistent PSLIP tip in slot 2.

---

## Version History

### v1.0 -- Initial port from TM v5.4 (2026-06-11)

First AHK v2 implementation. Complete OS-level port of the Tampermonkey v5.4 logic:

- Global `InputHook("V C")` replaces `document.addEventListener('keydown')`
- `WinGetText` via MSAA replaces `document.body.innerText`
- Temp file JSON replaces `GM_setValue` / `GM_getValue`
- `SendText` + `Send("{Enter}")` replaces `KeyboardEvent` dispatch
- `ToolTip` replaces in-page status banners
- `SetTimer` replaces `setInterval` / `setTimeout`
- Non-blocking box detection via `g_pendingSP00` + 100ms timer replaces `waitFor(() => !!detectBox())`

---

### v1.0.1 -- AHK v2 syntax fix (2026-06-12)

**Bug:** Script failed to parse at line 160 with error: *"The following reserved word must not be used as a variable name: return"*

**Root cause:** AHK v2 does not allow flow-control keywords (`return`, `break`, `continue`) on the same line as an `if` statement. The pattern `if (condition) return` is parsed as a function call expression, causing AHK to see `return` as a variable name.

**Fix:** All 5 instances split onto two lines:

```autohotkey
; Before (parse error)
if (g_pendingSP00 = "") return
if !hwnd return
if (g_busy) return
if !order return

; After (correct)
if (g_pendingSP00 = "")
    return
if !hwnd
    return
```

Affected lines: 160, 171, 173, 237, 242, 245 (post-fix numbering).

---

### v1.1 -- Hazmat support + performance (current)

Ports TM v5.5, v5.6, and v5.7 changes to the AHK edition.

**Hazmat UN support (TM v5.5):**
- Added `HAZMAT_MAP` with four lithium battery UN codes and their ShipApp barcodes.
- Added `g_hazmatCode` state variable; cleared on tote scan only.
- `_WatchPslip` renamed to `_WatchPackState` -- now also calls `_DetectHazmat()` each cycle. When a UN code appears in PackApp MSAA text, `g_hazmatCode` is set and a tip is shown.
- New `_DetectHazmat(hwnd)` function: reads MSAA text, tests against `HAZMAT_MAP` with `i)` flag.
- `_WriteOrder` gains a `hazmat` parameter; writes `hazmat` and `hazmatBarcode` fields to JSON.
- `_ProcessOrder` extended from 4 to 6 steps: Step 4 also watches for `"Scan the UN"`; Step 5 sends the UN barcode; Step 6 waits for final result.

**Performance (TM v5.6):**
- `POLL_MS` halved from 400ms to 200ms -- ShipApp polls for orders twice as often.
- `_DetectBox` drops `StrUpper` + uses `i)` inline flag instead -- avoids unnecessary string copy.

**Hazmat banner persistence fix (TM v5.7):**
- `g_hazmatCode` is no longer cleared in `_WatchPackApp` after the order is sent. The `if (g_hazmatCode = "")` guard in `_WatchPackState` prevents re-detection while the UN code stays in MSAA text. `g_hazmatCode` is cleared only on the next tote scan.

**Not ported (no AHK equivalent):**
- MutationObserver (`_WaitForWindowText` already polls at 100ms -- same effect).
- `BOX_KEYS` / `HAZMAT_KEYS` pre-cache (AHK `Map` iteration has no equivalent allocation issue).

---

## Compiling to EXE

A compiled `.exe` embeds the AHK v2 runtime and runs on any Windows machine without AHK installed.

### Getting Ahk2Exe

The AHK Dash's built-in Ahk2Exe installer may fail on machines where it cannot write to its target directory. The simplest workaround is to download the AHK v2 portable ZIP, which includes Ahk2Exe independently of the installer:

1. Go to `https://github.com/AutoHotkey/AutoHotkey/releases/latest`
2. Download the file named `AutoHotkey_2.x.x.zip` (not the `.exe` installer)
3. Extract anywhere -- no installation required
4. Ahk2Exe is at `Compiler\Ahk2Exe.exe` inside the extracted folder

### Compiling

1. Run `Ahk2Exe.exe`
2. **Source:** Browse to `fc-auto.ahk`
3. **Destination:** Leave blank (produces `fc-auto.exe` in the same folder) or choose a path
4. Click **Convert**

The resulting `.exe` is self-contained (~3-4 MB) and requires no AHK installation to run.

### Deployment

Copy `fc-auto.exe` to any FC workstation. Double-click to run. It appears in the system tray with a package icon. Right-click the icon to Reload or Exit.

**Note on endpoint security:** FC workstation security policy may block unsigned executables. If Windows Defender or a group policy blocks the `.exe`, the file cannot be run regardless of admin status -- code-signing would be required. In that case, the [Tampermonkey edition](README.md) remains the reliable option.

---

## Installation

### Running as a script (requires AHK v2 installed)

1. Install AutoHotkey v2 from `https://www.autohotkey.com/download/`
2. Double-click `fc-auto.ahk` -- AHK runs it directly
3. Script appears in system tray

### Running as a compiled EXE (no AHK required)

See [Compiling to EXE](#compiling-to-exe).

### Per shift

1. Start `fc-auto.ahk` or `fc-auto.exe` before opening the apps
2. Open PackApp and ShipApp in Firefox
3. Navigate ShipApp to the "Scan the SP00" screen (see [ShipApp Manual Setup](#shipapp-manual-setup-per-shift))
4. Make sure ShipApp is the **active tab** in its Firefox window
5. Scan normally in PackApp -- the script handles the rest

---

## Configuration

All tunable constants are at the top of the script under `; --- CONFIG ---`:

```autohotkey
global POLL_MS         := 200      ; how often ShipApp polls for orders (ms)
global PSLIP_POLL_MS   := 600      ; PSLIP + hazmat check interval (ms)
global PACK_POLL_MS    := 100      ; box-type detection poll interval (ms)
global BOX_DETECT_MAX  := 2000     ; max wait for box type to appear (ms)
global BOX_SEND_DELAY  := 600      ; settling pause before sending each barcode (ms)
global ORDER_TTL       := 300000   ; order expiry: 5 minutes (ms)
```

If ShipApp starts timing out after SP00, box, or the hazmat scan on a slow day, increase `BOX_SEND_DELAY` in 200ms steps. `BOX_SEND_DELAY` applies to all three barcode sends. If PackApp box detection stops working reliably, increase `BOX_DETECT_MAX`.

If MSAA reads are slow on a particular workstation (WinGetText takes noticeably long), increase `PACK_POLL_MS` and `PSLIP_POLL_MS` to reduce CPU load.

---

## Box Barcode Reference

| PackApp name | ShipApp barcode |
|---|---|
| PB2 | FSA |
| PM4 | FRQ |
| PM5 | FRR |
| OWNBOX | OWNBOX |
| SIOC | OWNBOX |

---

## ShipApp Manual Setup (per shift)

ShipApp requires manual configuration before the first order each shift. The script only activates once "Scan the SP" appears -- setup must be completed first:

1. Select **job type**
2. Enter **station ID**
3. Click **Skip scale**
4. Click **Continue** past the hazmat screen
5. Wait until the screen shows **"Scan the SP00"**

---

## Troubleshooting

### Box type not detected / "Box type not detected in PackApp" tip

`WinGetText` reads the MSAA accessibility tree for the active Firefox tab. To verify it is returning the expected content:

1. Temporarily add this line to the script and run it while PackApp is open:
   ```autohotkey
   MsgBox(WinGetText("ahk_class MozillaWindowClass"))
   ```
2. If the MsgBox is empty or shows only browser chrome text (tabs, address bar), Firefox accessibility is not working as expected.
3. Try: Firefox menu -> Settings -> search "accessibility" -> ensure accessibility services are enabled.

If PackApp is open but not the active tab, `WinGetText` returns the text from whichever tab IS active. Ensure PackApp is visible when scanning SP00.

### ShipApp not found / orders not sent

`_FindFirefoxWithText("Scan the SP")` scans all Firefox windows for one whose active tab shows "Scan the SP". Causes of failure:

- ShipApp is in a **background tab** -- MSAA only exposes the active tab. Switch the ShipApp window so ShipApp is the visible tab.
- ShipApp is on a **different string** -- navigate ShipApp fully to the "Scan the SP00" screen before the first scan.
- ShipApp window is **minimized** -- `WinGetText` may not read minimized windows. Keep it on-screen (minimized to taskbar is usually fine, but test on your workstation).

### Script not intercepting scanner input

`_OnScan` only runs when `WinActive("ahk_class MozillaWindowClass")` is non-zero -- i.e., when Firefox is the foreground window. If scanner input goes to a different app, the buffer still accumulates but `_OnScan` is never called.

Ensure Firefox is the active window when scanning. If using a scan gun, the USB receiver must be sending keystrokes to Firefox.

### PSLIP banner not appearing

`_WatchPackState` only runs when a Firefox window is active. If PSLIP text appears in PackApp but the tip never shows:
- Verify the MSAA text includes "scan pslip" by using the `MsgBox(WinGetText(...))` diagnostic above
- The regex `i)scan\s+pslip` matches "Scan PSLIP", "scan pslip", "Scan the PSLIP", etc. -- check the exact wording PackApp uses on your site

### EXE blocked by Windows Defender / endpoint policy

Unsigned executables downloaded from outside a managed software deployment channel may be blocked by Windows Defender SmartScreen or group policy. This is an endpoint security enforcement, not a script bug. Options:
- Use the Tampermonkey edition instead (runs inside an already-trusted browser)
- Submit the `.exe` for IT approval / code-signing if available

---

## Known Limitations

| Limitation | Detail |
|---|---|
| ShipApp must be active tab | Windows MSAA only exposes visible tab content. ShipApp in a background tab is invisible to `WinGetText` -- script will not find it and will not send barcodes. |
| Window activation | ShipApp's Firefox window is brought to the foreground when an order is processed. If the user is actively typing elsewhere, focus shifts briefly. |
| Single ToolTip | AHK's `ToolTip` appears near the cursor. If the cursor is not on the workstation's primary display, the tip may appear off-screen. |
| AHK single-threaded | `_ProcessOrder` blocks AHK's message loop while waiting for ShipApp (up to ~10s per wait). Other timers are queued, not dropped. `InputHook` continues capturing at the OS level unaffected. |
| MSAA text format | `WinGetText` output includes browser UI text (tab titles, address bar). Box keywords (PB2, PM4, etc.) are unlikely to appear in browser chrome, but extremely unusual tab titles could theoretically produce a false positive. |
| A_TickCount wraparound | `A_TickCount` wraps after ~49.7 days. The ORDER_TTL comparison could behave incorrectly at that boundary. Negligible risk on machines that reboot regularly. |

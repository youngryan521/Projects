#Requires AutoHotkey v2.0
#SingleInstance Force

; ==============================================================================
;  FC Pack Automation  --  AutoHotkey v2 background worker
;  OS-level equivalent of Tampermonkey v5.7
;  Requires: AutoHotkey v2.0+  |  Firefox with PackApp + ShipApp open
;
;  HOW IT WORKS:
;   - Global InputHook captures scanner keystrokes from any app.
;   - PackApp side: detects SP00 + box type + hazmat UN code, writes order to temp file.
;   - ShipApp side: polls the temp file; when ShipApp shows "Scan the SP",
;     activates its window and sends the barcodes automatically.
;   - Hazmat orders: detects UN code from PackApp MSAA text; sends UN barcode
;     at Step 5 if ShipApp shows "Scan the UN3481" (or similar).
;
;  SETUP: Run once per shift. Leave in system tray. ShipApp must be the
;         ACTIVE TAB in its Firefox window (Windows MSAA only reads active tabs).
;
;  LIMITATION: Windows MSAA text reading depends on Firefox accessibility.
;  If box detection fails, run MsgBox(WinGetText("ahk_class MozillaWindowClass"))
;  to verify Firefox is exposing page content.
; ==============================================================================

; --- CONFIG -------------------------------------------------------------------
global ORDER_FILE      := A_Temp "\fc_auto_order.json"
global POLL_MS         := 200      ; ShipApp order-poll interval (ms) -- halved from 400 in v1.1
global PSLIP_POLL_MS   := 600      ; PSLIP + hazmat watcher interval (ms)
global PACK_POLL_MS    := 100      ; PackApp box-detection poll interval (ms)
global BOX_DETECT_MAX  := 2000     ; max wait for box type in PackApp DOM (ms)
global BOX_SEND_DELAY  := 600      ; settling pause before sending each barcode (ms)
global ORDER_TTL       := 300000   ; discard orders older than 5 minutes (ms)

; Box type -> ShipApp barcode
global BOX_MAP := Map(
    "PB2",   "FSA",
    "PM4",   "FRQ",
    "PM5",   "FRR",
    "OWNBOX","OWNBOX",
    "SIOC",  "OWNBOX"
)

; Hazmat UN type -> ShipApp barcode (mirrors TM v5.5 HAZMAT_MAP)
global HAZMAT_MAP := Map(
    "UN3481", "UN3481BotBar",
    "UN3480", "UN3480BotBar",
    "UN3091", "UN3091BotBar",
    "UN3090", "UN3090BotBar"
)

; --- State --------------------------------------------------------------------
global g_buffer       := ""     ; keystroke accumulation buffer
global g_toteScanned  := false  ; true after first tote scan
global g_pslipCode    := ""     ; PSLIP barcode (if scanned)
global g_pslipVisible := false  ; true while PackApp shows "Scan PSLIP"
global g_hazmatCode   := ""     ; UN type detected from PackApp (e.g. "UN3481"); cleared on tote scan only
global g_pendingSP00  := ""     ; SP00 waiting for box detection
global g_pendingTick  := 0      ; TickCount when SP00 was captured
global g_busy         := false  ; true while ShipApp is being driven

; --- Tray icon ----------------------------------------------------------------
A_TrayMenu.Delete()
A_TrayMenu.Add("FC Auto v1.1  (running)", (*) => {})
A_TrayMenu.Disable("FC Auto v1.1  (running)")
A_TrayMenu.Add()
A_TrayMenu.Add("Reload", (*) => Reload())
A_TrayMenu.Add("Exit",   (*) => ExitApp())
TraySetIcon("shell32.dll", 46)
A_IconTip := "FC Pack Automation v1.1"

ShowTip("FC Auto v1.1 started`nMonitoring scanner input.", 3000)

; --- Global InputHook ---------------------------------------------------------
; V = characters pass through to active window (scanner still works normally)
; C = case-sensitive (sp vs SP distinction is critical for SP00 vs PSLIP)
global g_ih := InputHook("V C")
g_ih.EndKeys := ""                 ; prevent Enter from stopping the hook
g_ih.KeyOpt("{Enter}", "VN")       ; Enter: pass through + fire OnKeyDown
g_ih.KeyOpt("{BS}",    "VN")       ; Backspace: pass through + allow buffer edit
g_ih.OnChar    := _OnChar
g_ih.OnKeyDown := _OnKeyDown
g_ih.Start()

; --- Timers -------------------------------------------------------------------
SetTimer(_WatchPackApp,   PACK_POLL_MS)   ; box detection after SP00
SetTimer(_WatchPackState, PSLIP_POLL_MS)  ; PSLIP prompt + hazmat monitor
SetTimer(_PollShipApp,    POLL_MS)        ; ShipApp order dispatch

Persistent


; ==============================================================================
;  INPUT HOOK CALLBACKS
; ==============================================================================

_OnChar(ih, char) {
    global g_buffer
    g_buffer .= char
}

_OnKeyDown(ih, vk, sc) {
    global g_buffer
    if (vk = 8) {                          ; Backspace
        if StrLen(g_buffer) > 0
            g_buffer := SubStr(g_buffer, 1, -1)
        return
    }
    if (vk = 13) {                         ; Enter -> flush buffer
        raw       := Trim(g_buffer)
        g_buffer  := ""
        if (raw != "" && WinActive("ahk_class MozillaWindowClass"))
            _OnScan(raw)
    }
}


; ==============================================================================
;  SCAN CLASSIFICATION  (mirrors TM v5.7 onScan())
; ==============================================================================

_OnScan(input) {
    global g_toteScanned, g_pslipCode, g_pslipVisible
    global g_pendingSP00, g_pendingTick, g_hazmatCode

    ; Basic barcode gate: word chars + hyphen, 6-50 chars, no spaces
    if !RegExMatch(input, "^[\w-]{6,50}$")
        return

    ; -- Tote: first scan that is not SP00 or PSLIP --
    if (!g_toteScanned
        && !RegExMatch(input, "^sp")
        && !RegExMatch(input, "^S[A-Za-z0-9]")) {
        g_toteScanned := true
        g_hazmatCode  := ""    ; fresh tote -- clear any leftover hazmat state
        ShowTip("Tote scanned -- scan items.", 2000)
        return
    }

    ; -- PSLIP barcode: uppercase S prefix, length >= 8, prompt visible --
    if (RegExMatch(input, "^S[A-Za-z0-9]") && StrLen(input) >= 8 && g_pslipVisible) {
        g_pslipCode := input
        ShowTip("PSLIP scanned -- now scan SP00.", 4000)
        return
    }

    ; -- SP00: lowercase "sp" prefix, length >= 8 --
    if (RegExMatch(input, "^sp") && StrLen(input) >= 8) {
        if (g_pslipVisible && g_pslipCode = "") {
            ShowTip("PSLIP order -- scan the slip first,`nthen scan SP00 again.", 5000)
            return
        }
        g_pendingSP00  := input
        g_pendingTick  := A_TickCount
        ShowTip("SP00 captured -- detecting box type...", 2000)
    }
}


; ==============================================================================
;  PACKAPP BOX-DETECTION TIMER  (100ms)
;  After SP00 is captured, polls active Firefox MSAA text for a box keyword.
; ==============================================================================

_WatchPackApp() {
    global g_pendingSP00, g_pendingTick, g_toteScanned, g_pslipCode, g_hazmatCode

    if (g_pendingSP00 = "")
        return

    if (A_TickCount - g_pendingTick >= BOX_DETECT_MAX) {
        ShowTip("Box type not detected in PackApp.`nRe-scan SP00 after confirming box appears.", 6000)
        g_pendingSP00 := ""
        return
    }

    hwnd := WinActive("ahk_class MozillaWindowClass")
    if !hwnd
        return

    box := _DetectBox(hwnd)
    if (box = "")
        return

    barcode := BOX_MAP.Has(box) ? BOX_MAP[box] : ""
    if (barcode = "") {
        ShowTip("Unknown box type: " box, 5000)
        g_pendingSP00 := ""
        return
    }

    ; Capture hazmat code now as fallback if watcher hasn't fired yet
    hazmat := g_hazmatCode != "" ? g_hazmatCode : _DetectHazmat(hwnd)

    _WriteOrder(g_pendingSP00, box, barcode, hazmat)

    hazmatSuffix := hazmat != "" ? "  HAZMAT: " hazmat : ""
    ShowTip("Order sent to ShipApp:`n" g_pendingSP00 "  [" box " -> " barcode "]" hazmatSuffix, 4000)

    g_pendingSP00 := ""
    g_toteScanned := false
    g_pslipCode   := ""
    ; g_hazmatCode intentionally NOT cleared here -- watcher re-detects it from MSAA
    ; text if cleared immediately (same fix as TM v5.7). Cleared only on next tote scan.
}


; ==============================================================================
;  PACKAPP STATE WATCHER  (600ms)
;  Tracks PSLIP prompt state and captures hazmat UN type from MSAA text.
;  Replaces _WatchPslip -- now handles both PSLIP and hazmat detection.
; ==============================================================================

_WatchPackState() {
    global g_pslipVisible, g_pslipCode, g_hazmatCode

    hwnd := WinActive("ahk_class MozillaWindowClass")
    if !hwnd
        return

    text := WinGetText("ahk_id " hwnd)

    ; -- PSLIP check (unchanged from v1.0) --
    nowPslipVisible := RegExMatch(text, "i)scan\s+pslip") != 0
    if (nowPslipVisible && !g_pslipVisible) {
        g_pslipVisible := true
        ToolTip("PSLIP order -- scan the slip, then scan SP00.`nSlip not printed? Problem Menu: P -> A", , , 2)
    } else if (!nowPslipVisible && g_pslipVisible) {
        g_pslipVisible := false
        ToolTip(, , , 2)
    }

    ; -- Hazmat check: detect UN type from MSAA text --
    ; Only sets g_hazmatCode -- never clears it here.
    ; Cleared only on tote scan to prevent re-detection after order is sent.
    if (g_hazmatCode = "") {
        hazmat := _DetectHazmat(hwnd)
        if (hazmat != "") {
            g_hazmatCode := hazmat
            ShowTip("Hazmat captured: " hazmat " -- scan label, then scan SP00.", 5000)
        }
    }
}


; ==============================================================================
;  BOX DETECTION
; ==============================================================================

_DetectBox(hwnd) {
    ; Case-insensitive regex (i) flag) -- no StrUpper needed (mirrors TM v5.6 change)
    text := WinGetText("ahk_id " hwnd)
    for key, _ in BOX_MAP {
        if RegExMatch(text, "i)\b" key "\b")
            return key
    }
    return ""
}


; ==============================================================================
;  HAZMAT DETECTION  (mirrors TM v5.5 detectHazmat())
; ==============================================================================

_DetectHazmat(hwnd) {
    text := WinGetText("ahk_id " hwnd)
    for key, _ in HAZMAT_MAP {
        if RegExMatch(text, "i)\b" key "\b")
            return key
    }
    return ""
}


; ==============================================================================
;  SHIPAPP POLLER TIMER
; ==============================================================================

_PollShipApp() {
    global g_busy
    if (g_busy)
        return

    order := _ReadOrder()
    if !order
        return

    hwnd := _FindFirefoxWithText("Scan the SP")
    if !hwnd
        return

    g_busy := true
    try {
        _DeleteOrder()
        _ProcessOrder(order, hwnd)
    } finally {
        g_busy := false
    }
}


; ==============================================================================
;  ORDER PROCESSOR
;  Standard orders: 4 steps (SP00 -> BOX -> result)
;  Hazmat orders:   6 steps (SP00 -> BOX -> UN barcode -> result)
; ==============================================================================

_ProcessOrder(order, hwnd) {
    sp00          := order["sp00"]
    box           := order["box"]
    barcode       := order["barcode"]
    hazmat        := order.Has("hazmat")        ? order["hazmat"]        : ""
    hazmatBarcode := order.Has("hazmatBarcode") ? order["hazmatBarcode"] : ""

    ; -- Step 1: activate ShipApp window and send SP00 -------------------------
    ShowTip("Sending SP00:`n" sp00 "...", 0)
    WinActivate("ahk_id " hwnd)
    if !WinWaitActive("ahk_id " hwnd,, 3) {
        ShowTip("Could not activate ShipApp window.", 5000)
        return
    }
    _SendBarcode(sp00)

    ; -- Step 2: wait for BOX screen or error (up to 10s) ---------------------
    if !_WaitForWindowText(hwnd, ["Scan the BOX", "scan the box", "FAILURE", "Invalid"], 10000) {
        ShowTip("Timed out after SP00 -- check ShipApp.", 6000)
        return
    }
    text := WinGetText("ahk_id " hwnd)
    if (InStr(text, "FAILURE") || InStr(text, "Invalid")) {
        ShowTip("ShipApp rejected SP00: " sp00 "`nMay be expired or already used.", 8000)
        return
    }

    ; -- Step 3: send box barcode after settling pause -------------------------
    Sleep(BOX_SEND_DELAY)
    ShowTip("Sending box: " barcode " (" box ")...", 0)
    WinActivate("ahk_id " hwnd)
    _SendBarcode(barcode)

    ; -- Step 4: wait for UN prompt, SUCCESS, or FAILURE ----------------------
    ; Always watch for "Scan the UN" regardless of payload -- ShipApp may prompt
    ; for it even if hazmat was not detected in PackApp.
    if !_WaitForWindowText(hwnd, ["SUCCESS", "success", "FAILURE", "Invalid", "Scan the UN"], 10000) {
        ShowTip("Timed out waiting for result -- check ShipApp.", 6000)
        return
    }

    text := WinGetText("ahk_id " hwnd)

    ; -- Step 5 (hazmat only): send UN barcode ---------------------------------
    if RegExMatch(text, "i)Scan the (UN\d{4})", &m) {
        hBar := hazmatBarcode
        if (hBar = "") {
            ; Fallback: read UN code directly from ShipApp page and look it up
            unCode := m[1]
            hBar := HAZMAT_MAP.Has(unCode) ? HAZMAT_MAP[unCode] : ""
        }
        if (hBar = "") {
            ShowTip("Unknown hazmat type -- check ShipApp.", 6000)
            return
        }

        Sleep(BOX_SEND_DELAY)
        ShowTip("Sending hazmat: " hBar "...", 0)
        WinActivate("ahk_id " hwnd)
        _SendBarcode(hBar)

        ; -- Step 6: wait for final result after hazmat scan -------------------
        if !_WaitForWindowText(hwnd, ["SUCCESS", "success", "FAILURE", "Invalid"], 10000) {
            ShowTip("Timed out after hazmat scan -- check ShipApp.", 6000)
            return
        }
        text := WinGetText("ahk_id " hwnd)
        if (InStr(text, "SUCCESS") || InStr(text, "success")) {
            ShowTip("Shipped!`n" sp00 "  [" box ", " hBar "]`nHazmat label printed. Ready for next order.", 5000)
        } else {
            ShowTip("Hazmat scan failed -- check ShipApp.", 6000)
        }

    } else {
        ; -- Normal (non-hazmat) result ----------------------------------------
        if (InStr(text, "SUCCESS") || InStr(text, "success")) {
            ShowTip("Shipped!`n" sp00 "  [" box " -> " barcode "]`nLabel printed. Ready for next order.", 5000)
        } else {
            ShowTip("Box scan failed -- check ShipApp.", 6000)
        }
    }
}


; ==============================================================================
;  SEND BARCODE
; ==============================================================================

_SendBarcode(barcode) {
    SendText(barcode)
    Send("{Enter}")
    Sleep(50)
}


; ==============================================================================
;  WINDOW HELPERS
; ==============================================================================

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

_FindFirefoxWithText(needle) {
    list := WinGetList("ahk_class MozillaWindowClass")
    for hwnd in list {
        if InStr(WinGetText("ahk_id " hwnd), needle)
            return hwnd
    }
    return 0
}


; ==============================================================================
;  ORDER FILE  (replaces GM_setValue / GM_getValue cross-tab bridge)
;  Flat JSON: {"sp00":"...","box":"...","barcode":"...","hazmat":"...","hazmatBarcode":"...","ts":N}
; ==============================================================================

_WriteOrder(sp00, box, barcode, hazmat := "") {
    ts          := A_TickCount
    hazmatBar   := HAZMAT_MAP.Has(hazmat) ? HAZMAT_MAP[hazmat] : ""
    json        := '{"sp00":"' sp00 '"'
                 . ',"box":"' box '"'
                 . ',"barcode":"' barcode '"'
                 . ',"hazmat":"' hazmat '"'
                 . ',"hazmatBarcode":"' hazmatBar '"'
                 . ',"ts":' ts '}'
    try FileDelete(ORDER_FILE)
    FileAppend(json, ORDER_FILE, "UTF-8")
}

_ReadOrder() {
    if !FileExist(ORDER_FILE)
        return false
    try {
        json  := FileRead(ORDER_FILE, "UTF-8")
        order := _ParseJson(json)
        ts    := order.Has("ts") ? order["ts"] : 0
        if (ts > 0 && (A_TickCount - ts) > ORDER_TTL) {
            _DeleteOrder()
            return false
        }
        return order
    } catch {
        _DeleteOrder()
        return false
    }
}

_DeleteOrder() {
    try FileDelete(ORDER_FILE)
}

; Minimal flat-object JSON parser for {"key":"val","key2":123} format only.
_ParseJson(json) {
    result := Map()
    json   := Trim(json)
    if SubStr(json, 1, 1) = "{"
        json := SubStr(json, 2, StrLen(json) - 2)
    pos := 1
    loop {
        if !RegExMatch(json, '"([^"]+)"\s*:\s*', &m, pos)
            break
        key := m[1]
        pos := m.Pos + m.Len
        if SubStr(json, pos, 1) = '"' {
            if RegExMatch(json, '"((?:[^"\\]|\\.)*)"', &v, pos) {
                result[key] := v[1]
                pos := v.Pos + v.Len
            }
        } else {
            if RegExMatch(json, '(\d+)', &v, pos) {
                result[key] := Integer(v[1])
                pos := v.Pos + v.Len
            }
        }
    }
    return result
}


; ==============================================================================
;  TOOLTIP HELPER
;  Slot 1 = status messages (timed).  Slot 2 = persistent PSLIP banner.
; ==============================================================================

ShowTip(msg, ms := 4000, *) {
    ToolTip(msg)
    if (ms > 0)
        SetTimer(() => ToolTip(), -ms)
}

#Requires AutoHotkey v2.0
#SingleInstance Force

; ==============================================================================
;  FC Pack Automation  --  AutoHotkey v2 background worker
;  OS-level equivalent of Tampermonkey v5.4
;  Requires: AutoHotkey v2.0+  |  Firefox with PackApp + ShipApp open
;
;  HOW IT WORKS:
;   - Global InputHook captures scanner keystrokes from any app.
;   - PackApp side: detects SP00 + box type, writes order to a temp file.
;   - ShipApp side: polls the temp file; when ShipApp shows "Scan the SP",
;     activates its window and sends the barcodes automatically.
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
global POLL_MS         := 400      ; ShipApp order-poll interval (ms)
global PSLIP_POLL_MS   := 600      ; PSLIP prompt watcher interval (ms)
global PACK_POLL_MS    := 100      ; PackApp box-detection poll interval (ms)
global BOX_DETECT_MAX  := 2000     ; max wait for box type in PackApp DOM (ms)
global BOX_SEND_DELAY  := 600      ; pause before sending box barcode (ms)
global ORDER_TTL       := 300000   ; discard orders older than 5 minutes (ms)

; Box type -> ShipApp barcode (mirrors TM v5.4 BOX_MAP)
global BOX_MAP := Map(
    "PB2",   "FSA",
    "PM4",   "FRQ",
    "PM5",   "FRR",
    "OWNBOX","OWNBOX",
    "SIOC",  "OWNBOX"
)

; --- State --------------------------------------------------------------------
global g_buffer       := ""     ; keystroke accumulation buffer
global g_toteScanned  := false  ; true after first tote scan
global g_pslipCode    := ""     ; PSLIP barcode (if scanned)
global g_pslipVisible := false  ; true while PackApp shows "Scan PSLIP"
global g_pendingSP00  := ""     ; SP00 waiting for box detection
global g_pendingTick  := 0      ; TickCount when SP00 was captured
global g_busy         := false  ; true while ShipApp is being driven

; --- Tray icon ----------------------------------------------------------------
A_TrayMenu.Delete()
A_TrayMenu.Add("FC Auto v5  (running)", (*) => {})
A_TrayMenu.Disable("FC Auto v5  (running)")
A_TrayMenu.Add()
A_TrayMenu.Add("Reload", (*) => Reload())
A_TrayMenu.Add("Exit",   (*) => ExitApp())
TraySetIcon("shell32.dll", 46)    ; package/box icon
A_IconTip := "FC Pack Automation v5"

ShowTip("FC Auto v5 started`nMonitoring scanner input.", 3000)

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
SetTimer(_WatchPackApp, PACK_POLL_MS)   ; box detection after SP00
SetTimer(_WatchPslip,   PSLIP_POLL_MS)  ; PSLIP prompt monitor
SetTimer(_PollShipApp,  POLL_MS)        ; ShipApp order dispatch

Persistent   ; keep script alive (no GUI or hotkeys to hold it open)


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
        ; Only classify scans while Firefox is the active window
        if (raw != "" && WinActive("ahk_class MozillaWindowClass"))
            _OnScan(raw)
    }
}


; ==============================================================================
;  SCAN CLASSIFICATION  (mirrors TM v5.4 onScan())
; ==============================================================================

_OnScan(input) {
    global g_toteScanned, g_pslipCode, g_pslipVisible, g_pendingSP00, g_pendingTick

    ; Basic barcode gate: word chars + hyphen, 6-50 chars, no spaces
    ; Filters out URLs, search queries, form text typed manually
    if !RegExMatch(input, "^[\w-]{6,50}$")
        return

    ; -- Tote: first scan that is not SP00 or PSLIP --
    if (!g_toteScanned
        && !RegExMatch(input, "^sp")
        && !RegExMatch(input, "^S[A-Za-z0-9]")) {
        g_toteScanned := true
        ShowTip("Tote scanned -- scan items.", 2000)
        return
    }

    ; -- PSLIP barcode: uppercase S prefix, length >= 8, prompt visible --
    ; PSLIP barcodes start with uppercase S; SP00 always starts with lowercase sp.
    ; The case-sensitive check prevents any confusion between the two.
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
        ; Hand off to box-detection timer (avoids blocking the InputHook thread)
        g_pendingSP00  := input
        g_pendingTick  := A_TickCount
        ShowTip("SP00 captured -- detecting box type...", 2000)
    }
}


; ==============================================================================
;  PACKAPP BOX-DETECTION TIMER  (100ms)
;  After SP00 is captured, polls active Firefox MSAA text for a box keyword.
;  Non-blocking: fires repeatedly until box is found or timeout expires.
; ==============================================================================

_WatchPackApp() {
    global g_pendingSP00, g_pendingTick, g_toteScanned, g_pslipCode

    if (g_pendingSP00 = "")
        return

    ; Check timeout first
    if (A_TickCount - g_pendingTick >= BOX_DETECT_MAX) {
        ShowTip("Box type not detected in PackApp.`nRe-scan SP00 after confirming box appears.", 6000)
        g_pendingSP00 := ""
        return
    }

    hwnd := WinActive("ahk_class MozillaWindowClass")
    if !hwnd
        return   ; Firefox lost focus; keep waiting until timeout

    box := _DetectBox(hwnd)
    if (box = "")
        return   ; not found yet; timer fires again in 100ms

    barcode := BOX_MAP.Has(box) ? BOX_MAP[box] : ""
    if (barcode = "") {
        ShowTip("Unknown box type: " box, 5000)
        g_pendingSP00 := ""
        return
    }

    _WriteOrder(g_pendingSP00, box, barcode)
    ShowTip("Order sent to ShipApp:`n" g_pendingSP00 "  [" box " -> " barcode "]", 4000)
    g_pendingSP00 := ""
    g_toteScanned := false
    g_pslipCode   := ""
}


; ==============================================================================
;  PSLIP WATCHER TIMER  (600ms)
;  Reads active Firefox MSAA text; sets/clears g_pslipVisible.
; ==============================================================================

_WatchPslip() {
    global g_pslipVisible
    hwnd := WinActive("ahk_class MozillaWindowClass")
    if !hwnd
        return
    text       := WinGetText("ahk_id " hwnd)
    nowVisible := RegExMatch(text, "i)scan\s+pslip") != 0
    if (nowVisible && !g_pslipVisible) {
        g_pslipVisible := true
        ; Slot 2 = persistent PSLIP banner (separate from slot 1 status tips)
        ToolTip("PSLIP order -- scan the slip, then scan SP00.`nSlip not printed? Problem Menu: P -> A", , , 2)
    } else if (!nowVisible && g_pslipVisible) {
        g_pslipVisible := false
        ToolTip(, , , 2)   ; clear PSLIP banner
    }
}


; ==============================================================================
;  BOX DETECTION  (reads Firefox accessibility text for box keywords)
; ==============================================================================

_DetectBox(hwnd) {
    text := StrUpper(WinGetText("ahk_id " hwnd))
    for key, _ in BOX_MAP {
        if RegExMatch(text, "\b" key "\b")
            return key
    }
    return ""
}


; ==============================================================================
;  SHIPAPP POLLER TIMER  (400ms)
;  Reads order file; when ShipApp window shows "Scan the SP", processes order.
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
        _DeleteOrder()            ; clear before processing -- prevents duplicate sends
        _ProcessOrder(order, hwnd)
    } finally {
        g_busy := false
    }
}


; ==============================================================================
;  ORDER PROCESSOR
;  Step 1: send SP00  |  Step 2: wait for "Scan the BOX" screen
;  Step 3: send box barcode  |  Step 4: wait for SUCCESS/FAILURE
; ==============================================================================

_ProcessOrder(order, hwnd) {
    sp00    := order["sp00"]
    box     := order["box"]
    barcode := order["barcode"]

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

    ; -- Step 3: send box barcode after settle delay ---------------------------
    Sleep(BOX_SEND_DELAY)
    ShowTip("Sending box: " barcode " (" box ")...", 0)
    WinActivate("ahk_id " hwnd)
    _SendBarcode(barcode)

    ; -- Step 4: wait for result (up to 10s) ----------------------------------
    if !_WaitForWindowText(hwnd, ["SUCCESS", "success", "FAILURE", "Invalid"], 10000) {
        ShowTip("Timed out waiting for result -- check ShipApp.", 6000)
        return
    }
    text := WinGetText("ahk_id " hwnd)
    if (InStr(text, "SUCCESS") || InStr(text, "success")) {
        ShowTip("Shipped!`n" sp00 "  [" box " -> " barcode "]`nLabel printed. Ready for next order.", 5000)
    } else {
        ShowTip("Box scan failed -- check ShipApp.", 6000)
    }
}


; ==============================================================================
;  SEND BARCODE to active window via real OS keystrokes
; ==============================================================================

_SendBarcode(barcode) {
    ; SendText avoids AHK special-char interpretation ({, ^, !, +, #).
    ; Produces real WM_KEYDOWN/WM_CHAR events -- ShipApp's jQuery listener receives them.
    SendText(barcode)
    Send("{Enter}")
    Sleep(50)
}


; ==============================================================================
;  WINDOW HELPERS
; ==============================================================================

; Poll hwnd MSAA text every 100ms until any needle appears, or timeout.
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

; Find a Firefox window (by MSAA text) whose active tab contains needle.
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
;  Flat JSON: {"sp00":"...","box":"...","barcode":"...","ts":NNNNN}
; ==============================================================================

_WriteOrder(sp00, box, barcode) {
    ts   := A_TickCount
    json := '{"sp00":"' sp00 '","box":"' box '","barcode":"' barcode '","ts":' ts '}'
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
; No arrays, no nested objects -- sufficient for our order struct.
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
        if SubStr(json, pos, 1) = '"' {          ; string value
            if RegExMatch(json, '"((?:[^"\\]|\\.)*)"', &v, pos) {
                result[key] := v[1]
                pos := v.Pos + v.Len
            }
        } else {                                  ; number value
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
;  ms = 0 -> tip stays until next ShowTip() call.
; ==============================================================================

ShowTip(msg, ms := 4000, *) {
    ToolTip(msg)
    if (ms > 0)
        SetTimer(() => ToolTip(), -ms)   ; negative delay = run once after ms
}

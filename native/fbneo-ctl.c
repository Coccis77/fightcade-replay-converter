/*
 * fbneo-ctl: drive Fightcade's FBNeo window from the command line.
 * Runs under the same Wine prefix as the emulator (macOS) or natively (Windows).
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MENU_RECORD_AVI 11827
#define MENU_STOP_AVI 11828
#define DEFAULT_FFWD_SCANCODE 0x46
#define TITLE_PREFIX "Fightcade FBNeo"

enum { EXIT_OK = 0, EXIT_USAGE = 1, EXIT_NO_WINDOW = 2, EXIT_FAILED = 3 };

static BOOL CALLBACK listProc(HWND hwnd, LPARAM unused) {
    char title[512];
    char cls[256];
    DWORD pid = 0;
    (void)unused;
    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowTextA(hwnd, title, sizeof title);
    GetClassNameA(hwnd, cls, sizeof cls);
    GetWindowThreadProcessId(hwnd, &pid);
    printf("%p\t%lu\t%s\t%s\n", (void *)hwnd, (unsigned long)pid, cls, title);
    return TRUE;
}

static BOOL CALLBACK findProc(HWND hwnd, LPARAM out) {
    char title[512];
    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowTextA(hwnd, title, sizeof title);
    if (strncmp(title, TITLE_PREFIX, strlen(TITLE_PREFIX)) == 0) {
        *(HWND *)out = hwnd;
        return FALSE;
    }
    return TRUE;
}

static HWND findWindow(void) {
    HWND found = NULL;
    EnumWindows(findProc, (LPARAM)&found);
    return found;
}

#define CODEC_DIALOG_TITLE "Set video compression option"

static int sendMenu(WORD id);

static BOOL CALLBACK childProc(HWND hwnd, LPARAM unused) {
    char cls[256];
    char text[512];
    (void)unused;
    GetClassNameA(hwnd, cls, sizeof cls);
    GetWindowTextA(hwnd, text, sizeof text);
    printf("  id=%d\t%s\t%s\n", GetDlgCtrlID(hwnd), cls, text);
    if (_stricmp(cls, "ComboBox") == 0) {
        LRESULT count = SendMessageA(hwnd, CB_GETCOUNT, 0, 0);
        LRESULT current = SendMessageA(hwnd, CB_GETCURSEL, 0, 0);
        LRESULT i;
        for (i = 0; i < count; i++) {
            char item[512] = "";
            SendMessageA(hwnd, CB_GETLBTEXT, (WPARAM)i, (LPARAM)item);
            printf("    %s[%ld] %s\n", i == current ? "*" : " ", (long)i, item);
        }
    }
    return TRUE;
}

static int describeCodecDialog(void) {
    HWND dialog = FindWindowA(NULL, CODEC_DIALOG_TITLE);
    if (!dialog) return EXIT_NO_WINDOW;
    EnumChildWindows(dialog, childProc, 0);
    return EXIT_OK;
}

/* Recording opens a compressor chooser; keep "Full Frames (Uncompressed)" (index 0) and press OK. */
static int confirmCodecDialog(DWORD timeoutMs, int codecIndex) {
    DWORD start = GetTickCount();
    HWND dialog;
    HWND combo;
    while (!(dialog = FindWindowA(NULL, CODEC_DIALOG_TITLE))) {
        if (GetTickCount() - start >= timeoutMs) {
            fprintf(stderr, "codec dialog did not appear\n");
            return EXIT_NO_WINDOW;
        }
        Sleep(100);
    }
    combo = GetDlgItem(dialog, 880);
    if (combo && SendMessageA(combo, CB_GETCURSEL, 0, 0) != codecIndex) {
        SendMessageA(combo, CB_SETCURSEL, (WPARAM)codecIndex, 0);
        SendMessageA(dialog, WM_COMMAND, MAKEWPARAM(880, CBN_SELCHANGE), (LPARAM)combo);
    }
    if (!PostMessageA(dialog, WM_COMMAND, MAKEWPARAM(IDOK, BN_CLICKED), (LPARAM)GetDlgItem(dialog, IDOK))) {
        fprintf(stderr, "could not confirm codec dialog: %lu\n", (unsigned long)GetLastError());
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

static int startRecording(int codecIndex) {
    int result = sendMenu(MENU_RECORD_AVI);
    if (result != EXIT_OK) return result;
    return confirmCodecDialog(5000, codecIndex);
}

static int usage(void) {
    fprintf(stderr, "usage: fbneo-ctl list | wait [ms] | title | codec-info | record [codec] | stop | ffwd on|off [scancode]\n");
    return EXIT_USAGE;
}

static int sendMenu(WORD id) {
    HWND hwnd = findWindow();
    if (!hwnd) {
        fprintf(stderr, "FBNeo window not found\n");
        return EXIT_NO_WINDOW;
    }
    if (!PostMessageA(hwnd, WM_COMMAND, MAKEWPARAM(id, 0), 0)) {
        fprintf(stderr, "PostMessage failed: %lu\n", (unsigned long)GetLastError());
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

static int sendKey(WORD scancode, BOOL up) {
    INPUT input;
    ZeroMemory(&input, sizeof input);
    input.type = INPUT_KEYBOARD;
    input.ki.wScan = scancode;
    input.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
    if (SendInput(1, &input, sizeof input) != 1) {
        fprintf(stderr, "SendInput failed: %lu\n", (unsigned long)GetLastError());
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

static int waitForWindow(DWORD timeoutMs) {
    DWORD start = GetTickCount();
    while (!findWindow()) {
        if (GetTickCount() - start >= timeoutMs) {
            fprintf(stderr, "timed out waiting for FBNeo window\n");
            return EXIT_NO_WINDOW;
        }
        Sleep(200);
    }
    return EXIT_OK;
}

static int printTitle(void) {
    char title[512];
    HWND hwnd = findWindow();
    if (!hwnd) return EXIT_NO_WINDOW;
    GetWindowTextA(hwnd, title, sizeof title);
    printf("%s\n", title);
    return EXIT_OK;
}

int main(int argc, char **argv) {
    const char *cmd;
    if (argc < 2) return usage();
    cmd = argv[1];
    if (strcmp(cmd, "list") == 0) {
        EnumWindows(listProc, 0);
        return EXIT_OK;
    }
    if (strcmp(cmd, "wait") == 0) return waitForWindow(argc > 2 ? strtoul(argv[2], NULL, 10) : 30000);
    if (strcmp(cmd, "title") == 0) return printTitle();
    if (strcmp(cmd, "codec-info") == 0) return describeCodecDialog();
    if (strcmp(cmd, "activate") == 0) {
        HWND hwnd = findWindow();
        if (!hwnd) return EXIT_NO_WINDOW;
        PostMessageA(hwnd, WM_ACTIVATEAPP, TRUE, 0);
        PostMessageA(hwnd, WM_ACTIVATE, WA_ACTIVE, 0);
        return EXIT_OK;
    }
    if (strcmp(cmd, "record") == 0) return startRecording(argc > 2 ? atoi(argv[2]) : 0);
    if (strcmp(cmd, "stop") == 0) return sendMenu(MENU_STOP_AVI);
    if (strcmp(cmd, "ffwd") == 0 && argc >= 3) {
        WORD scancode = (WORD)(argc > 3 ? strtoul(argv[3], NULL, 0) : DEFAULT_FFWD_SCANCODE);
        if (strcmp(argv[2], "on") == 0) return sendKey(scancode, FALSE);
        if (strcmp(argv[2], "off") == 0) return sendKey(scancode, TRUE);
    }
    return usage();
}

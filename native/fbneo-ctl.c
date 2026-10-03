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

static int usage(void) {
    fprintf(stderr, "usage: fbneo-ctl list | wait [ms] | title | record | stop | ffwd on|off [scancode]\n");
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
    if (strcmp(cmd, "record") == 0) return sendMenu(MENU_RECORD_AVI);
    if (strcmp(cmd, "stop") == 0) return sendMenu(MENU_STOP_AVI);
    if (strcmp(cmd, "ffwd") == 0 && argc >= 3) {
        WORD scancode = (WORD)(argc > 3 ? strtoul(argv[3], NULL, 0) : DEFAULT_FFWD_SCANCODE);
        if (strcmp(argv[2], "on") == 0) return sendKey(scancode, FALSE);
        if (strcmp(argv[2], "off") == 0) return sendKey(scancode, TRUE);
    }
    return usage();
}

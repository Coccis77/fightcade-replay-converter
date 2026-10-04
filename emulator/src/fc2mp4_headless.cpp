// fc2mp4: audio and video plugins used while recording (FC2MP4_* set). Nothing is played or shown:
// FBNeo still fills nAudNextSound and pVidImage each frame, which fc2mp4_dump.cpp writes out.
#include "burner.h"
#include "vid_support.h"

// ---- Audio: the sound buffer FBNeo fills each frame, no device ----
static INT32 SilentBlank()
{
	if (nAudNextSound) memset(nAudNextSound, 0, nAudSegLen << 2);
	return 0;
}

static INT32 SilentInit()
{
	if (nAudSampleRate[0] <= 0) return 1;
	// Same segment length as DirectSound: one frame of 16-bit stereo samples.
	nAudSegLen = (nAudSampleRate[0] * 100 + (nAppVirtualFps >> 1)) / nAppVirtualFps;
	nAudAllocSegLen = nAudSegLen << 2;
	nAudNextSound = (INT16*)malloc(nAudAllocSegLen);
	if (nAudNextSound == NULL) return 1;
	SilentBlank();
	return 0;
}

static INT32 SilentExit()
{
	free(nAudNextSound);
	nAudNextSound = NULL;
	return 0;
}

static INT32 SilentNothing() { return 0; }
static INT32 SilentPlay() { bAudPlaying = 1; return 0; }
static INT32 SilentStop() { bAudPlaying = 0; return 0; }
static INT32 SilentSettings(InterfaceInfo*) { return 0; }

struct AudOut AudOutFc2mp4 = { SilentBlank, SilentInit, SilentExit, SilentNothing, SilentNothing, SilentPlay, SilentStop, SilentNothing, SilentSettings, _T("fc2mp4 recording (silent)") };

// ---- Video: frames drawn in memory, nothing on screen ----
static INT32 MemInit()
{
	// Before a game is loaded FBNeo starts video for its splash screen: succeed without a frame
	// buffer, so the splash is skipped (drawing it into our buffer crashes) and no error popup shows.
	if (!bDrvOkay) {
		VidSFreeVidImage();
		return 0;
	}
	BurnDrvGetVisibleSize(&nVidImageWidth, &nVidImageHeight);
	nVidImageDepth = 32;
	nVidImageBPP = 4;
	if (VidSAllocVidImage()) return 1;
	SetBurnHighCol(nVidImageDepth);	// colour conversion for this depth, as the real blitters do
	return 0;
}

static INT32 MemExit()
{
	VidSFreeVidImage();
	return 0;
}

static INT32 MemFrame(bool bRedraw)
{
	if (pVidImage == NULL || !bDrvOkay) return 1;
	if (bRedraw) {
		if (BurnDrvRedraw()) BurnDrvFrame();
	} else {
		BurnDrvFrame();
	}
	if ((BurnDrvGetFlags() & BDF_16BIT_ONLY) && pVidTransCallback) pVidTransCallback();
	return 0;
}

static INT32 MemPaint(INT32) { return 0; }
static INT32 MemScale(RECT*, INT32, INT32) { return 0; }
static INT32 MemSettings(InterfaceInfo*) { return 0; }

struct VidOut VidOutFc2mp4 = { MemInit, MemExit, MemFrame, MemPaint, MemScale, MemSettings, _T("fc2mp4 recording (memory)") };

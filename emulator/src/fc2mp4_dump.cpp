// fc2mp4: stream every emulated frame (raw rows of pVidImage) to FC2MP4_VIDEO and its audio
// (s16le stereo) to FC2MP4_AUDIO, bypassing the AVI writer. Inactive unless both are set.
#include "burner.h"

static FILE* fVideo = NULL;
static FILE* fAudio = NULL;
static bool bChecked = false;
static bool bActive = false;
static bool bInfoWritten = false;
static UINT32 nDumpedFrames = 0;
static DWORD nLastFrameTick = 0;
static DWORD nIdleMs = 5000;

int Fc2mp4DumpActive()
{
	if (!bChecked) {
		bChecked = true;
		const char* video = getenv("FC2MP4_VIDEO");
		const char* audio = getenv("FC2MP4_AUDIO");
		const char* idle = getenv("FC2MP4_IDLE_MS");
		if (idle && atoi(idle) > 0) {
			nIdleMs = (DWORD)atoi(idle);
		}
		if (video && *video && audio && *audio) {
			fVideo = fopen(video, "wb");	// a FIFO: blocks until the encoder opens it
			fAudio = fopen(audio, "wb");
			bActive = fVideo && fAudio;
		}
	}
	return bActive;
}

static void WriteInfo()
{
	bInfoWritten = true;
	const char* path = getenv("FC2MP4_INFO");
	if (!path || !*path) return;
	FILE* f = fopen(path, "w");
	if (!f) return;
	fprintf(f, "width=%d\nheight=%d\nbpp=%d\nfps_x100=%d\nsample_rate=%d\n",
		nVidImageWidth, nVidImageHeight, nVidImageBPP, nBurnFPS, nBurnSoundRate);
	fclose(f);
}

void Fc2mp4DumpFrame(int bDraw)
{
	if (!Fc2mp4DumpActive() || !bDrvOkay || !bDraw || pVidImage == NULL) return;
	if (!bInfoWritten) WriteInfo();

	INT32 rowBytes = nVidImageWidth * nVidImageBPP;
	for (INT32 y = 0; y < nVidImageHeight; y++) {
		fwrite(pVidImage + y * nVidImagePitch, rowBytes, 1, fVideo);
	}
	if (nAudNextSound) {
		fwrite(nAudNextSound, nBurnSoundLen * 4, 1, fAudio);
	}
	nDumpedFrames++;
	nLastFrameTick = GetTickCount();
}

// True once frames have started and none came for nIdleMs: the replay stream has ended.
int Fc2mp4DumpIdleExpired()
{
	if (!bActive || nDumpedFrames == 0) return 0;
	return GetTickCount() - nLastFrameTick >= nIdleMs;
}

void Fc2mp4DumpEndAndExit()
{
	if (bActive) {
		bActive = false;
		fclose(fVideo);
		fclose(fAudio);
	}
	ExitProcess(0);
}

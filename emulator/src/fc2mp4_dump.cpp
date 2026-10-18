// fc2mp4: stream every emulated frame (raw rows of pVidImage) to FC2MP4_VIDEO and its audio
// (s16le stereo) to FC2MP4_AUDIO, bypassing the AVI writer. Inactive unless both are set.
#include "burner.h"

static FILE* fVideo = NULL;
static FILE* fAudio = NULL;
static bool bChecked = false;
static bool bActive = false;
static bool bInfoWritten = false;
static char szPlayer1[64] = "";
static char szPlayer2[64] = "";
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

// The two player names from the stream's match info (arrives before the first frame), for the video's
// file name. Line breaks would break the info file: they become spaces.
static void CopyPlayer(char* dest, const char* name)
{
	int i = 0;
	for (; name && name[i] && i < 63; i++) dest[i] = (name[i] == '\r' || name[i] == '\n') ? ' ' : name[i];
	dest[i] = '\0';
}

void Fc2mp4DumpSetPlayers(const char* p1, const char* p2)
{
	CopyPlayer(szPlayer1, p1);
	CopyPlayer(szPlayer2, p2);
}

static void WriteInfo()
{
	bInfoWritten = true;
	const char* path = getenv("FC2MP4_INFO");
	if (!path || !*path) return;
	FILE* f = fopen(path, "w");
	if (!f) return;
	// sample_rate stays last: fc2mp4 reads the file once that line is there.
	fprintf(f, "p1=%s\np2=%s\nwidth=%d\nheight=%d\nbpp=%d\nfps_x100=%d\nsample_rate=%d\n",
		szPlayer1, szPlayer2, nVidImageWidth, nVidImageHeight, nVidImageBPP, nBurnFPS, nBurnSoundRate);
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

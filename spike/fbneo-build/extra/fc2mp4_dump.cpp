// fc2mp4: dump every emulated frame (raw pixels) and its audio to files, bypassing the AVI writer.
// Enabled when the FC2MP4_DUMP environment variable is set; files are written to the current directory.
#include "burner.h"

static FILE* fVideo = NULL;
static FILE* fAudio = NULL;
static bool bChecked = false;
static bool bActive = false;
static bool bInfoWritten = false;
static UINT32 nDumpedFrames = 0;

int Fc2mp4DumpActive()
{
	if (!bChecked) {
		bChecked = true;
		const char* flag = getenv("FC2MP4_DUMP");
		if (flag && *flag) {
			fVideo = fopen("video.raw", "wb");
			fAudio = fopen("audio.raw", "wb");
			bActive = fVideo && fAudio;
		}
	}
	return bActive;
}

static void WriteInfo()
{
	FILE* f = fopen("info.txt", "w");
	if (!f) return;
	fprintf(f, "width=%d\nheight=%d\nbpp=%d\nfps_x100=%d\nsample_rate=%d\nchannels=2\n",
		nVidImageWidth, nVidImageHeight, nVidImageBPP, nBurnFPS, nBurnSoundRate);
	fclose(f);
	bInfoWritten = true;
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
	if (++nDumpedFrames % 60 == 0) {
		fflush(fVideo);
		fflush(fAudio);
	}
}

// Called when the replay stream ends: flush everything and mark the dump complete.
void Fc2mp4DumpFinish()
{
	if (!bActive) return;
	if (fVideo) { fclose(fVideo); fVideo = NULL; }
	if (fAudio) { fclose(fAudio); fAudio = NULL; }
	FILE* f = fopen("done.txt", "w");
	if (f) {
		fprintf(f, "frames=%u\n", nDumpedFrames);
		fclose(f);
	}
	bActive = false;
}

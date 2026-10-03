"""fc2mp4's patch set for github.com/fightcadeorg/fightcade-fbneo (see docs/spike-findings.md)."""
from patcher import Patch

DECLARATIONS = (
    'int Fc2mp4DumpActive();\n'
    'void Fc2mp4DumpFrame(int bDraw);\n'
    'int Fc2mp4DumpIdleExpired();\n'
    'void Fc2mp4DumpEndAndExit();\n'
    '\n'
)

PATCHES = [
    # GCC rejects an ordered comparison of a pointer with 0 (MSVC accepts it).
    Patch(
        name='vid-overlay-pointer-compare',
        file='src/intf/video/win32/vid_overlay.cpp',
        anchor='while (ini > 0 && ini < end)',
        replacement='while (ini != 0 && ini < end)',
    ),
    # Every frame must be drawn while dumping, even in the fast-forward loop.
    Patch(
        name='dump-declarations-and-force-draw',
        file='src/burner/win32/run.cpp',
        anchor='int RunFrame(int bDraw, int bPause, int bInput)\n{\n',
        replacement=DECLARATIONS
        + 'int RunFrame(int bDraw, int bPause, int bInput)\n{\n\tif (Fc2mp4DumpActive()) bDraw = 1;\n',
    ),
    # Write the frame and its audio right after it is emulated (next to the AVI writer call).
    Patch(
        name='dump-each-frame',
        file='src/burner/win32/run.cpp',
        anchor='#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {\n\t\t\tif (AviRecordFrame(bDraw)) {',
        replacement='\t\tFc2mp4DumpFrame(bDraw);\n\n'
        '#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {\n\t\t\tif (AviRecordFrame(bDraw)) {',
    ),
    # Run the fast-forward loop while dumping: faster than real time.
    Patch(
        name='fast-forward-while-dumping',
        file='src/burner/win32/run.cpp',
        anchor='\t\tif (bAppDoFast) {\t\t\t\t    // do more frames',
        replacement='\t\tif (bAppDoFast || Fc2mp4DumpActive()) {\t\t\t\t    // do more frames',
    ),
    # The replay stream never disconnects at its end: exit once no frame came for FC2MP4_IDLE_MS.
    Patch(
        name='exit-when-stream-idle',
        file='src/burner/win32/run.cpp',
        anchor='int RunIdle()\n{\n',
        replacement='int RunIdle()\n{\n\tif (Fc2mp4DumpIdleExpired()) {\n\t\tFc2mp4DumpEndAndExit();\n\t}\n',
    ),
    # A real disconnect also ends the dump.
    Patch(
        name='exit-on-stream-disconnect',
        file='src/burner/win32/fbn_ggpo.cpp',
        anchor='void QuarkFinishReplay()\n{\n',
        replacement='int Fc2mp4DumpActive();\nvoid Fc2mp4DumpEndAndExit();\n\n'
        'void QuarkFinishReplay()\n{\n\tif (Fc2mp4DumpActive()) {\n\t\tFc2mp4DumpEndAndExit();\n\t}\n',
    ),
]

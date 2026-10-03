#!/usr/bin/env python3
"""Spike: cross-compile fightcade-fbneo (Win32) on macOS with mingw-w64, from the VS2015 project's file list."""
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_ROOT = os.path.abspath(os.path.join(HERE, '..', 'fcfb'))
PROJ = os.path.join(SRC_ROOT, 'projectfiles', 'visualstudio-2015')
OBJ = os.path.join(HERE, 'obj')
GEN = os.path.join(OBJ, 'generated')
FCADE = '/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo'
CC = 'i686-w64-mingw32-gcc'
CXX = 'i686-w64-mingw32-g++'
WINDRES = 'i686-w64-mingw32-windres'
JOBS = os.cpu_count() or 8

vcx = open(os.path.join(PROJ, 'fbneo_vs2015.vcxproj'), encoding='utf-8-sig').read()


def winpath(p):
    return os.path.normpath(os.path.join(PROJ, p.replace('\\', '/')))


sources = [winpath(m) for m in re.findall(r'<ClCompile Include="([^"]+)"', vcx)]
excluded = {winpath(m) for m in re.findall(r'<ClCompile Include="([^"]+)">\s*<ExcludedFromBuild', vcx)}
sources = [s for s in sources if s not in excluded]
sources = [os.path.join(HERE, 'stubs', 'hq_shared32.cpp') if s.endswith('/scalers/hq_shared32.cpp') else s for s in sources]
sources.append(os.path.join(HERE, 'extra', 'fc2mp4_dump.cpp'))
sources = [os.path.join(GEN, os.path.basename(s)) if '/visualstudio-2015/generated/' in s else s for s in sources]
release = re.search(r"<ItemDefinitionGroup Condition=\"'\$\(Configuration\)\|\$\(Platform\)'=='Release\|Win32'\">(.*?)</ItemDefinitionGroup>", vcx, re.S).group(1)
incs = [winpath(i) for i in re.search(r'<AdditionalIncludeDirectories>([^<]*)', release).group(1).split(';') if i and not i.startswith('%')]
defs = [d for d in re.search(r'<PreprocessorDefinitions>([^<]*)', release).group(1).split(';') if d and not d.startswith('%')]


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stdout}{r.stderr}")
    return r.stdout


PATCHES = [
    ('src/burner/win32/fbn_ggpo.cpp', 'void QuarkFinishReplay()\n{\n',
     'int Fc2mp4DumpActive();\nvoid Fc2mp4DumpFinish();\n\nvoid QuarkFinishReplay()\n{\n\tif (Fc2mp4DumpActive()) {\n\t\tFc2mp4DumpFinish();\n\t\tbMediaExit = true;\n\t}\n'),
    ('src/burner/win32/run.cpp', '\t} else {\n\t\tif (bAppDoFast) {\t\t\t\t    // do more frames',
     '\t} else {\n\t\tif (bAppDoFast || Fc2mp4DumpActive()) {\t\t\t\t    // do more frames'),
    ('src/burner/win32/run.cpp', 'int RunFrame(int bDraw, int bPause, int bInput)\n{\n',
     'int Fc2mp4DumpActive();\nvoid Fc2mp4DumpFrame(int bDraw);\n\nint RunFrame(int bDraw, int bPause, int bInput)\n{\n\tif (Fc2mp4DumpActive()) bDraw = 1;\n'),
    ('src/burner/win32/run.cpp', '#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {',
     'Fc2mp4DumpFrame(bDraw);\n\n#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {'),('src/intf/video/win32/vid_overlay.cpp', 'while (ini > 0 && ini < end)', 'while (ini != 0 && ini < end)')]


def patch_sources():
    for rel, old, new in PATCHES:
        path = os.path.join(SRC_ROOT, rel)
        text = open(path, encoding='latin-1').read()
        if new not in text and old in text:
            open(path, 'w', encoding='latin-1').write(text.replace(old, new))


def generate():
    os.makedirs(GEN, exist_ok=True)
    scripts = os.path.join(SRC_ROOT, 'src', 'dep', 'scripts')
    drv = [s for s in sources if '/src/burn/drv/' in s and s.endswith('.cpp')]
    if not os.path.exists(os.path.join(GEN, 'driverlist.h')):
        run(['perl', os.path.join(scripts, 'gamelist.pl'), '-o', os.path.join(GEN, 'driverlist.h'), '-l', os.path.join(GEN, 'gamelist.txt')] + drv)
    for script, out in [('toa_gp9001_func.pl', 'toa_gp9001_func.h'), ('neo_sprite_func.pl', 'neo_sprite_func.h'),
                        ('cave_tile_func.pl', 'cave_tile_func.h'), ('cave_sprite_func.pl', 'cave_sprite_func.h'),
                        ('psikyo_tile_func.pl', 'psikyo_tile_func.h')]:
        if not os.path.exists(os.path.join(GEN, out)):
            run(['perl', os.path.join(scripts, script), '-o', os.path.join(GEN, out)])
    host = os.path.join(OBJ, 'host')
    os.makedirs(host, exist_ok=True)
    for src, out in [('src/burn/drv/capcom/ctv_make.cpp', 'ctv.h'), ('src/burn/drv/pgm/pgm_sprite_create.cpp', 'pgm_sprite.h'),
                     ('src/dep/scripts/build_details.cpp', 'build_details.h')]:
        if not os.path.exists(os.path.join(GEN, out)):
            exe = os.path.join(host, os.path.basename(src) + '.bin')
            run(['c++', '-O1', '-w', os.path.join(SRC_ROOT, src), '-o', exe])
            open(os.path.join(GEN, out), 'w').write(run([exe]))
    if not os.path.exists(os.path.join(GEN, 'm68kops.c')):
        exe = os.path.join(host, 'm68kmake.bin')
        run(['cc', '-O1', '-w', '-DINLINE=static inline', os.path.join(SRC_ROOT, 'src/cpu/m68k/m68kmake.c'), '-o', exe])
        run([exe, GEN + '/', os.path.join(SRC_ROOT, 'src/cpu/m68k/m68k_in.c')])


def obj_for(src):
    rel = os.path.relpath(src, SRC_ROOT) if src.startswith(SRC_ROOT) else os.path.join('extra', os.path.relpath(src, HERE))
    return os.path.join(OBJ, os.path.splitext(rel)[0] + '.o')


def compile_one(src):
    out = obj_for(src)
    if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(src):
        return None
    os.makedirs(os.path.dirname(out), exist_ok=True)
    is_c = src.endswith('.c')
    cmd = [CC if is_c else CXX, '-c', src, '-o', out, '-O2', '-m32', '-w', '-fpermissive' if not is_c else '-std=gnu99',
           '-fno-strict-aliasing', '-g', '-DUNICODE', '-D_UNICODE', '-D__fastcall=', '-DFASTCALL=']
    if not is_c:
        cmd += ['-std=gnu++17']
    cmd += ['-D' + d.replace('__inline static', 'static inline') for d in defs if not d.startswith('FASTCALL')]
    if not is_c:
        cmd += ['-D__int64=long long']
    if src.endswith('aud_xaudio2.cpp'):
        cmd += ['-I' + os.path.join(SRC_ROOT, 'src/dep/mingw/include/xaudio2')]
    if src.endswith('/burner/luaengine.cpp'):
        cmd += ['-DnSavestateSlot=nLuaSavestateSlot']
    if src.endswith('vid_directx_support.cpp'):
        cmd += ['-finput-charset=CP1252']
    drvdirs = [os.path.join(SRC_ROOT, 'src/burn/drv', d) for d in ('capcom', 'cave', 'neogeo', 'psikyo', 'toaplan')]
    cmd += ['-I' + os.path.dirname(src), '-I' + GEN] + ['-I' + d for d in drvdirs] + ['-I' + i for i in incs] + ['-I' + os.path.join(SRC_ROOT, 'src/dep/mingw/include')]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        return (src, r.stderr)
    return None


def main():
    patch_sources()
    generate()
    todo = sources
    failures = []
    with ThreadPoolExecutor(JOBS) as pool:
        for i, result in enumerate(pool.map(compile_one, todo)):
            if result:
                failures.append(result)
    print(f'{len(todo)} sources, {len(failures)} failed')
    with open(os.path.join(HERE, 'errors.log'), 'w') as log:
        for src, err in failures:
            log.write(f'=== {os.path.relpath(src, SRC_ROOT)}\n{err}\n')
    for src, err in failures[:15]:
        first = next((l for l in err.splitlines() if 'error' in l), err.splitlines()[0] if err else '')
        print(os.path.relpath(src, SRC_ROOT), '::', first[:220])
    if failures:
        return 1
    return link()


def link():
    rc_out = os.path.join(OBJ, 'resource.o')
    rc = os.path.join(SRC_ROOT, 'src/burner/win32/resource.rc')
    scripts = os.path.join(SRC_ROOT, 'src', 'dep', 'scripts')
    if not os.path.exists(os.path.join(GEN, 'license.rtf')):
        run(['perl', os.path.join(scripts, 'license2rtf.pl'), os.path.join(SRC_ROOT, 'src/license.txt'), '-o', os.path.join(GEN, 'license.rtf')])
    if not os.path.exists(os.path.join(GEN, 'app_gnuc.rc')):
        run(['perl', os.path.join(scripts, 'fixrc.pl'), os.path.join(SRC_ROOT, 'src/burner/win32/app.rc'), '-o', os.path.join(GEN, 'app_gnuc.rc')])
    if not os.path.exists(rc_out):
        run([WINDRES, '-DUNICODE', '-D_UNICODE', '-DBUILD_WIN32', '--codepage=1252', '-I' + GEN, '-I' + os.path.dirname(rc),
             '-I' + os.path.join(SRC_ROOT, 'src/burner/win32/resource'), '-I' + os.path.join(SRC_ROOT, 'src/burner'),
             '-I' + os.path.join(SRC_ROOT, 'src/burn'), '-I' + os.path.join(SRC_ROOT, 'src/intf/video/win32'), rc, '-o', rc_out], cwd=os.path.dirname(rc))
    objs = [obj_for(s) for s in sources] + [rc_out]
    exe = os.path.join(HERE, 'fcadefbneo.exe')
    rsp = os.path.join(OBJ, 'objs.rsp')
    open(rsp, 'w').write('\n'.join(objs))
    r = subprocess.run([CXX, '-m32', '-mwindows', '-static', '-O2', '-o', exe, '@' + rsp, os.path.join(FCADE, 'ggponet.dll'),
                        '-ld3dx9_43', '-lksuser', '-ld3d9', '-ldinput8', '-ldsound', '-ldxguid', '-lvfw32', '-lwininet', '-lws2_32', '-lsetupapi',
                        '-lcomdlg32', '-lcomctl32', '-lshell32', '-lshlwapi', '-lwinmm', '-lole32', '-loleaut32', '-luuid',
                        '-ladvapi32', '-lgdi32', '-luser32'], capture_output=True, text=True, errors='replace')
    open(os.path.join(HERE, 'link.log'), 'w').write(r.stdout + r.stderr)
    undefined = sorted(set(re.findall(r"undefined reference to `([^']+)'", r.stderr)))
    print('link exit', r.returncode, '| undefined symbols:', len(undefined))
    for u in undefined[:40]:
        print('  ', u)
    if r.returncode != 0 and not undefined:
        print(r.stderr[-3000:])
    return r.returncode


if __name__ == '__main__':
    sys.exit(main())

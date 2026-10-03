#!/usr/bin/env python3
"""Fetch fightcade-fbneo, apply fc2mp4's patches and cross-compile it for Win32 with mingw-w64.

Self-contained so it can also run in CI later: inputs are a git ref and this folder; outputs are
<out>/fcadefbneo-fc2mp4.exe and <out>/build-info.json.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from patcher import PatchError, apply_patches
from patches import PATCHES

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = 'https://github.com/fightcadeorg/fightcade-fbneo.git'
EXE_NAME = 'fcadefbneo-fc2mp4.exe'
CC = 'i686-w64-mingw32-gcc'
CXX = 'i686-w64-mingw32-g++'
WINDRES = 'i686-w64-mingw32-windres'
EXIT_PATCH, EXIT_BUILD, EXIT_FETCH = 2, 3, 4

PERL_GENERATORS = [
    ('toa_gp9001_func.pl', 'toa_gp9001_func.h'),
    ('neo_sprite_func.pl', 'neo_sprite_func.h'),
    ('cave_tile_func.pl', 'cave_tile_func.h'),
    ('cave_sprite_func.pl', 'cave_sprite_func.h'),
    ('psikyo_tile_func.pl', 'psikyo_tile_func.h'),
]
HOST_GENERATORS = [
    ('src/burn/drv/capcom/ctv_make.cpp', 'ctv.h'),
    ('src/burn/drv/pgm/pgm_sprite_create.cpp', 'pgm_sprite.h'),
    ('src/dep/scripts/build_details.cpp', 'build_details.h'),
]
# Generated headers include *_render.h files that live next to these drivers.
GENERATED_INCLUDE_DIRS = ['capcom', 'cave', 'neogeo', 'psikyo', 'toaplan']
LIBS = ['-ld3dx9_43', '-ld3d9', '-ldinput8', '-ldsound', '-ldxguid', '-lksuser', '-lvfw32', '-lwininet',
        '-lws2_32', '-lsetupapi', '-lcomdlg32', '-lcomctl32', '-lshell32', '-lshlwapi', '-lwinmm',
        '-lole32', '-loleaut32', '-luuid', '-ladvapi32', '-lgdi32', '-luser32']


class BuildError(Exception):
    pass


def run(cmd, cwd=None):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        raise BuildError(f"{' '.join(cmd)}\n{result.stdout}{result.stderr}")
    return result.stdout


def fetch(source_dir, ref):
    if not os.path.isdir(os.path.join(source_dir, '.git')):
        os.makedirs(os.path.dirname(os.path.abspath(source_dir)), exist_ok=True)
        run(['git', 'clone', '--depth', '1', '--branch', ref, REPO, source_dir])
    else:
        run(['git', '-C', source_dir, 'fetch', '--depth', '1', 'origin', ref])
        run(['git', '-C', source_dir, 'checkout', '--force', 'FETCH_HEAD'])
        run(['git', '-C', source_dir, 'clean', '-fdx'])
    return run(['git', '-C', source_dir, 'rev-parse', 'HEAD']).strip()


def project_files(source_root):
    proj = os.path.join(source_root, 'projectfiles', 'visualstudio-2015')
    with open(os.path.join(proj, 'fbneo_vs2015.vcxproj'), encoding='utf-8-sig') as f:
        vcx = f.read()

    def norm(p):
        return os.path.normpath(os.path.join(proj, p.replace('\\', '/')))

    excluded = {norm(m) for m in re.findall(r'<ClCompile Include="([^"]+)">\s*<ExcludedFromBuild', vcx)}
    sources = [norm(m) for m in re.findall(r'<ClCompile Include="([^"]+)"', vcx) if norm(m) not in excluded]
    release = re.search(
        r"<ItemDefinitionGroup Condition=\"'\$\(Configuration\)\|\$\(Platform\)'=='Release\|Win32'\">(.*?)</ItemDefinitionGroup>",
        vcx, re.S).group(1)
    includes = [norm(i) for i in re.search(r'<AdditionalIncludeDirectories>([^<]*)', release).group(1).split(';')
                if i and not i.startswith('%')]
    defines = [d for d in re.search(r'<PreprocessorDefinitions>([^<]*)', release).group(1).split(';')
               if d and not d.startswith('%')]
    return sources, includes, defines


def generate(source_root, gen, host, sources):
    os.makedirs(gen, exist_ok=True)
    os.makedirs(host, exist_ok=True)
    scripts = os.path.join(source_root, 'src', 'dep', 'scripts')

    def missing(name):
        return not os.path.exists(os.path.join(gen, name))

    if missing('driverlist.h'):
        drivers = [s for s in sources if '/src/burn/drv/' in s and s.endswith('.cpp')]
        run(['perl', os.path.join(scripts, 'gamelist.pl'), '-o', os.path.join(gen, 'driverlist.h'),
             '-l', os.path.join(gen, 'gamelist.txt')] + drivers)
    for script, out in PERL_GENERATORS:
        if missing(out):
            run(['perl', os.path.join(scripts, script), '-o', os.path.join(gen, out)])
    for src, out in HOST_GENERATORS:
        if missing(out):
            exe = os.path.join(host, os.path.basename(src) + '.bin')
            run(['c++', '-O1', '-w', os.path.join(source_root, src), '-o', exe])
            with open(os.path.join(gen, out), 'w') as f:
                f.write(run([exe]))
    if missing('m68kops.c'):
        exe = os.path.join(host, 'm68kmake.bin')
        run(['cc', '-O1', '-w', '-DINLINE=static inline', os.path.join(source_root, 'src/cpu/m68k/m68kmake.c'), '-o', exe])
        run([exe, gen + '/', os.path.join(source_root, 'src/cpu/m68k/m68k_in.c')])
    if missing('license.rtf'):
        run(['perl', os.path.join(scripts, 'license2rtf.pl'), os.path.join(source_root, 'src/license.txt'),
             '-o', os.path.join(gen, 'license.rtf')])
    if missing('app_gnuc.rc'):
        run(['perl', os.path.join(scripts, 'fixrc.pl'), os.path.join(source_root, 'src/burner/win32/app.rc'),
             '-o', os.path.join(gen, 'app_gnuc.rc')])


def file_flags(src, source_root):
    """Per-file workarounds for code written for MSVC."""
    flags = []
    if src.endswith('.cpp'):
        flags.append('-D__int64=long long')
    if src.endswith('aud_xaudio2.cpp'):
        # FBNeo's bundled XAudio2 2.7 header (COM); mingw's 2.8 import fails in Fightcade's Wine.
        flags.append('-I' + os.path.join(source_root, 'src/dep/mingw/include/xaudio2'))
    if src.endswith('/burner/luaengine.cpp'):
        # A file-local static that GCC would merge with scrn.cpp's global of the same name.
        flags.append('-DnSavestateSlot=nLuaSavestateSlot')
    if src.endswith('vid_directx_support.cpp'):
        flags.append('-finput-charset=CP1252')
    return flags


def object_path(obj, source_root, src):
    if src.startswith(source_root + os.sep):
        rel = os.path.relpath(src, source_root)
    else:
        rel = os.path.join('fc2mp4', os.path.relpath(src, HERE))
    return os.path.join(obj, os.path.splitext(rel)[0] + '.o')


def compile_all(source_root, obj, gen, sources, includes, defines, jobs):
    drv_includes = ['-I' + os.path.join(source_root, 'src/burn/drv', d) for d in GENERATED_INCLUDE_DIRS]
    common_includes = ['-I' + gen] + drv_includes + ['-I' + i for i in includes] + \
        ['-I' + os.path.join(source_root, 'src/dep/mingw/include')]
    common_defines = ['-D' + d.replace('__inline static', 'static inline') for d in defines if not d.startswith('FASTCALL')]

    def compile_one(src):
        out = object_path(obj, source_root, src)
        if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(src):
            return None
        os.makedirs(os.path.dirname(out), exist_ok=True)
        is_c = src.endswith('.c')
        cmd = [CC if is_c else CXX, '-c', src, '-o', out, '-O2', '-m32', '-w', '-fno-strict-aliasing',
               '-std=gnu99' if is_c else '-std=gnu++17', '-DUNICODE', '-D_UNICODE', '-D__fastcall=', '-DFASTCALL=']
        if not is_c:
            cmd.append('-fpermissive')
        cmd += common_defines + file_flags(src, source_root) + ['-I' + os.path.dirname(src)] + common_includes
        result = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
        return (src, result.stderr) if result.returncode != 0 else None

    with ThreadPoolExecutor(jobs) as pool:
        return [f for f in pool.map(compile_one, sources) if f]


def build(source_root, out_dir, commit, ggponet, jobs):
    sources, includes, defines = project_files(source_root)
    obj = os.path.join(out_dir, 'obj', commit[:12])
    gen = os.path.join(obj, 'generated')
    stub = os.path.join(HERE, 'stubs', 'hq_shared32.cpp')
    sources = [stub if s.endswith('/scalers/hq_shared32.cpp') else s for s in sources]
    sources = [os.path.join(gen, os.path.basename(s)) if '/visualstudio-2015/generated/' in s else s for s in sources]
    sources.append(os.path.join(HERE, 'src', 'fc2mp4_dump.cpp'))
    generate(source_root, gen, os.path.join(obj, 'host'), sources)

    failures = compile_all(source_root, obj, gen, sources, includes, defines, jobs)
    if failures:
        details = '\n'.join(f'=== {os.path.relpath(src, source_root)}\n{err}' for src, err in failures)
        raise BuildError(f'{len(failures)} file(s) failed to compile\n{details}')

    rc = os.path.join(source_root, 'src/burner/win32/resource.rc')
    rc_obj = os.path.join(obj, 'resource.o')
    if not os.path.exists(rc_obj):
        run([WINDRES, '-DUNICODE', '-D_UNICODE', '-DBUILD_WIN32', '--codepage=1252', '-I' + gen,
             '-I' + os.path.dirname(rc), '-I' + os.path.join(source_root, 'src/burner/win32/resource'),
             '-I' + os.path.join(source_root, 'src/burner'), '-I' + os.path.join(source_root, 'src/burn'),
             '-I' + os.path.join(source_root, 'src/intf/video/win32'), rc, '-o', rc_obj], cwd=os.path.dirname(rc))

    objects = [object_path(obj, source_root, s) for s in sources] + [rc_obj]
    rsp = os.path.join(obj, 'objects.rsp')
    with open(rsp, 'w') as f:
        f.write('\n'.join(objects))
    exe = os.path.join(out_dir, EXE_NAME)
    tmp = exe + '.tmp'
    run([CXX, '-m32', '-mwindows', '-static', '-O2', '-s', '-o', tmp, '@' + rsp, ggponet] + LIBS)
    os.replace(tmp, exe)

    for old in os.listdir(os.path.join(out_dir, 'obj')):
        if old != commit[:12]:
            shutil.rmtree(os.path.join(out_dir, 'obj', old), ignore_errors=True)
    return exe


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--ggponet', required=True, help="Fightcade's ggponet.dll (linked against)")
    parser.add_argument('--ref', default='master')
    parser.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    parser.add_argument('--skip-fetch', action='store_true', help='build --source-dir as it is')
    args = parser.parse_args(argv)

    source_dir = os.path.abspath(args.source_dir)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    log_path = os.path.join(out_dir, 'build.log')

    try:
        commit = (run(['git', '-C', source_dir, 'rev-parse', 'HEAD']).strip() if args.skip_fetch
                  else fetch(source_dir, args.ref))
    except BuildError as err:
        print(f'FETCH FAILED: {err}', file=sys.stderr)
        return EXIT_FETCH
    try:
        apply_patches(source_dir, PATCHES)
    except PatchError as err:
        print(f'PATCH FAILED: {err}', file=sys.stderr)
        return EXIT_PATCH
    try:
        exe = build(source_dir, out_dir, commit, os.path.abspath(args.ggponet), args.jobs)
    except BuildError as err:
        with open(log_path, 'w') as f:
            f.write(str(err))
        print(f'BUILD FAILED: see {log_path}', file=sys.stderr)
        return EXIT_BUILD

    info = {'sourceCommit': commit, 'exe': exe, 'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    with open(os.path.join(out_dir, 'build-info.json'), 'w') as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info))
    return 0


if __name__ == '__main__':
    sys.exit(main())

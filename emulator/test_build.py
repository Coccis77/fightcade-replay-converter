import os
import tempfile
import unittest

from build import cache_key


class CacheKeyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, 'src'))
        os.makedirs(os.path.join(self.dir, '__pycache__'))
        self.write('patches.py', 'A')
        self.write('src/fc2mp4_dump.cpp', 'B')

    def write(self, rel, text):
        with open(os.path.join(self.dir, rel), 'w') as f:
            f.write(text)

    def key(self, compiler='gcc 16.2.0'):
        return cache_key('c95950140e2424643a0bb589dc444f0defe03155', self.dir, compiler)

    def test_starts_with_the_source_commit(self):
        self.assertTrue(self.key().startswith('c95950140e24-'))

    def test_changes_when_fc2mp4_sources_change_even_if_mtimes_do_not(self):
        before = self.key()
        path = os.path.join(self.dir, 'src', 'fc2mp4_dump.cpp')
        stat = os.stat(path)
        self.write('src/fc2mp4_dump.cpp', 'C')
        os.utime(path, (stat.st_atime, stat.st_mtime))
        self.assertNotEqual(self.key(), before)

    def test_changes_with_the_compiler_version(self):
        self.assertNotEqual(self.key('gcc 16.2.0'), self.key('gcc 17.1.0'))

    def test_ignores_tests_and_caches(self):
        before = self.key()
        self.write('test_x.py', 'tests')
        self.write('__pycache__/x.pyc', 'cache')
        self.assertEqual(self.key(), before)



class CaseShimTest(unittest.TestCase):
    def test_writes_initguid_shim(self):
        from build import write_case_shims
        d = write_case_shims(os.path.join(tempfile.mkdtemp(), 'shims'))
        with open(os.path.join(d, 'InitGuid.h')) as f:
            self.assertEqual(f.read(), '#include <initguid.h>\n')


class MissingToolsTest(unittest.TestCase):
    def test_reports_missing_tools_and_git_only_when_fetching(self):
        from build import missing_tools
        present = {'perl', 'c++', 'cc', 'i686-w64-mingw32-gcc', 'i686-w64-mingw32-g++', 'i686-w64-mingw32-windres'}
        which = lambda tool: '/usr/bin/' + tool if tool in present else None
        self.assertEqual(missing_tools(True, which), ['git'])
        self.assertEqual(missing_tools(False, which), [])
        present.discard('perl')
        self.assertEqual(missing_tools(False, which), ['perl'])


if __name__ == '__main__':
    unittest.main()

import os
import tempfile
import unittest

from patcher import Patch, PatchError, apply_patch, apply_patches


class ApplyPatchTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'src'))
        self.path = os.path.join(self.root, 'src', 'run.cpp')
        self.write('int RunIdle()\n{\n\treturn 0;\n}\n')

    def write(self, text):
        with open(self.path, 'w', encoding='latin-1', newline='') as f:
            f.write(text)

    def read(self):
        with open(self.path, encoding='latin-1', newline='') as f:
            return f.read()

    def idle_patch(self):
        return Patch('idle-check', 'src/run.cpp', 'int RunIdle()\n{\n', 'int RunIdle()\n{\n\tCheck();\n')

    def test_replaces_the_anchor(self):
        self.assertTrue(apply_patch(self.root, self.idle_patch()))
        self.assertEqual(self.read(), 'int RunIdle()\n{\n\tCheck();\n\treturn 0;\n}\n')

    def test_is_idempotent(self):
        apply_patch(self.root, self.idle_patch())
        self.assertFalse(apply_patch(self.root, self.idle_patch()))
        self.assertEqual(self.read(), 'int RunIdle()\n{\n\tCheck();\n\treturn 0;\n}\n')

    def test_missing_anchor_names_the_patch_and_file(self):
        self.write('int Other()\n{\n}\n')
        with self.assertRaises(PatchError) as ctx:
            apply_patch(self.root, self.idle_patch())
        message = str(ctx.exception)
        self.assertIn('idle-check', message)
        self.assertIn('src/run.cpp', message)
        self.assertIn('not found', message)

    def test_ambiguous_anchor_is_an_error(self):
        self.write('int RunIdle()\n{\n}\nint RunIdle()\n{\n}\n')
        with self.assertRaisesRegex(PatchError, 'found 2 times'):
            apply_patch(self.root, self.idle_patch())

    def test_missing_file_is_an_error(self):
        with self.assertRaisesRegex(PatchError, 'file not found'):
            apply_patch(self.root, Patch('x', 'src/nope.cpp', 'a', 'b'))

    def test_keeps_non_utf8_bytes(self):
        self.write('// caf\xe9\nint RunIdle()\n{\n}\n')
        apply_patch(self.root, self.idle_patch())
        with open(self.path, 'rb') as f:
            self.assertIn(b'caf\xe9', f.read())

    def test_matches_crlf_files_and_keeps_their_line_endings(self):
        self.write('int RunIdle()\r\n{\r\n\treturn 0;\r\n}\r\n')
        self.assertTrue(apply_patch(self.root, self.idle_patch()))
        self.assertEqual(self.read(), 'int RunIdle()\r\n{\r\n\tCheck();\r\n\treturn 0;\r\n}\r\n')
        self.assertFalse(apply_patch(self.root, self.idle_patch()))

    def test_apply_patches_reports_only_changed(self):
        apply_patch(self.root, self.idle_patch())
        other = Patch('ret', 'src/run.cpp', '\treturn 0;\n', '\treturn 1;\n')
        self.assertEqual(apply_patches(self.root, [self.idle_patch(), other]), ['ret'])


class ShippedPatchSetTest(unittest.TestCase):
    def test_patch_set_is_well_formed(self):
        from patches import PATCHES
        names = [p.name for p in PATCHES]
        self.assertEqual(len(names), len(set(names)))
        for p in PATCHES:
            self.assertTrue(p.anchor)
            self.assertNotEqual(p.anchor, p.replacement)


if __name__ == '__main__':
    unittest.main()

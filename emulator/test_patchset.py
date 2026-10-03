import os
import tempfile
import unittest

from patchset import patch_set_hash

FIXTURE_HASH = 'ad8f4307a17afa05c142df8811f108babff53a3509314d60b5196cd9a54894b4'


class PatchSetHashTest(unittest.TestCase):
    def test_matches_the_value_shared_with_the_cli(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, 'src'))
        os.makedirs(os.path.join(d, '__pycache__'))
        for rel, text in [('patches.py', 'A'), ('src/fc2mp4_dump.cpp', 'B'), ('test_x.py', 'ignored'), ('__pycache__/x.pyc', 'ignored')]:
            with open(os.path.join(d, rel), 'w') as f:
                f.write(text)
        self.assertEqual(patch_set_hash(d), FIXTURE_HASH)


if __name__ == '__main__':
    unittest.main()

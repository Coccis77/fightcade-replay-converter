#!/usr/bin/env python3
"""Patch-set hash, shared definition with src/patchSet.ts (CI tags releases with it)."""
import hashlib
import os
import sys


def patch_set_hash(directory):
    entries = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != '__pycache__' and not d.startswith('test_')]
        for name in files:
            if name.startswith('test_'):
                continue
            entries.append(os.path.relpath(os.path.join(root, name), directory).replace(os.sep, '/'))
    digest = hashlib.sha256()
    for rel in sorted(entries):
        digest.update(rel.encode() + b'\0')
        with open(os.path.join(directory, rel), 'rb') as f:
            digest.update(f.read() + b'\0')
    return digest.hexdigest()


if __name__ == '__main__':
    print(patch_set_hash(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))))

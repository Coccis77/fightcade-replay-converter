"""Anchored source patches: each patch replaces one exact snippet that must occur exactly once."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Patch:
    name: str
    file: str
    anchor: str
    replacement: str


class PatchError(Exception):
    pass


def apply_patch(source_root: str, patch: Patch) -> bool:
    """Apply one patch. Returns True if the file changed, False if it was already applied."""
    path = os.path.join(source_root, patch.file)
    if not os.path.exists(path):
        raise PatchError(f'{patch.name}: file not found: {patch.file}')
    # latin-1 round-trips every byte; newline='' keeps line endings untouched.
    with open(path, encoding='latin-1', newline='') as f:
        text = f.read()
    # Patches are written with \n; match files stored with CRLF (fightcade-fbneo uses `* -crlf`).
    anchor, replacement = patch.anchor, patch.replacement
    if '\r\n' in text:
        anchor = anchor.replace('\n', '\r\n')
        replacement = replacement.replace('\n', '\r\n')
    if replacement in text:
        return False
    count = text.count(anchor)
    if count != 1:
        what = 'not found' if count == 0 else f'found {count} times'
        first_line = patch.anchor.splitlines()[0] if patch.anchor.strip() else patch.anchor
        raise PatchError(f'{patch.name}: anchor {what} in {patch.file}: {first_line!r}')
    with open(path, 'w', encoding='latin-1', newline='') as f:
        f.write(text.replace(anchor, replacement))
    return True


def apply_patches(source_root: str, patches) -> list:
    return [p.name for p in patches if apply_patch(source_root, p)]

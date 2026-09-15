#!/usr/bin/env python3

import pathlib
import subprocess
import sys
import zipfile

EXCLUDED_DIRS = {'.github', '.vscode', '.AI_work'}
EXCLUDED_FILES = {
    '.gitignore',
    '.gitattributes',
    '.prettierrc.json',
    '.prettierignore',
    'jsconfig.json',
    'typings.d.ts',
    'AGENTS.md',
}


def tracked_files():
    output = subprocess.check_output(['git', 'ls-files', '-z'])
    for name in output.decode('utf-8').split('\0'):
        if not name:
            continue
        path = pathlib.Path(name)
        if path.parts and path.parts[0] in EXCLUDED_DIRS:
            continue
        if name in EXCLUDED_FILES:
            continue
        yield path


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f'usage: {sys.argv[0]} OUTPUT.zip')

    output = pathlib.Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)

    files = list(tracked_files())
    if not files:
        raise SystemExit('package would be empty')

    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, path.as_posix())

    if output.stat().st_size == 0:
        raise SystemExit('package archive is empty')

    print(f'created {output} with {len(files)} tracked files')


if __name__ == '__main__':
    main()

"""Translate V-Note release labels to ordered VOS SemVer package versions."""
import re
import sys

CORE = r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)'
LABEL = re.compile(rf'({CORE})\.vos\.(0[1-9]|[1-9]\d+)')
PACKAGE = re.compile(rf'({CORE})(?:-vos\.([1-9]\d*))?')


def package_version(label):
    match = LABEL.fullmatch(label)
    if not match:
        raise ValueError('Expected X.Y.Z.vos.NN with a positive sequence')
    return f'{match[1]}-vos.{int(match[5])}'


def version_key(version):
    match = PACKAGE.fullmatch(version) if isinstance(version, str) else None
    if not match:
        raise ValueError(f'Invalid V-Note package version: {version}')
    return (*map(int, match.group(2, 3, 4)), match[5] is None, int(match[5] or 0))


def next_label(upstream, current, refs):
    if not re.fullmatch(CORE, upstream):
        raise ValueError('package.json must contain the merged upstream release version')
    sequence = 0
    published = [version_key(current)]
    for ref in refs:
        tag = ref[len('refs/tags/'):] if ref.startswith('refs/tags/') else ref
        for prefix in ('vos-v-note-v', 'v'):
            if tag.startswith(prefix):
                match = LABEL.fullmatch(tag[len(prefix):])
                if match:
                    published.append(version_key(package_version(match[0])))
                break
    upstream_key = version_key(upstream)
    for key in published:
        if key[:3] > upstream_key[:3] or (key[:3] == upstream_key[:3] and key[3]):
            raise ValueError('Selected upstream would downgrade a VOS release')
        if key[:3] == upstream_key[:3]:
            sequence = max(sequence, key[4])
    return f'{upstream}.vos.{sequence + 1:02}'


def main():
    command, *args = sys.argv[1:]
    if command == 'package':
        print(package_version(*args))
    elif command == 'validate-package':
        version_key(*args)
    elif command == 'next':
        print(next_label(*args, refs=(line.split()[-1] for line in sys.stdin if line.strip())))
    else:
        raise ValueError('Unknown release version command')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from error

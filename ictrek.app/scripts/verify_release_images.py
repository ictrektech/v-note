#!/usr/bin/env python3
"""Verify tested image digests against the selected release and published tags."""
import json
import re
import sys
from pathlib import Path


def resolve(record, version, source, recorded_tags):
    if record.get('version') != version or record.get('source_commit') != source:
        raise ValueError('Image evidence does not match the release source and version')
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Invalid source commit')
    images = record.get('images') or {}
    output = {}
    for key, prefix in [('VNOTE_AMD_IMAGE', 'amd'), ('VNOTE_ARM_IMAGE', 'arm')]:
        tag = f'swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-note:{prefix}_{version}'
        image = images.get(key, '')
        if recorded_tags.get(key) != tag or not re.fullmatch(re.escape(tag) + r'@sha256:[0-9a-f]{64}', image):
            raise ValueError(f'{key}: image digest or Feishu tag mismatch')
        output[key] = image
    return output


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify_release_images.py VERSION SOURCE_COMMIT FEISHU_ENV')
    tags = dict(line.split('=', 1) for line in Path(sys.argv[3]).read_text().splitlines() if line)
    record = json.loads((Path(__file__).resolve().parents[1] / 'release-images.json').read_text())
    for key, value in resolve(record, sys.argv[1], sys.argv[2], tags).items():
        print(f'{key}={value}')


if __name__ == '__main__':
    main()

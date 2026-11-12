#!/usr/bin/env python3
"""Reject a release that could overwrite a published App Store version."""
import json
import re
import sys
import urllib.error
import urllib.request


def check(record, version):
    if record.get('code') == 20207:
        return
    data = record.get('data')
    if record.get('code') != 0 or not isinstance(data, dict):
        raise ValueError('Cannot verify App Store versions')
    if data.get('id') != 'com.ictrek.v-note' or not isinstance(data.get('versions'), list):
        raise ValueError('Unexpected App Store response')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid version')
    existing = []
    for item in data['versions']:
        if not isinstance(item, str) or not re.fullmatch(r'\d+\.\d+\.\d+', item):
            raise ValueError('Unexpected App Store version')
        existing.append(tuple(map(int, item.split('.'))))
    if existing and tuple(map(int, version.split('.'))) <= max(existing):
        raise ValueError('Release version must exceed every App Store version')


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'\d+\.\d+\.\d+', sys.argv[1]):
        raise SystemExit('Usage: check_appstore_version.py X.Y.Z')
    try:
        with urllib.request.urlopen('http://127.0.0.1:18899/api/appstore/apps/com.ictrek.v-note', timeout=30) as response:
            record = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        raise
    check(record, sys.argv[1])
    print('PASS: App Store version is available')


if __name__ == '__main__':
    main()

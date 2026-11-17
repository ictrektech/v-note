#!/usr/bin/env python3
"""Reject a release that could overwrite a published App Store version."""
import json
import sys
import urllib.error
import urllib.request

from release_version import version_key


def check(record, version):
    if record.get('code') == 20207:
        return
    data = record.get('data')
    if record.get('code') != 0 or not isinstance(data, dict):
        raise ValueError('Cannot verify App Store versions')
    if data.get('id') != 'com.ictrek.v-note' or not isinstance(data.get('versions'), list):
        raise ValueError('Unexpected App Store response')
    proposed = version_key(version)
    existing = [version_key(item) for item in data['versions']]
    if existing and proposed <= max(existing):
        raise ValueError('Release version must exceed every App Store version')


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: check_appstore_version.py PACKAGE_VERSION')
    version_key(sys.argv[1])
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

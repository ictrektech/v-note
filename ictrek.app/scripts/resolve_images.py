#!/usr/bin/env python3
"""Resolve the exact release tags recorded in the VOS release spreadsheet."""
import json
import os
import re
import sys
from pathlib import Path
from feishu_release import SPREADSHEET, col_name, request, text

version = sys.argv[1]
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise SystemExit('invalid version')
config_path = Path(os.environ.get('FEISHU_CONFIG_FILE', str(Path.home() / '.feishu.components.json')))
if not config_path.exists():
    config_path = Path.home() / '.feishu.json'
config = json.loads(config_path.read_text())
token = request('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', body={'app_id': config['feishu_app_id'], 'app_secret': config['feishu_app_secret']})['tenant_access_token']
base = 'https://open.feishu.cn/open-apis/sheets'
sheets = request('GET', f'{base}/v3/spreadsheets/{SPREADSHEET}/sheets/query', token)['data']['sheets']
for variable, title, tag in [('VNOTE_AMD_IMAGE', 'AMD_with_mxn100', f'amd_{version}'), ('VNOTE_ARM_IMAGE', 'ARM_without_cuda', f'arm_{version}')]:
    sheet = next(row for row in sheets if row['title'] == title)
    sheet_id = sheet['sheet_id']
    rows = request('GET', f'{base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!A1:ZZ2', token)['data']['valueRange']['values']
    index = next((i for i, value in enumerate(rows[0]) if text(value) == 'v-note'), None)
    if index is None:
        raise SystemExit(f'{title}: v-note column missing')
    repository = text(rows[1][index])
    if repository != 'swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-note':
        raise SystemExit(f'{title}: unexpected repository')
    col = col_name(index + 1)
    values = request('GET', f'{base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!{col}4:{col}2000', token)['data']['valueRange']['values']
    if not any(row and text(row[0]) == tag for row in values):
        raise SystemExit(f'{title}: release tag {tag} missing')
    print(f'{variable}={repository}:{tag}')

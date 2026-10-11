# -*- coding: utf-8 -*-
"""测试 CloudBase HTTP 网关 API 连通性"""
import urllib.request, json, sys

base = 'https://qing-twin-d6g7blx1bbff0c4a4-1503969437.ap-shanghai.app.tcloudbase.com'

def test(path, method='GET', headers=None, body=None):
    url = base + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    h = {'User-Agent': 'Mozilla/5.0'}
    if headers:
        h.update(headers)
    if data is not None:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=40)
        raw = r.read()
        print('==', method, path, '->', r.status)
        print(raw[:600].decode('utf-8', 'ignore'))
    except urllib.error.HTTPError as e:
        print('==', method, path, '-> HTTP', e.code)
        print(e.read()[:600].decode('utf-8', 'ignore'))
    except Exception as e:
        print('==', method, path, '-> ERR', type(e).__name__, e)

# 1. 根路径
test('/')
# 2. books 带 token
test('/api/books', headers={'Authorization': 'Bearer qing2026'})
# 3. books 不带 token（预期 401）
test('/api/books')

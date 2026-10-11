# -*- coding: utf-8 -*-
"""测试 CloudBase 写入 + chat"""
import urllib.request, json

base = 'https://qing-twin-d6g7blx1bbff0c4a4-1503969437.ap-shanghai.app.tcloudbase.com'

def test(path, method='GET', headers=None, body=None):
    url = base + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    h = {'User-Agent': 'Mozilla/5.0'}
    if headers: h.update(headers)
    if data is not None: h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=40)
        print('==', method, path, '->', r.status)
        print(r.read()[:800].decode('utf-8', 'ignore'))
    except urllib.error.HTTPError as e:
        print('==', method, path, '-> HTTP', e.code)
        print(e.read()[:800].decode('utf-8', 'ignore'))
    except Exception as e:
        print('==', method, path, '-> ERR', type(e).__name__, e)

# 1. POST books 写一条测试数据（带 token）
test('/api/books', 'POST', {'Authorization': 'Bearer qing2026'}, {"title": "测试书", "author": "test", "quote": "test", "cover": ""})
# 2. 再读回
test('/api/books', 'GET', {'Authorization': 'Bearer qing2026'})
# 3. chat（缺 DEEPSEEK_API_KEY，预期 500）
test('/api/chat', 'POST', {'Content-Type': 'application/json'}, {"messages": [{"role": "user", "content": "你好"}]})

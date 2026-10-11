# -*- coding: utf-8 -*-
"""端到端测试：chat 接口真正调用 DeepSeek"""
import urllib.request, json, time

base = 'https://qing-twin-d6g7blx1bbff0c4a4-1503969437.ap-shanghai.app.tcloudbase.com'
body = json.dumps({
    "messages": [{"role": "user", "content": "你好，请用一句话介绍你自己"}],
    "stream": True
}).encode('utf-8')
req = urllib.request.Request(base + '/api/chat', data=body, method='POST',
                             headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
t0 = time.time()
try:
    r = urllib.request.urlopen(req, timeout=120)
    print('STATUS', r.status, 'in %.1fs' % (time.time() - t0))
    print('Content-Type:', r.headers.get('content-type'))
    # 读取前 2000 字节 SSE
    chunk = r.read(2000).decode('utf-8', 'ignore')
    print('--- first bytes ---')
    print(chunk[:800])
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read()[:500].decode('utf-8', 'ignore'))
except Exception as e:
    print('ERR', type(e).__name__, e)

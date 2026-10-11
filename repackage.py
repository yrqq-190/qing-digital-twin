# -*- coding: utf-8 -*-
"""用 Python zipfile 重新打包 cloudbase-backend 为标准 zip（内容在根目录）。"""
import os
import zipfile

SRC = r"C:\Users\jh190\Doubao\chats\2026-10-10\new-chat\qing-digital-twin\cloudbase-backend"
OUT = r"C:\Users\jh190\Doubao\chats\2026-10-10\new-chat\qing-digital-twin\cloudbase-backend-fixed.zip"

if os.path.exists(OUT):
    os.remove(OUT)

count = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
    for root, dirs, files in os.walk(SRC):
        # 排除 __pycache__ 等无关目录
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, SRC).replace("\\", "/")
            zf.write(p, rel)
            count += 1

print("entries:", count)
print("size:", os.path.getsize(OUT))

# 验证：重新读取并测试解压到内存
with zipfile.ZipFile(OUT, "r") as z:
    bad = z.testzip()
    names = z.namelist()
    tops = sorted(set(n.split("/")[0] for n in names))
    print("testzip bad:", bad)
    print("top-level:", tops)

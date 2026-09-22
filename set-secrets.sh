#!/usr/bin/env bash
# 交互式填写密钥 —— 值只经终端,不进任何命令行参数/历史/对话记录。
# 用法:cd 到服务目录后 bash set-secrets.sh
#      部署机上:ssh -t vps "bash /opt/annotation-server/set-secrets.sh"
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "缺少 .env"; exit 1; }
read -rsp "GITHUB_CLIENT_ID: "     CI; echo
read -rsp "GITHUB_CLIENT_SECRET: " CS; echo
read -rsp "TYPESAFE_API_KEY: "     TK; echo
[ -n "$CI" ] && [ -n "$CS" ] && [ -n "$TK" ] || { echo "三项都不能为空"; exit 1; }
# 环境变量的名字必须和下面 Python 里查的键一致 —— 两者曾用 CI/CS/TK 对上
# GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/TYPESAFE_API_KEY,于是每次都在 os.environ[k] 抛 KeyError。
GITHUB_CLIENT_ID="$CI" GITHUB_CLIENT_SECRET="$CS" TYPESAFE_API_KEY="$TK" python3 - <<"PY"
import os, pathlib, re
p = pathlib.Path(".env")
t = p.read_text()
for k in ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "TYPESAFE_API_KEY"):
    new, n = re.subn(rf"^{k}=.*$", k + "=" + os.environ[k], t, flags=re.M)
    assert n == 1, k
    t = new
p.write_text(t)
print("已写入 3 项")
PY
chmod 600 .env
echo "剩余空值项:$(grep -c "=$" .env)"
echo "行数与格式自检:"
awk -F= "/^(GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|TYPESAFE_API_KEY)=/{printf \"  %s 长度=%d 前缀=%s\n\", \$1, length(\$2), substr(\$2,1,6)}" .env

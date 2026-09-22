#!/usr/bin/env bash
# 交互式填写密钥 —— 值只经终端,不进任何命令行参数/历史/对话记录。
# 用法:cd 到服务目录后 bash set-secrets.sh
#      部署机上:ssh -t vps "bash /opt/annotation-server/set-secrets.sh"
#
# 顺手做第二件事:把 agent-server 那份 .env 里的 DeepSeek key 复制过来当 LLM 兜底。
# 那份 key 已经在同一台机器上,不需要用户再敲一次,也不会被打印出来。
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "缺少 .env"; exit 1; }

read -rsp "GITHUB_CLIENT_ID: "     CI; echo
read -rsp "GITHUB_CLIENT_SECRET: " CS; echo
read -rsp "TYPESAFE_API_KEY: "     TK; echo
[ -n "$CI" ] && [ -n "$CS" ] && [ -n "$TK" ] || { echo "三项都不能为空"; exit 1; }

# 环境变量的名字必须和下面 Python 里查的键一致 —— 两者曾用 CI/CS/TK 对上
# GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/TYPESAFE_API_KEY,于是每次都在 os.environ[k] 抛 KeyError。
GITHUB_CLIENT_ID="$CI" GITHUB_CLIENT_SECRET="$CS" TYPESAFE_API_KEY="$TK" \
AGENT_ENV="${AGENT_ENV:-/opt/agent-server/.env}" python3 - <<"PY"
import os, pathlib, re, shutil, time

p = pathlib.Path(".env")
shutil.copy2(p, p.with_name(p.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S")))
t = p.read_text()

updates = {
    "GITHUB_CLIENT_ID": os.environ["GITHUB_CLIENT_ID"],
    "GITHUB_CLIENT_SECRET": os.environ["GITHUB_CLIENT_SECRET"],
    "TYPESAFE_API_KEY": os.environ["TYPESAFE_API_KEY"],
}

# ---- DeepSeek 兜底判分 ----
# 模型取 deepseek-flash(deepseek-v4-flash 是它的旧别名,官方文档已改口)。
# 价目表:输入 cache-miss $0.3/Mtok(峰时)、输出 $1.2/Mtok(峰时);谷时减半。
# 预算护栏按峰时价算,不会低估。
# 兼容端点必须走 json 模式:它会静默忽略 output_config.format,结构化输出必然解析失败。
agent_env = pathlib.Path(os.environ["AGENT_ENV"])
ds_key = ""
if agent_env.exists():
    m = re.search(r"^ANTHROPIC_API_KEY=(.+)$", agent_env.read_text(), re.M)
    ds_key = m.group(1).strip() if m else ""
if ds_key:
    updates.update({
        "ANTHROPIC_API_KEY": ds_key,
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "HIGHLIGHT_LLM_MODE": "json",
        "HIGHLIGHT_MODEL": "deepseek-flash",
        "HIGHLIGHT_JUDGE_FALLBACK": "llm",
        "LLM_INPUT_COST_PER_MTOK": "0.3",
        "LLM_OUTPUT_COST_PER_MTOK": "1.2",
    })

done, out = set(), []
for line in t.splitlines():
    m = re.match(r"^([A-Z0-9_]+)=", line)
    if m and m.group(1) in updates:
        out.append(m.group(1) + "=" + updates[m.group(1)])
        done.add(m.group(1))
    else:
        out.append(line)
missing = [k for k in updates if k not in done]
if missing:
    out += ["", "# --- DeepSeek 兜底判分(兼容端点走 json 模式)---"]
    out += [k + "=" + updates[k] for k in missing]
p.write_text("\n".join(out) + "\n")

suffix = "" if ds_key else "(没读到 " + str(agent_env) + ",跳过 DeepSeek 兜底)"
print("已写入 " + str(len(updates)) + " 项" + suffix)
PY

chmod 600 .env
echo "剩余空值项:$(grep -c "=$" .env)"
echo "自检(只给长度与前缀):"
awk -F= '/^(GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|TYPESAFE_API_KEY|ANTHROPIC_API_KEY)=/{printf "  %s 长度=%d 前缀=%s\n", $1, length($2), substr($2,1,6)}' .env
awk -F= '/^(HIGHLIGHT_JUDGE_FALLBACK|ANTHROPIC_BASE_URL|HIGHLIGHT_LLM_MODE|HIGHLIGHT_MODEL|LLM_INPUT_COST_PER_MTOK|LLM_OUTPUT_COST_PER_MTOK)=/{printf "  %s=%s\n", $1, $2}' .env

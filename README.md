# AI-PM Annotation Server

[AI-PM Wiki](https://aipm.ac)的自建批注后端：GitHub OAuth 登录 + 公开/私有批注存储 + 智能高亮 judge。
与 [aipm-agent-server](https://github.com/AI-PM-Wiki/aipm-agent-server)（文档问答后端）并列的第二个自建服务，
在主仓库 [AI-PM-Wiki/AIPM](https://github.com/AI-PM-Wiki/AIPM) 里以子模块 `annotation-server/` 挂载。

> 状态：骨架仓库。服务本体由主仓库的批注系统 workstream 落地（见主仓库 issue #71）。

## 职责

- 替代嵌入的 hypothes.is 客户端，提供自建批注的存储与读取。
- 三种批注：**公开**（访客可读）/ **私有**（仅作者本人，换设备登录同一账号可见）/ **仅本机**（不经过本服务，只存浏览器）。
- 智能高亮 judge：TypeSafe 的 Jev（主）+ LLM（兜底），返回「哪里该高亮、用什么颜色」的建议。

## API 一览

```
GET  /api/auth/github/start?return=<站点内路径>   # 302 → GitHub 授权页
GET  /api/auth/github/callback?code=&state=       # 换 token → 建会话 → 302 回站点
POST /api/auth/session                            # 一次性 code 换 bearer token
GET  /api/auth/me                                 # 当前用户
POST /api/auth/logout                             # 吊销会话

GET    /api/annotations?page=<path>&scope=<public|mine>
POST   /api/annotations                           # 需登录；visibility: public | private
PATCH  /api/annotations/:id                       # 仅作者
DELETE /api/annotations/:id                       # 仅作者
GET    /api/annotations/export?page=<path>        # 导出（公开 + 本人私有）

POST /api/highlight/suggest                       # 不要求登录，靠限流与防滥用兜底

GET  /healthz
```

## 约定

技术栈与 [aipm-agent-server](https://github.com/AI-PM-Wiki/aipm-agent-server) 保持一致，便于两个服务对照维护：

- Node ≥ 22 + TypeScript + ESM，**零框架**（`node:http` 手写路由），不引运行时依赖膨胀。
- 限流 / 并发 / 每日预算 / 请求体上限等护栏照 agent-server 的同名模块实现（各自维护一份，不引跨仓库共享包）。
- 脚本：`npm run build` / `npm run start` / `npm run typecheck` / `npm run unit-check`。
- 部署：Dockerfile 两阶段构建 + docker-compose 绑回环端口（默认 **8788**），公网由系统级 cloudflared 隧道暴露。

## 配置

见 `.env.example`。要点：GitHub OAuth 的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、
TypeSafe 的 `TYPESAFE_API_KEY`、judge 兜底用的 `ANTHROPIC_API_KEY`、
`ALLOWED_ORIGINS`（站点与本地预览）、`TRUST_PROXY`（隧道后取真实 IP）。

## 部署（与 agent-server 同拓扑，端口不同）

1. `cp .env.example .env` 并填密钥。
2. `docker compose up -d --build`。
3. Cloudflare Zero Trust 隧道 ingress 加一条 public hostname 指向 `http://127.0.0.1:8788`。
4. `curl https://<该 hostname>/healthz` 验证。

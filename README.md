# AI-PM Annotation Server

[AI-PM Wiki](https://aipm.ac) 的自建批注后端:GitHub OAuth 登录 + 公开/私有批注存储 + 智能高亮 judge。
与 [aipm-agent-server](https://github.com/AI-PM-Wiki/aipm-agent-server)(文档问答后端)并列的第二个自建服务,
在主仓库 [AI-PM-Wiki/AIPM](https://github.com/AI-PM-Wiki/AIPM) 里以子模块 `annotation-server/` 挂载。

替代原先嵌入的 hypothes.is 客户端:批注数据存在本站自己的服务里,不再依赖第三方。
主仓库 issue [#71](https://github.com/AI-PM-Wiki/AIPM/issues/71) 是这次替换的完整设计。

## 批注的三态与数据边界

| 形态 | 存哪 | 谁能读 | 谁写得了 |
|---|---|---|---|
| **公开** | 本服务 | **任何访客,不登录也能读** | 需 GitHub 登录;只有作者本人能改/删(版主可删) |
| **私有** | 本服务 | **只有作者本人**(换设备登录同一账号可见) | 需 GitHub 登录;只有本人 |
| **仅本机** | 浏览器 localStorage | 只有那台设备 | 匿名即可,**不经过本服务** |

**全页评论**(`target.scope: "page"`)是与上面三态**正交**的第二维:它讲的是锚定粒度,
不是可见范围 —— 一条全页评论同样可以是公开/私有/仅本机。它不锚定正文任何一段文字,
`target.selectors` 为空数组,导出成 hypothes.is 时按 page note 惯例只留 `target.source`。

「私有」与「仅本机」是两件事:前者跨设备(登录同账号就能看到),后者换设备/清缓存即丢。
**本服务没有「仅本机」的写入路径** —— 前端提交 `visibility: "local"` 会被 400 拒绝,
这条边界由 `src/annotations.ts` 的 `normalizeVisibility` 与主仓库的契约测试一起锁住。

几条刻意为之的约束:

- 他人读我的私有批注一律返回 **404 而不是 403** —— 不泄露「这里有一条你看不到的批注」。
- **版主(`MODERATOR_LOGINS`)只多一项「删除公开批注」的能力**:不能读他人私有批注,
  也不能改写任何人的内容。治理能力与阅读权限是两回事。
- **站长(`ADMIN_LOGINS`)只多一项「重新生成智能高亮」的能力**:跳过同页缓存重新判分。
  它与版主是两份名单,互不蕴含。
- 列表接口按登录身份过滤:未登录只能拿 `scope=public`,`scope=mine` 必须登录。

## 鉴权

GitHub OAuth(Web Application Flow,scope 只要 `read:user`,不取 email):

```
GET  /api/auth/github/start?return=<站点 URL>   # 302 → GitHub 授权页
GET  /api/auth/github/callback?code=&state=     # 换 token → 建会话 → 302 回站点
POST /api/auth/session                          # {code} 一次性 code 换 bearer token
GET  /api/auth/me                               # 当前用户
POST /api/auth/logout                           # 吊销会话
```

- **会话是不透明 bearer token**(256 bit 随机),前端存 localStorage、请求带
  `Authorization: Bearer`。**不用跨站 Cookie** —— 站点与后端跨源,第三方 Cookie 会被
  Safari ITP / Chrome 拦掉。
- `client_secret` 只在服务端;OAuth 回跳用**一次性 state(10 分钟)+ 一次性
  `aipm_auth_code`(60 秒)**,于是 token 不出现在 URL、浏览器历史或任何日志里。
- 服务端只存 token 的 sha256;`return` 走来源白名单(开放重定向防护)。
- 本地开发不想建 OAuth App:`DEV_AUTH_BYPASS=true` + `HOST` 为回环地址,
  用 `POST /api/auth/dev` 直接拿 token。**非回环地址上这个开关强制关闭**,
  生产把 HOST 配成 `0.0.0.0` 也不会开后门(见 `src/config.ts` 的 `resolveDevAuthBypass`)。

## 批注 API

```
GET    /api/annotations?page=<path>&scope=<public|mine>   # public 匿名可读;mine 需登录
POST   /api/annotations                                   # 需登录;body.visibility: public|private
GET    /api/annotations/:id                               # 无权读 → 404
PATCH  /api/annotations/:id                               # 需登录 + 仅作者
DELETE /api/annotations/:id                               # 需登录 + 仅作者(版主可删公开)
POST   /api/annotations/:id/replies                       # 需登录 + 能读到即可;body:{body,parentId?}
DELETE /api/annotations/:id/replies/:replyId              # 回复作者,或批注作者
PUT    /api/annotations/:id/like                          # 需登录;幂等
DELETE /api/annotations/:id/like                          # 需登录;幂等
GET    /api/annotations/export?page=<path>                # hypothes.is JSON 兼容导出
```

存储形状按 W3C Web Annotation:`target.selector` 是数组,三种 selector
(`TextQuoteSelector` / `TextPositionSelector` / `RangeSelector`),前端按三级回退锚定,
锚不到时进「孤儿批注」而不是静默丢失。归属按 `author.githubId`(数字 id)判定 ——
不拿 login 当键,login 可以改。

`target.scope: "page"` 标记全页评论(见上表后的说明)。**空 selector 默认仍然被拒绝**:
只有显式声明了 `scope: "page"` 才放行 ——「忘了带锚点」与「就是要整页评论」必须分开,
这道判断在 `src/server.ts` 的 `CreateAnnotationSchema` 与 `normalizeSelectors` 的
`allowEmpty` 两处,主仓库与子仓库各有测试锁住。

### 回复

回复存在批注文档的 `replies` 数组里,但有**两条写入路径**,别混:

- `POST /api/annotations/:id/replies` —— **普通回复走这条**。任何登录用户,只要能读到
  这条批注,就能回。这是「回复」二字的定义:别人回你。
- `PATCH /api/annotations/:id` 的 `replies`(**整数组**语义)—— 仅批注作者,按
  `mergeReplies` 的规则合并,是楼层楼主清理楼内回复的通道。自己的能改、批注作者能删、
  别人的既改不动也删不掉(`reply_forbidden`)。

早先只有 PATCH 这一条路,而 PATCH 是「仅作者」的 —— 结果是**别人根本回不了你的批注**。
`POST` 那条就是为补这个洞加的;`DELETE .../replies/:replyId` 让回复作者与楼主各自能删
自己该删的。

回复可以互相回复:新回复带 `parentId` 指向同一条批注下的另一条回复,父回复必须已存在
(否则 `reply_not_found`)。**删父回复不级联删子回复** —— 别人在它下面的发言不该被连带
抹掉;前端把「找不到父级」的按顶层渲染。

批注的**画法** `style` 与颜色 `color` 正交:`underline`(只画下划线)/ `highlight`
(只铺底色)/ `both`(两者都画)。缺省 `highlight` —— 这也是引入这个字段之前的行为,
所以不带 `style` 的老客户端照常工作;带了但认不出来的才报 `invalid_style`。

### 点赞

`likes` 存的是**点过赞的人的 GitHub 数字 id 列表**,但对外**只回 `likeCount` 与
`likedByMe`**,不回原始名单 —— 谁赞过既是隐私面(能看出谁读了哪一页)又没有展示价值。
`toClientJson` 是唯一的出口,所有返回批注的响应都过它。

`PUT` / `DELETE` 都**幂等**:已赞再赞、未赞再取消都返回成功且不改变计数,客户端重试与
连点不必自己去重。点赞不碰 `updatedAt` —— 点个赞不该让这条显示成「刚编辑过」。
未登录一律 401;读不到的批注(他人的私有)是 **404 而不是 403**,与读权限同规矩。

批注自身的 `body` **允许为空** —— 智能高亮的产出就是「一段被划了线的话」,那本身
就是一个完整的批注,强制写文字会让「采纳建议」变成「必须先写点什么」。回复的正文
仍然不许为空(没有内容的回复没有意义)。

## 智能高亮

```
POST /api/highlight/suggest
  { page, title, palette:[{id,label,when}], blocks:[{id,text}], judge?:"auto"|"jev"|"llm",
    refresh?:boolean }
→ { judge, fallbackFrom?, model?, suggestions[], degraded[], usage?, cached? }
```

**不要求登录**(匿名也能用),靠限流与防滥用兜底。这个端点是整站唯一会花钱的匿名入口,
所以护栏比问答服务更密:

- 每 IP 滑窗限流 + 并发信号量 + 排队 + 请求体上限与体读超时 + Origin 白名单
  (无 Origin 走 `X-API-Key`)+ `TRUST_PROXY` 取真实 IP;
- judge 专属:**每请求块数与字符数硬上限**;`page` 必须是本站路径,且用站内索引
  (`search_index.json`)抽样校验 `blocks` 文本确属该页 —— **防端点被当免费 LLM 代理**;
  两个 provider 各自的每日调用次数上限;每日预算(预占-结算,失败也把已产生的用量算进去);
  429 带 `Retry-After`(前端据此做按钮冷却);每次调用的 provider、块数、token、
  费用写进服务端日志便于对账;同页结果缓存(重复点击不重复计费)。
- 结果**只作建议**:预览 + 单条采纳 + 全部采纳,不静默写入批注数据。
  **批注主功能(选中高亮、写批注)在任何情况下都不依赖 judge。**

### 重新生成(站长)

同页缓存默认优先:这一页判过就摆那一份,连服务端都不再问 provider。要换一份就得
显式要求 —— `refresh: true` 跳过缓存读、重新判分,并把新结果覆盖回同一格缓存。

「这一页判过」有个前提:那一条记录得答得了这次请求。缓存键只有页面粒度,所以每条
记录另带着**这一轮实际判过的块**(coverage)—— 请求里有一块不在覆盖面内,就按未命中
处理,重新判一轮并把整页覆盖回去。没有覆盖面记录的旧记录按未命中处理。

它是整站唯一会为同一页重复花钱的通路,所以单独设闸:**需登录,且 login 在
`ADMIN_LOGINS` 里**(未登录 401、非站长 403)。前端对应的是面板页头那支笔 ——
只有站长手上它才是一颗开关,其余人看到的是一枚静态图标。

绕开的只有缓存那一层:限流、并发与日预算仍在它后面,一次重新生成照样计费。
判分失败时旧缓存原样留着,下一位访客拿到的仍是那份可用结果。

### 两个 provider

| | Jev(TypeSafe System One,主) | LLM(Anthropic,兜底) |
|---|---|---|
| 形态 | 类型化决策 API:`noul` / `choice` / `score` | 提示词进、结构化输出出 |
| 批量 | 一次请求并行问 N 个独立问题,各回各的 key | 一次生成一段输出,自己组织结构 |
| 置信度 | 原生 calibrated confidence(仅作诊断元数据)| 无(自报不可信 → 统一置 `null`) |
| 门槛 | `worth` 概率 ≥ `HIGHLIGHT_WORTH_THRESHOLD` | 同左(自评 0..1) |
| 失败模式 | 429、early access 可能拿不到 key | 超时、JSON 不合法、漏块 |

「该不该高亮 / 用什么颜色 / 多重要」编码成批量 typed questions 再组装,与 LLM 那套是
两套独立适配器;业务逻辑只认统一的 `Suggestion`。路由可配(`HIGHLIGHT_JUDGE_PRIMARY` /
`_FALLBACK`),**实际生效的 provider 与回退来源在响应里可解释**(`judge` / `fallbackFrom`,
前端建议条上标出模型 id)。

**回退只对真失败发生**(超时、限流、HTTP 错误、形状不对、未配置),不按 provider 自报的
confidence 回退。这条是 2026-09-22 按实测改的:原先「本片建议的平均 confidence < 0.6 就
整片改问兜底」,而 Jev 的 confidence 取的是「颜色选择」与「重要度档位」两个答案里较小的
那个 —— 重要度是 4 档量表、颜色是 5 选 1,原生置信度本就常落在 0.3–0.7(首页 32 块均值
0.44、术语表 40 块均值 0.66,正好横跨 0.6)。结果是同一页时而用 Jev、时而整体回退到
兜底模型(贵约 12 倍、慢 10–30 倍),而「这段值不值得高亮」这个真正的判断根本没参与
这次决策。

规则先跑:过短、纯符号、代码块、导航目录、重复标题在任何 provider 之前短路,不花 token。

## 开发

```bash
npm install
npm run typecheck     # 类型检查
npm run unit-check    # 单元检查(109 项;外部依赖全部注入 fake,不联网)
npm run build         # 产出 dist/
npm run dev           # tsx 直跑,读 .env
```

`unit-check` 覆盖纯函数(分块、规则、索引抽样、回复合并、return 白名单、预算跨日)、
两个 provider 的适配与降级、以及端到端 HTTP 语义(三态可见性、归属 401/403/404、
限流与预算、回退与缓存(含落盘后重启复用、覆盖面校验与旧记录兼容)、重新生成的两条
拒绝路径与缓存覆盖、LLM 兜底的两种线上格式(结构化输出 / 抠 JSON))。当前 109 项。

## 配置

见 `.env.example`。要点:

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`:必填(本地开发可用 `DEV_AUTH_BYPASS`)。
  OAuth App 的回调地址必须与 `OAUTH_CALLBACK_URL` 完全一致。
- `TYPESAFE_API_KEY`(主判分)/ `ANTHROPIC_API_KEY`(兜底判分):都可选。
  **两个都没配时智能高亮返回 503 `highlight_not_configured`,批注主功能不受影响**
  —— 这个码专门表示「运维没配好」,重试无意义,前端据此禁用按钮。
  另一种 503 `highlight_unavailable` 表示判分片全挂了(暂时性),带 `Retry-After`,
  前端按它冷却但保留按钮。
- LLM 兜底的两种端点:
  - 官方 `api.anthropic.com`(留空 `ANTHROPIC_BASE_URL`):走 `output_config.format`
    结构化输出,`HIGHLIGHT_LLM_MODE` 默认 `structured`。
  - Anthropic 兼容端点(如 `https://api.deepseek.com/anthropic`):这类端点会
    **静默忽略** `output_config.format`、回普通文本,结构化输出必然解析失败。
    本服务自动切 `json` 模式(普通 `messages.create` + 追问约束 + 自己抠 JSON +
    zod 归一)。显式把 `HIGHLIGHT_LLM_MODE` 写成 `structured` 又配第三方端点会
    **启动即报错**,不留「配了却跑不通」的活口。
  - 走第三方时把 `LLM_INPUT_COST_PER_MTOK` / `LLM_OUTPUT_COST_PER_MTOK` 按它的
    价目表改,否则日预算护栏会算错账。
- 只跑一家 provider(`HIGHLIGHT_JUDGE_FALLBACK=none`)时,主判分器任何一次超时/
  429 都会整页 503。没有第二家兜底就不要设 `none`。
- `JEV_INPUT_COST_PER_MTOK`:Jev 的公开费率 `$42/Btok = $0.042/Mtok`(输出免费,
  见 <https://docs.typesafe.ai/models.md>)。它进成本日志与日预算预占;填 0 会让
  金额护栏对 Jev 完全失效,只剩调用次数上限兜底。
- `ALLOWED_ORIGINS`(站点与本地预览)、`RETURN_ORIGINS`(OAuth 回跳白名单,留空同上)。
- `TRUST_PROXY`:隧道部署必须为 `true`,**且 `TRUSTED_PROXY_IPS` 必须包含 docker
  网桥网关**。容器内看到的直连来源是网桥网关(本服务 compose 固定为 `172.30.0.1`),
  不是 `127.0.0.1`;只写回环的话 `cf-connecting-ip` 被整条忽略、回落到 socket 地址,
  于是**所有请求算同一个 IP**,每 IP 限流退化成全站共享一个桶。自查:`docker logs`
  里出现 `untrusted_proxy_ignored` 就是没配上。
- `DATA_DIR`:存储目录,必须持久化(compose 里挂 `./data:/data`)。
- `ADMIN_LOGINS`:站长名单(逗号分隔,默认 `huangyincan`),决定谁能重新生成智能高亮。
  它与 `MODERATOR_LOGINS` 是两份独立名单。
- `HIGHLIGHT_DAILY_BUDGET_USD` / `HIGHLIGHT_DAILY_CALLS_*`:预算与调用上限,`0` = 关闭。
  注意**调用次数按片计**:最长页面 17 片 = 17 次调用,所以日上限要按片数而不是按
  点击数来估。
- `HIGHLIGHT_MAX_BLOCKS` / `HIGHLIGHT_MAX_CHARS` / `HIGHLIGHT_CHUNK_CONCURRENCY`:
  每请求块数与字符数硬上限、片间并发。取值依据见 `.env.example` 的注释(实测 601 页
  最长 654 块 / 29,639 字符,按两倍留冗余)。**片间并发不是性能优化而是可用性要求**:
  串行跑 17 片会超过 Cloudflare ~100s 的代理超时,而那几页正是抬上限要覆盖的对象。

## 部署(与 agent-server 同拓扑,端口不同)

1. `cp .env.example .env` 并填密钥。
2. `.env` 里 **`HOST` 必须是容器内可绑定的地址**。`.env.example` 给的是
   `HOST=0.0.0.0`(容器内有意义,宿主仍只绑回环):容器内若绑自身回环,compose 的
   `127.0.0.1:8788` 端口映射连不进去,表现为「容器内 healthz 健康、外面 502」。
3. `docker compose up -d --build`(绑回环 `127.0.0.1:8788`,数据落 `./data`)。
4. Cloudflare Zero Trust 隧道 ingress 加一条 public hostname 指向 `http://127.0.0.1:8788`
   (线上用 `anno-api.nvc.ac`;前端 `annotation-store.js` 里写死了这个域名,
   换域名要连它一起改)。
5. `curl https://anno-api.nvc.ac/healthz` 验证。

`/healthz` 会返回索引状态、批注/会话条数、并发水位,以及判分路由与当日预算水位。

## 本地联调

```bash
# 站点自己起(任意端口,记得加进 ALLOWED_ORIGINS)
uv run mkdocs serve -a 127.0.0.1:8010
# .env 里:HOST=127.0.0.1、DEV_AUTH_BYPASS=true、ALLOWED_ORIGINS 含站点 origin
npm start
```

浏览器控制台里换一个会话(不用注册 GitHub OAuth App):

```js
await fetch('http://127.0.0.1:8788/api/auth/dev', { method: 'POST' })
  .then(r => r.json()).then(d => { localStorage.setItem('aipm-anno-auth', JSON.stringify(d)); location.reload() });
```

登出:`localStorage.removeItem('aipm-anno-auth')`。

## 已知限制

- 单实例:预算与调用次数计数是**进程内**状态,重启清零;多实例需要换共享存储。
- 频率限流同样是进程内的;多实例下每实例各算一份。
- 会话与批注落同一个 JSON 文件(原子写 + 进程内索引);批注量级到十万条以上时
  需要换真正的数据库。
- 不做批注分享/协作(私有批注只做「本人跨设备可见」)、不做通知订阅、不做
  hypothes.is 历史数据迁移(只提供兼容导出)。
- `MODERATOR_LOGINS` 只能删**公开**批注,看不到也不动私有批注 —— 版主权限不越
  隐私边界。`ADMIN_LOGINS` 只在智能高亮那条路上多一项重新生成。
- `/healthz` 是监控端点,刻意不带 CORS 头(它是给探测用的,不该被页面脚本读)。
  真实登录走 `/api/auth/github/start` 的整页跳转,不受影响。
- 智能高亮的同页缓存 key 是「页面 + 正文哈希 + judge + 色板版本」。页面正文没变
  时同页各客户端共享缓存;前端给块的 id 取「文档里的位置序号」而非「入选块序号」,
  各客户端的 id↔段落映射因此一致,缓存结果不会被错配到别的段落上。缓存写在
  `DATA_DIR/highlight-cache.json`(TTL 默认 7 天、上限 800 条、原子写),
  重启与重新部署都接着用 —— 一次判分的结果不该只有它自己那一轮进程受益。
  键只有页面粒度,所以每条记录另带**这一轮实际判过的块**(coverage):请求里有一块
  不在覆盖面内就按未命中处理,重新判一轮整页(前端把已经划过线的块从请求里去掉时
  写出的一份子集,不会再把后来的整页请求挡在门外)。升级时不必手动清空缓存文件
  —— 旧记录没有覆盖面,按未命中处理后随 TTL 过期或被新的整页结果覆盖掉。
  `refresh: true`(站长)跳过读缓存并覆盖同一格,所以「缓存优先」与「重新生成」
  合起来正好是这份缓存的完整生命周期。

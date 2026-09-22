/**
 * 环境变量解析与校验。
 *
 * 快速失败:GitHub OAuth 凭据缺失且未开 DEV_AUTH_BYPASS 时 parse 抛错,启动即退出。
 * 例外是智能高亮的两个 provider key —— 它们是可选能力,缺了只降级(503),不拦启动。
 * .env 的加载由入口模块(server.ts)负责,这里保持纯净、可单测。
 */
import { z } from 'zod';

/** 判分 provider 名称。jev = TypeSafe System One;llm = Anthropic Messages。 */
export type JudgeName = 'jev' | 'llm';
export type JudgePrimary = JudgeName;
export type JudgeFallback = JudgeName | 'none';

/**
 * LLM 兜底的线上格式(与 highlight/llm-provider.ts 的 LlmWireMode 一致)。
 * 这里单独声明是为了让 config.ts 不依赖具体 provider 实现,保持可单测的纯函数。
 */
export type LlmWireMode = 'structured' | 'json';

export interface HighlightConfig {
  primary: JudgePrimary;
  fallback: JudgeFallback;
  /**
   * 组装的建议门槛,也是判分质量**唯一**的门槛:provider 给这段文字打的
   * worth 低于它就不下发建议。回退不再看 provider 自报的 confidence。
   */
  worthThreshold: number;

  jevApiKey: string;
  jevBaseUrl: string;
  jevModel: string;
  jevTimeoutMs: number;

  llmApiKey: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTimeoutMs: number;
  /** 留空 = 官方端点;非空时必须是 Anthropic 兼容端点(并要求 llmMode='json')。 */
  llmBaseUrl: string;
  /** structured = 官方结构化输出;json = 纯文本 + 自己解析(兼容端点)。 */
  llmMode: LlmWireMode;

  /** 每请求硬上限(超限 400):防端点被当免费 LLM 代理。 */
  maxBlocksPerRequest: number;
  maxCharsPerRequest: number;
  /** 服务端分片:每片块数与字符数取小者。 */
  chunkBlocks: number;
  chunkChars: number;
  /** 片间并发上限(片之间无依赖;串行会让长页撞代理超时)。 */
  chunkConcurrency: number;
  /** 每页最多下发多少条建议(按 importance 排序截断)。 */
  maxSuggestionsPerPage: number;

  /** 判分专属限流(匿名可用,比批注接口更严)。 */
  rateLimitMax: number;
  rateLimitWindowMs: number;

  /** 每日预算与调用上限(0 = 关闭该护栏)。 */
  dailyBudgetUsd: number;
  dailyCallsJev: number;
  dailyCallsLlm: number;
  /** 计价(USD / 百万 token),用于日志对账;jev 只算输入,输出免费。 */
  llmInputCostPerMtok: number;
  llmOutputCostPerMtok: number;
  jevInputCostPerMtok: number;

  /** 同页结果缓存:key = 页面内容 hash + judge + 色板版本。 */
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

export interface Config {
  port: number;
  host: string;
  siteBase: string;
  allowedOrigins: string[];
  /** OAuth return 白名单(前端站点来源);与 ALLOWED_ORIGINS 分开,便于本地预览另配。 */
  returnOrigins: string[];

  dataDir: string;
  maxAnnotations: number;
  maxAnnotationsPerPage: number;
  maxRepliesPerAnnotation: number;
  maxBodyChars: number;

  bodyLimitBytes: number;
  bodyTimeoutMs: number;

  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** 每账号写入配额(比每 IP 准):窗口内最多写多少条批注。 */
  writeQuotaMax: number;
  writeQuotaWindowMs: number;
  concurrencyLimit: number;
  queueLimit: number;
  queueWaitMs: number;

  apiKey: string;
  trustProxy: boolean;
  trustedProxyIps: string[];

  githubClientId: string;
  githubClientSecret: string;
  githubAuthorizeUrl: string;
  githubTokenUrl: string;
  githubApiBase: string;
  /** 回调地址(必须与 GitHub OAuth App 里登记的一致)。 */
  oauthCallbackUrl: string;

  sessionTtlMs: number;
  /** 一次性 aipm_auth_code 有效期(秒级,防回跳 URL 泄漏后被重放)。 */
  authCodeTtlMs: number;
  /** OAuth state 有效期。 */
  oauthStateTtlMs: number;
  moderatorLogins: string[];

  devAuthBypass: boolean;
  devAuthLogin: string;

  searchIndexUrl: string;
  indexRefreshMs: number;
  /** judge 校验 blocks 属于该页时,抽样比对的字符数。 */
  indexSampleChars: number;

  highlight: HighlightConfig;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  // 绑定地址:默认仅回环 127.0.0.1(bare npm start 不暴露公网);公网暴露需显式 0.0.0.0。
  HOST: z.string().min(1).default('127.0.0.1'),
  SITE_BASE: z.string().url().default('https://aipm.ac'),
  ALLOWED_ORIGINS: z
    .string()
    .default('https://aipm.ac,http://localhost:8000,http://127.0.0.1:8000'),
  // OAuth 回跳允许落回的来源(开放重定向防护)。默认与站点来源一致。
  RETURN_ORIGINS: z.string().default(''),

  DATA_DIR: z.string().min(1).default('./data'),
  MAX_ANNOTATIONS: z.coerce.number().int().min(1).default(20_000),
  MAX_ANNOTATIONS_PER_PAGE: z.coerce.number().int().min(1).default(500),
  MAX_REPLIES_PER_ANNOTATION: z.coerce.number().int().min(0).max(1000).default(200),
  MAX_BODY_CHARS: z.coerce.number().int().min(1).max(20_000).default(4_000),

  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(262_144),
  BODY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(600_000),
  WRITE_QUOTA_MAX: z.coerce.number().int().min(1).default(60),
  WRITE_QUOTA_WINDOW_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  CONCURRENCY_LIMIT: z.coerce.number().int().min(1).max(64).default(8),
  QUEUE_LIMIT: z.coerce.number().int().min(0).max(256).default(16),
  QUEUE_WAIT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),

  // 无 Origin 请求(curl/脚本)须携带 X-API-Key;留空 = 不校验。
  // 浏览器请求由 Origin 白名单覆盖,不受此限。
  API_KEY: z.string().default(''),
  TRUST_PROXY: z.string().default('false'),
  TRUSTED_PROXY_IPS: z.string().default('127.0.0.1,::1,::ffff:127.0.0.1'),

  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GITHUB_AUTHORIZE_URL: z.string().url().default('https://github.com/login/oauth/authorize'),
  GITHUB_TOKEN_URL: z.string().url().default('https://github.com/login/oauth/access_token'),
  GITHUB_API_BASE: z.string().url().default('https://api.github.com'),
  OAUTH_CALLBACK_URL: z
    .string()
    .url()
    .default('http://127.0.0.1:8788/api/auth/github/callback'),

  SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(30 * 24 * 3600 * 1000),
  AUTH_CODE_TTL_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  OAUTH_STATE_TTL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  MODERATOR_LOGINS: z.string().default(''),

  // 仅回环地址生效:非回环(如 HOST=0.0.0.0)时强制关闭,生产配错也不会开后门。
  DEV_AUTH_BYPASS: z.string().default('false'),
  DEV_AUTH_LOGIN: z.string().min(1).default('dev-user'),

  SEARCH_INDEX_URL: z.string().url().default('https://aipm.ac/search/search_index.json'),
  INDEX_REFRESH_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  INDEX_SAMPLE_CHARS: z.coerce.number().int().min(20).max(2_000).default(120),

  HIGHLIGHT_JUDGE_PRIMARY: z.enum(['jev', 'llm']).default('jev'),
  HIGHLIGHT_JUDGE_FALLBACK: z.enum(['jev', 'llm', 'none']).default('llm'),
  HIGHLIGHT_WORTH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),

  TYPESAFE_API_KEY: z.string().default(''),
  TYPESAFE_BASE_URL: z.string().url().default('https://api.typesafe.ai'),
  JEV_MODEL: z.string().min(1).default('jev-latest'),
  JEV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),

  ANTHROPIC_API_KEY: z.string().default(''),
  // 兜底判分的端点。留空 = 官方 api.anthropic.com。
  // 指到 Anthropic 兼容端点(如 https://api.deepseek.com/anthropic)时必须走 json 模式:
  // 2026-09 实测这类端点会**静默忽略** output_config.format、回普通文本,
  // 结构化输出直接解析失败(报 "Failed to parse structured output")。
  ANTHROPIC_BASE_URL: z.string().default(''),
  // 不写就从 base URL 推断(官方 → structured,第三方 → json);
  // 显式写 structured 又配了第三方端点会启动即报错,不留「配了却跑不通」的活口。
  HIGHLIGHT_LLM_MODE: z.enum(['structured', 'json']).optional(),
  // LLM 兜底 judge 的模型:批量分类/抽取型判断,用便宜快速的 haiku 档;
  // 想抬质量把它换成 claude-sonnet-5 / claude-opus-5 即可(计价见下两行)。
  HIGHLIGHT_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  HIGHLIGHT_MAX_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_000),
  HIGHLIGHT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  // 每请求硬上限(超限 400)。取值依据:2026-09 实测全站 601 页,最长的正文是
  // 654 块 / 29,639 字符(pm/monetization、tools/frameworks 那几页),按两倍留冗余。
  // 两个上限必须一起抬 —— 只抬块数会让字符数本就超限的页面从「被截断」变成「400」。
  HIGHLIGHT_MAX_BLOCKS: z.coerce.number().int().min(1).max(2_000).default(1_308),
  HIGHLIGHT_MAX_CHARS: z.coerce.number().int().min(200).max(400_000).default(60_000),
  HIGHLIGHT_CHUNK_BLOCKS: z.coerce.number().int().min(1).max(500).default(40),
  HIGHLIGHT_CHUNK_CHARS: z.coerce.number().int().min(200).max(200_000).default(8_000),
  // 片间并发:片之间没有依赖,但串行跑 17 片会让最长的几页超过 Cloudflare 的
  // ~100s 代理超时(524),而那几页恰恰是抬上限要覆盖的对象。
  HIGHLIGHT_CHUNK_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  HIGHLIGHT_MAX_SUGGESTIONS: z.coerce.number().int().min(1).max(500).default(12),

  // 判分限流:匿名可用,按 IP;比批注接口严(一次判分 = 一次真金白银的模型调用)。
  HIGHLIGHT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  HIGHLIGHT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(600_000),

  // 判分每日护栏(独立于问答服务:两个服务独立部署、各自计价与对账)。
  HIGHLIGHT_DAILY_BUDGET_USD: z.coerce.number().min(0).default(0.5),
  // 一次点击会按片数计次:最长的页面 17 片 = 17 次调用,300 次/日只够约 17 次点击。
  HIGHLIGHT_DAILY_CALLS_JEV: z.coerce.number().int().min(0).default(1_200),
  HIGHLIGHT_DAILY_CALLS_LLM: z.coerce.number().int().min(0).default(200),
  LLM_INPUT_COST_PER_MTOK: z.coerce.number().min(0).default(1),
  LLM_OUTPUT_COST_PER_MTOK: z.coerce.number().min(0).default(5),
  // Jev 的公开费率(USD / 百万输入 token):$42/Btok = $0.042/Mtok,输出免费,
  // 见 https://docs.typesafe.ai/models.md。此前默认 0(当时以为计价未公开),
  // 那会让日预算护栏对 Jev 完全失效 —— 只剩调用次数上限在兜底。
  JEV_INPUT_COST_PER_MTOK: z.coerce.number().min(0).default(0.042),

  // 同页判分结果缓存。key 里有页面内容 hash,所以「内容没变就复用」是安全的:
  // TTL 只用来限制**答案**的陈旧度(判分模型/口径会变),不需要短到分钟级。
  // 默认 7 天 + 落盘(DATA_DIR/highlight-cache.json):一次判分的结果能被这一周里
  // 所有访客复用,重启/重新部署也不丢 —— 匿名端点上的重复请求本就不该重复花钱。
  HIGHLIGHT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(7 * 24 * 3600 * 1000),
  HIGHLIGHT_CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).max(10_000).default(800),
});

function parseBool(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 回环地址判定:dev 后门只在这里生效。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

/**
 * DEV_AUTH_BYPASS 的实际生效值:必须显式开启 **且** 绑定在回环地址上。
 * 生产把 HOST 配成 0.0.0.0 时即便 env 里写着 true 也一律关闭(配置错误不开后门)。
 */
/**
 * 端点是不是官方 Anthropic。留空(true)与 api.anthropic.com 都算官方 ——
 * 只有官方端点实现了 `output_config.format` 结构化输出。
 */
export function isOfficialAnthropicBase(baseUrl: string): boolean {
  if (baseUrl.length === 0) return true;
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

export function resolveDevAuthBypass(host: string, raw: string): boolean {
  if (!parseBool(raw)) return false;
  return isLoopbackHost(host);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败: ${problems}`);
  }
  const e = parsed.data;
  const devAuthBypass = resolveDevAuthBypass(e.HOST, e.DEV_AUTH_BYPASS);
  // 快速失败:没有 GitHub 凭据就必须有 dev 后门,否则登录线整条不可用。
  if (!devAuthBypass && (e.GITHUB_CLIENT_ID.length === 0 || e.GITHUB_CLIENT_SECRET.length === 0)) {
    throw new Error(
      '环境变量校验失败: 缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' +
        '(本地开发可设 DEV_AUTH_BYPASS=true 且 HOST 为回环地址)',
    );
  }

  const llmBaseUrl = e.ANTHROPIC_BASE_URL.trim().replace(/\/+$/, '');
  const officialAnthropic = isOfficialAnthropicBase(llmBaseUrl);
  if (e.HIGHLIGHT_LLM_MODE === 'structured' && !officialAnthropic) {
    throw new Error(
      '环境变量校验失败: ANTHROPIC_BASE_URL 指向了非官方端点,但 HIGHLIGHT_LLM_MODE=structured' +
        ' —— 兼容端点不支持结构化输出(output_config.format 会被静默忽略),请设为 json',
    );
  }
  const llmMode: LlmWireMode =
    e.HIGHLIGHT_LLM_MODE ?? (officialAnthropic ? 'structured' : 'json');

  const allowedOrigins = splitList(e.ALLOWED_ORIGINS);
  const returnOrigins = splitList(e.RETURN_ORIGINS);

  return {
    port: e.PORT,
    host: e.HOST,
    siteBase: e.SITE_BASE.replace(/\/+$/, ''),
    allowedOrigins,
    returnOrigins: returnOrigins.length > 0 ? returnOrigins : allowedOrigins,

    dataDir: e.DATA_DIR,
    maxAnnotations: e.MAX_ANNOTATIONS,
    maxAnnotationsPerPage: e.MAX_ANNOTATIONS_PER_PAGE,
    maxRepliesPerAnnotation: e.MAX_REPLIES_PER_ANNOTATION,
    maxBodyChars: e.MAX_BODY_CHARS,

    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    bodyTimeoutMs: e.BODY_TIMEOUT_MS,

    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    writeQuotaMax: e.WRITE_QUOTA_MAX,
    writeQuotaWindowMs: e.WRITE_QUOTA_WINDOW_MS,
    concurrencyLimit: e.CONCURRENCY_LIMIT,
    queueLimit: e.QUEUE_LIMIT,
    queueWaitMs: e.QUEUE_WAIT_MS,

    apiKey: e.API_KEY,
    trustProxy: parseBool(e.TRUST_PROXY),
    trustedProxyIps: splitList(e.TRUSTED_PROXY_IPS),

    githubClientId: e.GITHUB_CLIENT_ID,
    githubClientSecret: e.GITHUB_CLIENT_SECRET,
    githubAuthorizeUrl: e.GITHUB_AUTHORIZE_URL,
    githubTokenUrl: e.GITHUB_TOKEN_URL,
    githubApiBase: e.GITHUB_API_BASE.replace(/\/+$/, ''),
    oauthCallbackUrl: e.OAUTH_CALLBACK_URL,

    sessionTtlMs: e.SESSION_TTL_MS,
    authCodeTtlMs: e.AUTH_CODE_TTL_MS,
    oauthStateTtlMs: e.OAUTH_STATE_TTL_MS,
    moderatorLogins: splitList(e.MODERATOR_LOGINS).map((s) => s.toLowerCase()),

    devAuthBypass,
    devAuthLogin: e.DEV_AUTH_LOGIN,

    searchIndexUrl: e.SEARCH_INDEX_URL,
    indexRefreshMs: e.INDEX_REFRESH_MS,
    indexSampleChars: e.INDEX_SAMPLE_CHARS,

    highlight: {
      primary: e.HIGHLIGHT_JUDGE_PRIMARY,
      fallback: e.HIGHLIGHT_JUDGE_FALLBACK,
      worthThreshold: e.HIGHLIGHT_WORTH_THRESHOLD,

      jevApiKey: e.TYPESAFE_API_KEY,
      jevBaseUrl: e.TYPESAFE_BASE_URL.replace(/\/+$/, ''),
      jevModel: e.JEV_MODEL,
      jevTimeoutMs: e.JEV_TIMEOUT_MS,

      llmApiKey: e.ANTHROPIC_API_KEY,
      llmModel: e.HIGHLIGHT_MODEL,
      llmMaxTokens: e.HIGHLIGHT_MAX_TOKENS,
      llmTimeoutMs: e.HIGHLIGHT_TIMEOUT_MS,
      llmBaseUrl,
      llmMode,

      maxBlocksPerRequest: e.HIGHLIGHT_MAX_BLOCKS,
      maxCharsPerRequest: e.HIGHLIGHT_MAX_CHARS,
      chunkBlocks: e.HIGHLIGHT_CHUNK_BLOCKS,
      chunkChars: e.HIGHLIGHT_CHUNK_CHARS,
      chunkConcurrency: e.HIGHLIGHT_CHUNK_CONCURRENCY,
      maxSuggestionsPerPage: e.HIGHLIGHT_MAX_SUGGESTIONS,

      rateLimitMax: e.HIGHLIGHT_RATE_LIMIT_MAX,
      rateLimitWindowMs: e.HIGHLIGHT_RATE_LIMIT_WINDOW_MS,

      dailyBudgetUsd: e.HIGHLIGHT_DAILY_BUDGET_USD,
      dailyCallsJev: e.HIGHLIGHT_DAILY_CALLS_JEV,
      dailyCallsLlm: e.HIGHLIGHT_DAILY_CALLS_LLM,
      llmInputCostPerMtok: e.LLM_INPUT_COST_PER_MTOK,
      llmOutputCostPerMtok: e.LLM_OUTPUT_COST_PER_MTOK,
      jevInputCostPerMtok: e.JEV_INPUT_COST_PER_MTOK,

      cacheTtlMs: e.HIGHLIGHT_CACHE_TTL_MS,
      cacheMaxEntries: e.HIGHLIGHT_CACHE_MAX_ENTRIES,
    },
  };
}

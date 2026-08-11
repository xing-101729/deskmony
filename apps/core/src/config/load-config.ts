import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CORE_CONFIG_VERSION,
  CoreConfigFileSchema,
  type ConfigSource,
  type CoreConfig,
  type EffectiveCoreConfig,
  type LogLevel,
} from "@deskmony/shared";

/**
 * load-config.ts(M6 Round A 新增):把原本散落在 `apps/core/src/index.ts`/
 * `apps/core/src/db.ts` 各處零散讀取的 `process.env.DESKMONY_*` 集中到這裡,
 * 改成「分層合併的設定檔」——設計移植自 Paseo 的全域設定,合併順序
 * **defaults → config.json → 環境變數**(這個專案沒有 CLI flags,不需要
 * Paseo 的第四層)。見 packages/shared/src/core-config.ts 頂端的完整背景說明。
 *
 * ---- 家目錄 ----
 * `DESKMONY_HOME` 環境變數(對應 Paseo 的 `PASEO_HOME`)覆寫家目錄,預設
 * `~/.deskmony`;設定檔路徑固定是 `<home>/config.json`。**這個家目錄與
 * `DESKMONY_DATA_DIR`(SQLite 檔案位置)是兩個獨立的概念**——預設剛好都是
 * `~/.deskmony`(與 Paseo 的 `~/.paseo` 同時存放設定檔與其他狀態一致),但各自
 * 可以被獨立的環境變數覆寫而分開,不假設兩者永遠相同。
 *
 * ---- 相容性底線 ----
 * 1. **沒有設定檔時,行為必須與現在完全相同**——`computeDefaultCoreConfig()`
 *    的每一個預設值都必須與 apps/core 這輪之前的既有行為(散落在各檔案的
 *    `?? 預設值`)逐一對應,見該函式內註解。
 * 2. **環境變數優先權不可被破壞**——`DESKMONY_CORE_PORT`/`DESKMONY_BIND_HOST`/
 *    `DESKMONY_AUTH_TOKEN`/`DESKMONY_DATA_DIR`/`DESKMONY_WORKSPACE`/
 *    `DESKMONY_STATIC_DIR`/`DESKMONY_PERMISSION_TIMEOUT_MS`/
 *    `DESKMONY_AUTH_RATE_LIMIT_MAX`/`DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`
 *    全部維持「有設就贏過設定檔」(見 `applyEnvOverrides()`)——e2e 與打包後的
 *    Electron 都靠這些環境變數運作,壞了就是 regression。
 *
 * ---- 安全 ----
 * `DESKMONY_AUTH_TOKEN` 永遠只從環境變數讀(`readAuthTokenFromEnv()`),完全
 * 不是 `CoreConfig`/`EffectiveCoreConfig` 的欄位,`loadConfig()` 回傳的
 * `effective` 物件裡不存在任何可能被序列化成 token 的欄位。設定檔裡任何看起來
 * 像 token 的未知欄位(例如 `daemon.authToken`)在 `scanUnknownKeys()` 這一步
 * 就會被單獨標記、忽略,並印出比一般「未知欄位」更明確的警告(見下方)。
 */

export interface LoadConfigOptions {
  /**
   * `features.staticDir` 沒有被設定檔/環境變數覆寫時的預設值——依 monorepo
   * 佈局從 `apps/core/src/index.ts` 的 `__dirname` 推算,這個算法本身跟
   * OS/部署佈局相關,不屬於這個通用載入器該知道的事,由呼叫端計算好傳入
   * (見 index.ts 呼叫處)。
   */
  defaultStaticDir: string;
}

export interface LoadConfigResult {
  /** 合併後、可直接使用的設定(每個欄位都是最終值,不含來源標記)。 */
  config: CoreConfig;
  /** 合併後 + 每個欄位的來源標記("default"/"file"/"env"),給
   *  `config.getEffective` gateway 方法回傳、SettingsDialog 顯示用。**絕對
   *  不含任何 token**。 */
  effective: EffectiveCoreConfig;
  /** `<home>/config.json` 的絕對路徑(不論檔案是否存在都會回傳,`config.setFile`
   *  在檔案不存在時會在這個路徑建立新檔)。 */
  configPath: string;
  /** 解析後的家目錄(`DESKMONY_HOME` 或預設 `~/.deskmony`)。 */
  homeDir: string;
  /** 認證 token——永遠只從 `DESKMONY_AUTH_TOKEN` 環境變數讀,不是設定檔欄位
   *  (見上方檔案頂端「安全」說明),刻意與 `config`/`effective` 分開回傳,
   *  提醒呼叫端不要把它塞進任何會被序列化出去的設定物件。 */
  authToken: string | undefined;
}

/** 一個有效欄位值 + 來源標記。 */
function field<T>(value: T, source: ConfigSource): { value: T; source: ConfigSource } {
  return { value, source };
}

/**
 * 與作業系統路徑無關欄位的預設值直接來自 `PURE_DEFAULT_CORE_CONFIG`(見
 * packages/shared/src/core-config.ts);這裡另外補上三個依賴 `os.homedir()`/
 * 部署佈局的欄位,逐一對應這輪之前的既有行為:
 *   - `workspace.defaultWorkingDir` ← 舊版 `apps/core/src/index.ts`:
 *     `process.env.DESKMONY_WORKSPACE ?? os.homedir()` 的 `os.homedir()` 分支。
 *   - `data.dataDir` ← 舊版 `apps/core/src/db.ts` 的 `resolveDbPath()`:
 *     `process.env.DESKMONY_DATA_DIR ?? path.join(os.homedir(), ".deskmony")`
 *     的 `path.join(...)` 分支。
 *   - `features.staticDir` ← 舊版 `apps/core/src/index.ts`:
 *     `process.env.DESKMONY_STATIC_DIR?.trim() || path.join(__dirname, "..",
 *     "..", "desktop", "dist")` 的 fallback 分支,由呼叫端算好傳入
 *     (`options.defaultStaticDir`,見上方 `LoadConfigOptions` 註解)——這裡用
 *     `undefined` 表示「維持這個算法」,實際字串在 index.ts 組裝最終
 *     `config.features.staticDir` 前才會補上。
 *   - `workspace.worktreesRoot` 沒有對應的舊行為預設值——這是全新欄位,
 *     `undefined` 代表「維持 WorkspaceManager 既有的動態算法」(見
 *     packages/shared/src/core-config.ts 的 `WorkspaceConfigSchema` 註解),
 *     是一個合法的「使用預設演算法」值,不是「還沒算出來」。
 */
function computeDefaultCoreConfig(): CoreConfig {
  return {
    version: CORE_CONFIG_VERSION,
    daemon: {
      port: 4317,
      bindHost: "127.0.0.1",
      permissionTimeoutMs: 300_000,
      authRateLimit: { max: 5, cooldownMs: 30_000 },
    },
    workspace: {
      defaultWorkingDir: os.homedir(),
      worktreesRoot: undefined,
    },
    data: {
      dataDir: path.join(os.homedir(), ".deskmony"),
    },
    features: {
      staticDir: undefined,
    },
    log: {
      level: "info",
    },
    // S1(PolicyEngine):沒有設定檔時 = 空政策(全部 escalate,見
    // packages/shared/src/core-config.ts 的 `PURE_DEFAULT_CORE_CONFIG.policy` 註解)。
    policy: {
      rules: [],
      allowedHosts: [],
    },
    // S11(Notification):沒有設定檔時 = 桌面通知開、webhook 關(見
    // packages/shared/src/core-config.ts 的 `PURE_DEFAULT_CORE_CONFIG.notification` 註解)。
    notification: {
      desktop: { enabled: true },
      webhook: { url: "", enabled: false, minSeverity: "escalate" },
      batchIntervalMinutes: 20,
      quietHours: undefined,
    },
    // S3b(CostGovernor):沒有設定檔時 = 只有回合硬上限生效(見
    // packages/shared/src/core-config.ts 的 `PURE_DEFAULT_CORE_CONFIG.budget` 註解)。
    budget: {
      task: {},
      daily: {},
      turn: { maxDurationMs: 30 * 60_000, maxToolCalls: 200 },
      warnAtPercent: 80,
      modelPricing: {},
    },
    // S2(message-budget):沒有設定檔時 = maxMessagesPerContext=50(見
    // packages/shared/src/core-config.ts 的 `PURE_DEFAULT_CORE_CONFIG.messageBudget` 註解)。
    messageBudget: {
      maxMessagesPerContext: 50,
      warnAtPercent: 80,
    },
  };
}

export function resolveHomeDir(): string {
  const override = process.env.DESKMONY_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".deskmony");
}

export function resolveConfigPath(homeDir: string): string {
  return path.join(homeDir, "config.json");
}

/** 已知欄位樹(對照 packages/shared/src/core-config.ts 的 `CoreConfigSchema`
 *  形狀,獨立手寫成一份純資料結構,不依賴 zod 內部 shape 存取方式,方便單純
 *  地遞迴比對)。`true` 代表葉節點(具體欄位),物件代表還有下一層。 */
const KNOWN_CONFIG_KEYS: Record<string, true | Record<string, unknown>> = {
  $schema: true,
  version: true,
  daemon: {
    port: true,
    bindHost: true,
    permissionTimeoutMs: true,
    authRateLimit: { max: true, cooldownMs: true },
  },
  workspace: { defaultWorkingDir: true, worktreesRoot: true },
  data: { dataDir: true },
  features: { staticDir: true },
  log: { level: true },
  // S1(PolicyEngine):`rules`/`allowedHosts` 都是葉節點(陣列),不遞迴進陣列
  // 元素內部掃描未知欄位——`scanUnknownKeys()` 對陣列本來就直接 return raw,
  // 不會遞迴(見該函式頂端的 `Array.isArray(raw)` 提早返回),陣列內每個規則
  // 物件的欄位型別驗證交給下面的 zod `PolicyRuleSchema.strict()`。
  policy: { rules: true, allowedHosts: true },
  // S11(Notification):與 `policy` 同等對待——白名單樹狀結構,不是關鍵字比對
  // (見下方 `looksLikeTokenKey()` 只用來標記「未知欄位裡看起來像 token 的」,
  // 這裡的 `webhook.url` 是已知合法欄位,完全不會走到那個檢查,見
  // notification_detail.md §7 檢查清單第 5 項)。
  notification: {
    desktop: { enabled: true },
    webhook: { url: true, enabled: true, minSeverity: true },
    batchIntervalMinutes: true,
    quietHours: { from: true, to: true },
  },
  // S3b(CostGovernor):與 policy/notification 同等對待——白名單樹狀結構。
  budget: {
    task: { maxCostUsd: true, maxTokens: true },
    daily: { maxCostUsd: true, maxTokens: true },
    turn: { maxDurationMs: true, maxToolCalls: true },
    warnAtPercent: true,
    modelPricing: true,
  },
  // S2(message-budget):與 policy/notification/budget 同等對待——白名單樹狀結構。
  messageBudget: {
    maxMessagesPerContext: true,
    warnAtPercent: true,
  },
};

interface UnknownKeyReport {
  /** dot-path,例如 "daemon.authToken"。 */
  path: string;
  /** 欄位名稱本身是否看起來像是想塞認證憑證(見 core-config.ts 頂端「安全
   *  決定」——這份設定檔絕不提供任何 token 欄位)。 */
  looksLikeToken: boolean;
}

function looksLikeTokenKey(key: string): boolean {
  return /token|secret|password|apikey|api_key/i.test(key);
}

/**
 * 遞迴掃描使用者的原始 JSON,找出所有不在 `KNOWN_CONFIG_KEYS` 樹狀結構內的
 * 欄位路徑——這一步發生在任何 zod 型別驗證**之前**,獨立於 zod 的
 * strict/deepPartial 行為(見 core-config.ts 的 `CoreConfigFileSchema` 註解:
 * 這裡才是「未知欄位」判斷的權威來源)。回傳的清單只用來印警告與建構
 * 「已清理」的物件(移除未知欄位後才拿去給 zod 驗證已知欄位的型別),不影響
 * 合併結果——未知欄位一律被忽略,不會出現在最終的 `CoreConfig`/
 * `EffectiveCoreConfig` 裡。
 */
function scanUnknownKeys(
  raw: unknown,
  known: Record<string, true | Record<string, unknown>>,
  pathPrefix: string,
  out: UnknownKeyReport[],
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const knownEntry = known[key];
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (knownEntry === undefined) {
      out.push({ path: fullPath, looksLikeToken: looksLikeTokenKey(key) });
      continue;
    }
    if (knownEntry === true) {
      cleaned[key] = value;
    } else {
      cleaned[key] = scanUnknownKeys(value, knownEntry as Record<string, true | Record<string, unknown>>, fullPath, out);
    }
  }
  return cleaned;
}

/** 讀取/驗證設定檔時的致命錯誤——訊息本身已經足夠明確(含檔案路徑 + 具體
 *  原因),`main()` 的頂層 catch 會把這個 Error 原樣印出後 `process.exit(1)`,
 *  不需要在這裡自己呼叫 `process.exit()`(見 apps/core/src/index.ts)。 */
export class ConfigLoadError extends Error {}

/**
 * 讀取並驗證 `<home>/config.json`(不存在則回傳 `undefined`,這是正常情況,
 * 不是錯誤——沒有設定檔時必須維持既有行為)。
 *
 * 錯誤處理(務必與需求描述保持一致):
 *   - JSON 語法錯誤 → 丟出 `ConfigLoadError`(啟動時明確報錯並結束,見
 *     `main()`)。設定檔是使用者刻意寫的,靜默忽略比直接失敗更糟。
 *   - 已知欄位型別錯誤(例如 `daemon.port` 給字串)→ 同樣丟出
 *     `ConfigLoadError`,訊息包含 zod 回報的欄位路徑與原因。
 *   - 未知欄位 → 不算錯誤,印警告後忽略(向前相容,見 `scanUnknownKeys()`)。
 */
export function readConfigFile(configPath: string): CoreConfigFileParsed | undefined {
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigLoadError(
      `[core] 讀取設定檔失敗(${configPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new ConfigLoadError(
      `[core] 拒絕啟動:設定檔 JSON 格式錯誤(${configPath}): ${err instanceof Error ? err.message : String(err)}\n` +
        "[core] 設定檔是您刻意寫的,格式錯誤時直接拒絕啟動比靜默忽略更安全——請修正 JSON 語法後再重新啟動。",
    );
  }

  const unknownKeys: UnknownKeyReport[] = [];
  const cleaned = scanUnknownKeys(rawJson, KNOWN_CONFIG_KEYS, "", unknownKeys);
  for (const entry of unknownKeys) {
    if (entry.looksLikeToken) {
      console.warn(
        `[core] 警告:設定檔(${configPath})出現疑似認證憑證的欄位 "${entry.path}",已忽略、不會生效。` +
          "Deskmony 的設定檔刻意不提供任何 token/密碼欄位——DESKMONY_AUTH_TOKEN 只能透過環境變數設定(見 README「為何刻意不把 token 放進設定檔」)。",
      );
    } else {
      console.warn(`[core] 警告:設定檔(${configPath})含未知欄位 "${entry.path}",已忽略(向前相容,不影響啟動)。`);
    }
  }

  const parsed = CoreConfigFileSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigLoadError(
      `[core] 拒絕啟動:設定檔(${configPath})的欄位型別不正確:\n${issues}\n` +
        "[core] 請修正上述欄位後再重新啟動,或移除該欄位改用預設值。",
    );
  }
  return parsed.data;
}

type CoreConfigFileParsed = ReturnType<typeof CoreConfigFileSchema.parse>;

/** `DESKMONY_AUTH_TOKEN` 永遠只從環境變數讀,不是設定檔欄位(見檔案頂端
 *  「安全」說明),與 `applyEnvOverrides()` 分開,避免不小心把它併進
 *  `CoreConfig`/`EffectiveCoreConfig`。 */
export function readAuthTokenFromEnv(): string | undefined {
  return process.env.DESKMONY_AUTH_TOKEN?.trim() || undefined;
}

/** 數字型環境變數的容錯解析:未設定 → `undefined`(呼叫端維持上一層的值);
 *  設定但不是有限數字 → 印警告、視同未設定(比「靜默產生 NaN 並繼續往下傳」
 *  更安全,不會有 e2e 依賴這個邊界情況,見 load-config.ts 頂端「相容性底線」
 *  的討論)。 */
function parseFiniteNumberEnv(envVarName: string): number | undefined {
  const raw = process.env[envVarName];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[core] 警告:環境變數 ${envVarName}="${raw}" 不是合法數字,已忽略,改用其他層的值。`);
    return undefined;
  }
  return parsed;
}

/**
 * 把 file 層合併結果(defaults → config.json)套上環境變數覆寫,產生最終的
 * `CoreConfig` + 帶來源標記的 `EffectiveCoreConfig`。**環境變數永遠贏過設定
 * 檔**——這是這個函式存在的唯一理由,任何修改都必須維持這條規則。
 */
function applyEnvOverrides(
  afterFile: CoreConfig,
  fileSources: Record<string, ConfigSource>,
): { config: CoreConfig; effective: EffectiveCoreConfig } {
  const src = (path: string): ConfigSource => fileSources[path] ?? "default";

  // ---- daemon.port ----
  const envPort = parseFiniteNumberEnv("DESKMONY_CORE_PORT");
  const port = envPort !== undefined ? envPort : afterFile.daemon.port;
  const portSource: ConfigSource = envPort !== undefined ? "env" : src("daemon.port");

  // ---- daemon.bindHost ----
  const envBindHostRaw = process.env.DESKMONY_BIND_HOST?.trim();
  const bindHost = envBindHostRaw ? envBindHostRaw : afterFile.daemon.bindHost;
  const bindHostSource: ConfigSource = envBindHostRaw ? "env" : src("daemon.bindHost");

  // ---- daemon.permissionTimeoutMs ----
  const envPermissionTimeoutMs = parseFiniteNumberEnv("DESKMONY_PERMISSION_TIMEOUT_MS");
  const permissionTimeoutMs = envPermissionTimeoutMs !== undefined ? envPermissionTimeoutMs : afterFile.daemon.permissionTimeoutMs;
  const permissionTimeoutMsSource: ConfigSource =
    envPermissionTimeoutMs !== undefined ? "env" : src("daemon.permissionTimeoutMs");

  // ---- daemon.authRateLimit.max/cooldownMs ----
  const envAuthRateLimitMax = parseFiniteNumberEnv("DESKMONY_AUTH_RATE_LIMIT_MAX");
  const authRateLimitMax = envAuthRateLimitMax !== undefined ? envAuthRateLimitMax : afterFile.daemon.authRateLimit.max;
  const authRateLimitMaxSource: ConfigSource =
    envAuthRateLimitMax !== undefined ? "env" : src("daemon.authRateLimit.max");
  const envAuthRateLimitCooldownMs = parseFiniteNumberEnv("DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS");
  const authRateLimitCooldownMs =
    envAuthRateLimitCooldownMs !== undefined ? envAuthRateLimitCooldownMs : afterFile.daemon.authRateLimit.cooldownMs;
  const authRateLimitCooldownMsSource: ConfigSource =
    envAuthRateLimitCooldownMs !== undefined ? "env" : src("daemon.authRateLimit.cooldownMs");

  // ---- workspace.defaultWorkingDir ----
  // 舊行為是 `process.env.DESKMONY_WORKSPACE ?? os.homedir()`——`??` 只在
  // `undefined`/`null` 時才 fallback,環境變數設成空字串也算「有設定」,這裡
  // 刻意逐字複製這個既有語意(不是這輪新引入的行為,不擅自加 trim/空字串檢查)。
  const envWorkspace = process.env.DESKMONY_WORKSPACE;
  const defaultWorkingDir = envWorkspace !== undefined ? envWorkspace : afterFile.workspace.defaultWorkingDir;
  const defaultWorkingDirSource: ConfigSource = envWorkspace !== undefined ? "env" : src("workspace.defaultWorkingDir");

  // ---- workspace.worktreesRoot(沒有對應環境變數,只有 file/default 兩層)----
  const worktreesRoot = afterFile.workspace.worktreesRoot;
  const worktreesRootSource: ConfigSource = src("workspace.worktreesRoot");

  // ---- data.dataDir ----
  // 舊行為(db.ts):`process.env.DESKMONY_DATA_DIR ?? path.join(os.homedir(), ".deskmony")`,
  // 同樣是 `??` 語意,逐字複製。
  const envDataDir = process.env.DESKMONY_DATA_DIR;
  const dataDir = envDataDir !== undefined ? envDataDir : afterFile.data.dataDir;
  const dataDirSource: ConfigSource = envDataDir !== undefined ? "env" : src("data.dataDir");

  // ---- features.staticDir ----
  // 舊行為(index.ts):`process.env.DESKMONY_STATIC_DIR?.trim() || 預設值`,
  // trim 後空字串視為未設定,逐字複製。
  const envStaticDirRaw = process.env.DESKMONY_STATIC_DIR?.trim();
  const staticDir = envStaticDirRaw ? envStaticDirRaw : afterFile.features.staticDir;
  const staticDirSource: ConfigSource = envStaticDirRaw ? "env" : src("features.staticDir");

  // ---- log.level(沒有對應環境變數,只有 file/default 兩層)----
  const logLevel = afterFile.log.level;
  const logLevelSource: ConfigSource = src("log.level");

  // ---- policy.rules / policy.allowedHosts(沒有對應環境變數,只有 file/default
  // 兩層——刻意如此:安全罩本身不透過環境變數覆寫,只能透過本機編輯設定檔,
  // 見 core-config.ts 的 `ConfigSetFilePatchSchema` 註解與 F4)。
  const policyRules = afterFile.policy.rules;
  const policyRulesSource: ConfigSource = src("policy.rules");
  const policyAllowedHosts = afterFile.policy.allowedHosts;
  const policyAllowedHostsSource: ConfigSource = src("policy.allowedHosts");

  // ---- notification.*(沒有對應環境變數,只有 file/default 兩層——刻意
  // 如此,理由與 policy 相同:webhook url 是能對外送資料的能力,不透過環境
  // 變數覆寫,只能靠本機編輯設定檔,見 core-config.ts 的
  // `ConfigSetFilePatchSchema` 註解與 F4)。
  const notificationDesktopEnabled = afterFile.notification.desktop.enabled;
  const notificationDesktopEnabledSource: ConfigSource = src("notification.desktop.enabled");
  const notificationWebhookUrl = afterFile.notification.webhook.url;
  const notificationWebhookUrlSource: ConfigSource = src("notification.webhook.url");
  const notificationWebhookEnabled = afterFile.notification.webhook.enabled;
  const notificationWebhookEnabledSource: ConfigSource = src("notification.webhook.enabled");
  const notificationWebhookMinSeverity = afterFile.notification.webhook.minSeverity;
  const notificationWebhookMinSeveritySource: ConfigSource = src("notification.webhook.minSeverity");
  const notificationBatchIntervalMinutes = afterFile.notification.batchIntervalMinutes;
  const notificationBatchIntervalMinutesSource: ConfigSource = src("notification.batchIntervalMinutes");
  const notificationQuietHours = afterFile.notification.quietHours;
  const notificationQuietHoursSource: ConfigSource = src("notification.quietHours");

  // ---- budget.*(S3b:CostGovernor,沒有對應環境變數,只有 file/default 兩層
  // ——理由與 policy/notification 相同:安全罩本身不透過環境變數覆寫,只能靠
  // 本機編輯設定檔,見 core-config.ts 的 `ConfigSetFilePatchSchema` 註解與 F4)。
  const budgetTaskMaxCostUsd = afterFile.budget.task.maxCostUsd;
  const budgetTaskMaxCostUsdSource: ConfigSource = src("budget.task.maxCostUsd");
  const budgetTaskMaxTokens = afterFile.budget.task.maxTokens;
  const budgetTaskMaxTokensSource: ConfigSource = src("budget.task.maxTokens");
  const budgetDailyMaxCostUsd = afterFile.budget.daily.maxCostUsd;
  const budgetDailyMaxCostUsdSource: ConfigSource = src("budget.daily.maxCostUsd");
  const budgetDailyMaxTokens = afterFile.budget.daily.maxTokens;
  const budgetDailyMaxTokensSource: ConfigSource = src("budget.daily.maxTokens");
  const budgetTurnMaxDurationMs = afterFile.budget.turn.maxDurationMs;
  const budgetTurnMaxDurationMsSource: ConfigSource = src("budget.turn.maxDurationMs");
  const budgetTurnMaxToolCalls = afterFile.budget.turn.maxToolCalls;
  const budgetTurnMaxToolCallsSource: ConfigSource = src("budget.turn.maxToolCalls");
  const budgetWarnAtPercent = afterFile.budget.warnAtPercent;
  const budgetWarnAtPercentSource: ConfigSource = src("budget.warnAtPercent");
  const budgetModelPricing = afterFile.budget.modelPricing;
  const budgetModelPricingSource: ConfigSource = src("budget.modelPricing");

  // ---- messageBudget.*(S2:message-budget,沒有對應環境變數,只有 file/default
  // 兩層——理由與 policy/notification/budget 相同:安全罩本身不透過環境變數
  // 覆寫,只能靠本機編輯設定檔,見 core-config.ts 的 `ConfigSetFilePatchSchema`
  // 註解與 F4)。
  const messageBudgetMaxMessagesPerContext = afterFile.messageBudget.maxMessagesPerContext;
  const messageBudgetMaxMessagesPerContextSource: ConfigSource = src("messageBudget.maxMessagesPerContext");
  const messageBudgetWarnAtPercent = afterFile.messageBudget.warnAtPercent;
  const messageBudgetWarnAtPercentSource: ConfigSource = src("messageBudget.warnAtPercent");

  const config: CoreConfig = {
    version: CORE_CONFIG_VERSION,
    daemon: {
      port,
      bindHost,
      permissionTimeoutMs,
      authRateLimit: { max: authRateLimitMax, cooldownMs: authRateLimitCooldownMs },
    },
    workspace: { defaultWorkingDir, worktreesRoot },
    data: { dataDir },
    features: { staticDir },
    log: { level: logLevel },
    policy: { rules: policyRules, allowedHosts: policyAllowedHosts },
    notification: {
      desktop: { enabled: notificationDesktopEnabled },
      webhook: {
        url: notificationWebhookUrl,
        enabled: notificationWebhookEnabled,
        minSeverity: notificationWebhookMinSeverity,
      },
      batchIntervalMinutes: notificationBatchIntervalMinutes,
      quietHours: notificationQuietHours,
    },
    budget: {
      task: { maxCostUsd: budgetTaskMaxCostUsd, maxTokens: budgetTaskMaxTokens },
      daily: { maxCostUsd: budgetDailyMaxCostUsd, maxTokens: budgetDailyMaxTokens },
      turn: { maxDurationMs: budgetTurnMaxDurationMs, maxToolCalls: budgetTurnMaxToolCalls },
      warnAtPercent: budgetWarnAtPercent,
      modelPricing: budgetModelPricing,
    },
    messageBudget: {
      maxMessagesPerContext: messageBudgetMaxMessagesPerContext,
      warnAtPercent: messageBudgetWarnAtPercent,
    },
  };

  const effective: EffectiveCoreConfig = {
    version: field(CORE_CONFIG_VERSION, "default"),
    daemon: {
      port: field(port, portSource),
      bindHost: field(bindHost, bindHostSource),
      permissionTimeoutMs: field(permissionTimeoutMs, permissionTimeoutMsSource),
      authRateLimit: {
        max: field(authRateLimitMax, authRateLimitMaxSource),
        cooldownMs: field(authRateLimitCooldownMs, authRateLimitCooldownMsSource),
      },
    },
    workspace: {
      defaultWorkingDir: field(defaultWorkingDir, defaultWorkingDirSource),
      worktreesRoot: field(worktreesRoot, worktreesRootSource),
    },
    data: { dataDir: field(dataDir, dataDirSource) },
    features: { staticDir: field(staticDir, staticDirSource) },
    log: { level: field(logLevel, logLevelSource) },
    policy: {
      rules: field(policyRules, policyRulesSource),
      allowedHosts: field(policyAllowedHosts, policyAllowedHostsSource),
    },
    notification: {
      desktop: { enabled: field(notificationDesktopEnabled, notificationDesktopEnabledSource) },
      webhook: {
        url: field(notificationWebhookUrl, notificationWebhookUrlSource),
        enabled: field(notificationWebhookEnabled, notificationWebhookEnabledSource),
        minSeverity: field(notificationWebhookMinSeverity, notificationWebhookMinSeveritySource),
      },
      batchIntervalMinutes: field(notificationBatchIntervalMinutes, notificationBatchIntervalMinutesSource),
      quietHours: field(notificationQuietHours, notificationQuietHoursSource),
    },
    budget: {
      task: {
        maxCostUsd: field(budgetTaskMaxCostUsd, budgetTaskMaxCostUsdSource),
        maxTokens: field(budgetTaskMaxTokens, budgetTaskMaxTokensSource),
      },
      daily: {
        maxCostUsd: field(budgetDailyMaxCostUsd, budgetDailyMaxCostUsdSource),
        maxTokens: field(budgetDailyMaxTokens, budgetDailyMaxTokensSource),
      },
      turn: {
        maxDurationMs: field(budgetTurnMaxDurationMs, budgetTurnMaxDurationMsSource),
        maxToolCalls: field(budgetTurnMaxToolCalls, budgetTurnMaxToolCallsSource),
      },
      warnAtPercent: field(budgetWarnAtPercent, budgetWarnAtPercentSource),
      modelPricing: field(budgetModelPricing, budgetModelPricingSource),
    },
    messageBudget: {
      maxMessagesPerContext: field(messageBudgetMaxMessagesPerContext, messageBudgetMaxMessagesPerContextSource),
      warnAtPercent: field(messageBudgetWarnAtPercent, messageBudgetWarnAtPercentSource),
    },
  };

  return { config, effective };
}

/** 把 file 層驗證後的部分設定疊在 defaults 之上,同時記下每個「有出現在檔案
 *  裡」的欄位路徑(給 `applyEnvOverrides()` 判斷來源用——沒被環境變數覆寫時
 *  才需要知道究竟是 "default" 還是 "file")。 */
function mergeFileOverDefaults(
  defaults: CoreConfig,
  file: CoreConfigFileParsed | undefined,
): { merged: CoreConfig; fileSources: Record<string, ConfigSource> } {
  const fileSources: Record<string, ConfigSource> = {};
  if (!file) return { merged: defaults, fileSources };

  const merged: CoreConfig = {
    version: defaults.version,
    daemon: { ...defaults.daemon, authRateLimit: { ...defaults.daemon.authRateLimit } },
    workspace: { ...defaults.workspace },
    data: { ...defaults.data },
    features: { ...defaults.features },
    log: { ...defaults.log },
    policy: { ...defaults.policy },
    notification: {
      ...defaults.notification,
      desktop: { ...defaults.notification.desktop },
      webhook: { ...defaults.notification.webhook },
    },
    budget: {
      ...defaults.budget,
      task: { ...defaults.budget.task },
      daily: { ...defaults.budget.daily },
      turn: { ...defaults.budget.turn },
      modelPricing: { ...defaults.budget.modelPricing },
    },
    messageBudget: { ...defaults.messageBudget },
  };

  if (file.daemon?.port !== undefined) {
    merged.daemon.port = file.daemon.port;
    fileSources["daemon.port"] = "file";
  }
  if (file.daemon?.bindHost !== undefined) {
    merged.daemon.bindHost = file.daemon.bindHost;
    fileSources["daemon.bindHost"] = "file";
  }
  if (file.daemon?.permissionTimeoutMs !== undefined) {
    merged.daemon.permissionTimeoutMs = file.daemon.permissionTimeoutMs;
    fileSources["daemon.permissionTimeoutMs"] = "file";
  }
  if (file.daemon?.authRateLimit?.max !== undefined) {
    merged.daemon.authRateLimit.max = file.daemon.authRateLimit.max;
    fileSources["daemon.authRateLimit.max"] = "file";
  }
  if (file.daemon?.authRateLimit?.cooldownMs !== undefined) {
    merged.daemon.authRateLimit.cooldownMs = file.daemon.authRateLimit.cooldownMs;
    fileSources["daemon.authRateLimit.cooldownMs"] = "file";
  }
  if (file.workspace?.defaultWorkingDir !== undefined) {
    merged.workspace.defaultWorkingDir = file.workspace.defaultWorkingDir;
    fileSources["workspace.defaultWorkingDir"] = "file";
  }
  if (file.workspace?.worktreesRoot !== undefined) {
    merged.workspace.worktreesRoot = file.workspace.worktreesRoot;
    fileSources["workspace.worktreesRoot"] = "file";
  }
  if (file.data?.dataDir !== undefined) {
    merged.data.dataDir = file.data.dataDir;
    fileSources["data.dataDir"] = "file";
  }
  if (file.features?.staticDir !== undefined) {
    merged.features.staticDir = file.features.staticDir;
    fileSources["features.staticDir"] = "file";
  }
  if (file.log?.level !== undefined) {
    merged.log.level = file.log.level;
    fileSources["log.level"] = "file";
  }
  // S1(PolicyEngine):整批取代(不是逐條規則合併)——使用者在 config.json 寫
  // 的 `policy.rules`/`policy.allowedHosts` 就是最終清單,不會與 defaults 的
  // 空陣列合併出奇怪的疊加結果(比照 `workspace.worktreesRoot` 這種「提供時
  // 整批取代」的既有慣例)。
  if (file.policy?.rules !== undefined) {
    merged.policy.rules = file.policy.rules;
    fileSources["policy.rules"] = "file";
  }
  if (file.policy?.allowedHosts !== undefined) {
    merged.policy.allowedHosts = file.policy.allowedHosts;
    fileSources["policy.allowedHosts"] = "file";
  }
  // S11(Notification):逐欄位合併(與 `daemon.authRateLimit.*` 同樣的細粒度,
  // 不是像 `policy.rules` 那樣整批取代——`notification` 底下每個欄位語意獨立,
  // 使用者應該能只覆寫其中一個而不影響其他既有欄位)。`quietHours` 是唯一例外
  // (整個小物件一起提供/省略,語意上「只設定 from 不設定 to」沒有意義)。
  if (file.notification?.desktop?.enabled !== undefined) {
    merged.notification.desktop.enabled = file.notification.desktop.enabled;
    fileSources["notification.desktop.enabled"] = "file";
  }
  if (file.notification?.webhook?.url !== undefined) {
    merged.notification.webhook.url = file.notification.webhook.url;
    fileSources["notification.webhook.url"] = "file";
  }
  if (file.notification?.webhook?.enabled !== undefined) {
    merged.notification.webhook.enabled = file.notification.webhook.enabled;
    fileSources["notification.webhook.enabled"] = "file";
  }
  if (file.notification?.webhook?.minSeverity !== undefined) {
    merged.notification.webhook.minSeverity = file.notification.webhook.minSeverity;
    fileSources["notification.webhook.minSeverity"] = "file";
  }
  if (file.notification?.batchIntervalMinutes !== undefined) {
    merged.notification.batchIntervalMinutes = file.notification.batchIntervalMinutes;
    fileSources["notification.batchIntervalMinutes"] = "file";
  }
  if (file.notification?.quietHours !== undefined) {
    merged.notification.quietHours = file.notification.quietHours;
    fileSources["notification.quietHours"] = "file";
  }
  // S3b(CostGovernor):逐欄位合併(與 `notification` 同樣的細粒度)——除了
  // `modelPricing`,那是「整批取代」(使用者在 config.json 寫的定價表就是最終
  // 清單,不與 defaults 的空物件合併出奇怪的疊加結果,比照 `policy.rules` 的
  // 既有慣例)。
  if (file.budget?.task?.maxCostUsd !== undefined) {
    merged.budget.task.maxCostUsd = file.budget.task.maxCostUsd;
    fileSources["budget.task.maxCostUsd"] = "file";
  }
  if (file.budget?.task?.maxTokens !== undefined) {
    merged.budget.task.maxTokens = file.budget.task.maxTokens;
    fileSources["budget.task.maxTokens"] = "file";
  }
  if (file.budget?.daily?.maxCostUsd !== undefined) {
    merged.budget.daily.maxCostUsd = file.budget.daily.maxCostUsd;
    fileSources["budget.daily.maxCostUsd"] = "file";
  }
  if (file.budget?.daily?.maxTokens !== undefined) {
    merged.budget.daily.maxTokens = file.budget.daily.maxTokens;
    fileSources["budget.daily.maxTokens"] = "file";
  }
  if (file.budget?.turn?.maxDurationMs !== undefined) {
    merged.budget.turn.maxDurationMs = file.budget.turn.maxDurationMs;
    fileSources["budget.turn.maxDurationMs"] = "file";
  }
  if (file.budget?.turn?.maxToolCalls !== undefined) {
    merged.budget.turn.maxToolCalls = file.budget.turn.maxToolCalls;
    fileSources["budget.turn.maxToolCalls"] = "file";
  }
  if (file.budget?.warnAtPercent !== undefined) {
    merged.budget.warnAtPercent = file.budget.warnAtPercent;
    fileSources["budget.warnAtPercent"] = "file";
  }
  if (file.budget?.modelPricing !== undefined) {
    merged.budget.modelPricing = file.budget.modelPricing;
    fileSources["budget.modelPricing"] = "file";
  }
  // S2(message-budget):逐欄位合併,理由與 budget 相同。
  if (file.messageBudget?.maxMessagesPerContext !== undefined) {
    merged.messageBudget.maxMessagesPerContext = file.messageBudget.maxMessagesPerContext;
    fileSources["messageBudget.maxMessagesPerContext"] = "file";
  }
  if (file.messageBudget?.warnAtPercent !== undefined) {
    merged.messageBudget.warnAtPercent = file.messageBudget.warnAtPercent;
    fileSources["messageBudget.warnAtPercent"] = "file";
  }

  return { merged, fileSources };
}

/**
 * 載入設定的唯一入口——`apps/core/src/index.ts` 的 `main()` 在啟動最開始就
 * 呼叫一次,之後全程使用回傳的 `config`/`effective`,不再有任何模組零散讀取
 * `process.env.DESKMONY_*`(`DESKMONY_AUTH_TOKEN` 除外,它刻意走獨立的
 * `readAuthTokenFromEnv()`,見上方說明)。
 *
 * 這裡**不**呼叫 `process.exit()`——`readConfigFile()` 丟出的 `ConfigLoadError`
 * 原樣往外拋,由 `main()` 的頂層 catch 統一印出 + 結束(與這個專案既有的
 * 「頂層 main().catch() 負責致命錯誤」慣例一致)。
 */
export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const homeDir = resolveHomeDir();
  const configPath = resolveConfigPath(homeDir);

  const defaults = computeDefaultCoreConfig();
  const fileParsed = readConfigFile(configPath);
  const { merged: afterFile, fileSources } = mergeFileOverDefaults(defaults, fileParsed);

  const { config, effective } = applyEnvOverrides(afterFile, fileSources);

  // 這裡才真正套用 defaultStaticDir fallback(env/file 都沒設定時)。
  if (config.features.staticDir === undefined) {
    config.features.staticDir = options.defaultStaticDir;
    effective.features.staticDir = field(options.defaultStaticDir, effective.features.staticDir.source);
  }

  return {
    config,
    effective,
    configPath,
    homeDir,
    authToken: readAuthTokenFromEnv(),
  };
}

/**
 * 「哪個等級以上才印」的最小實作——只覆寫 `console.log`/`console.info`/
 * `console.warn` 成 no-op(依門檻),`console.error` **永遠保留**,確保致命
 * 錯誤(例如 `validateBindSafety()`/設定檔解析失敗)一定看得到。不引入檔案
 * 輪替等新基礎設施(見 packages/shared/src/core-config.ts 的 `LogLevelSchema`
 * 註解)。
 *
 * 預設 `level="info"` 時完全不覆寫任何 console 方法——這是「沒有設定檔時
 * 行為必須與現在完全相同」這條相容性底線的一部分(既有的所有 `console.log`/
 * `console.warn` 呼叫點完全不用改)。
 */
export function applyConsoleLogLevel(level: LogLevel): void {
  const order: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
  const threshold = order[level];
  const noop = (): void => {};
  if (threshold > order.info) {
    console.log = noop;
    console.info = noop;
  }
  if (threshold > order.warn) {
    console.warn = noop;
  }
}

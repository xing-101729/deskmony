import { z } from "zod";
import {
  BUILTIN_PROVIDERS,
  DeskmonyError,
  ProviderCatalogEntrySchema,
  resolveProviders,
  type AgentDetectionEntry,
  type AgentLaunchSpec,
  type AgentSoftware,
  type EffortLevel,
  type ProviderCatalogEntry,
  type NetworkAgentSummary,
  type ResolvedProvider,
  softwareCanUseTools,
} from "@deskmony/shared";
import { detectAllAgents } from "../detect/agent-detector.js";
import { getProviderPrefsMap, type SettingsStore } from "../settings/settings-store.js";

/**
 * agent-catalog.ts(2026-10-02,P2「移除 profile」新增,見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P2.2)。
 *
 * `AgentCatalog` 是「這台電腦上有哪些 agent 可以開 session」的唯一權威來源,取代過去由使用者
 * 手動建立、存在 `agent_profiles` 表的 AgentProfile:
 *   - 持有偵測結果快取:core 啟動時背景跑一次 `detectAllAgents()`(**不阻塞啟動**,見
 *     `startBackgroundDetection()`);`env.detectAgents` gateway 方法改成「重新偵測 + 更新快取 +
 *     回傳」(`detectAgents()`)。
 *   - `resolve()` = `resolveProviders(BUILTIN_PROVIDERS, 偵測快取, providerPrefs)`(providerPrefs
 *     從 `SettingsStore` 讀)。`listAvailable()` = `enabled && installed` 的項目。
 *   - `buildLaunchSpec(providerId, model?, effort?)`:組出 `AgentAdapter.spawn()` 要的啟動規格;
 *     找不到/未安裝/已停用 → 丟 `DeskmonyError`(`agent.notFound`/`agent.notInstalled`/
 *     `agent.disabled`,前端 errors namespace 有對應的中文訊息)。偵測快取尚未完成時,`await` 那一次
 *     偵測而不是回錯——但**只有真的需要偵測結果的 provider**(外部 CLI)才等,內嵌的
 *     claude-agent-sdk 與 e2e 測試 provider 不需要,不會被偵測拖慢。
 *   - `buildLaunchSpecForSession()`:續接/接手等「重新 spawn 既有 session」的路徑用,provider
 *     已不存在/未安裝時退回 session 自己存的 `adapterType + launch_command + launch_args`。
 *
 * **與舊設計的差異(務必知道)**:`custom-pty`(手動輸入 command 的逃生閥)已從
 * `BUILTIN_PROVIDERS` 移除——新模型的前提是「從電腦找到的 agent」;gateway 也沒有任何能新增
 * 任意 command 的方法(見下方 e2e 測試掛鉤的安全說明)。
 *
 * **`resolve()`/`listAvailable()` 是 async(規格寫的是同步)**:providerPrefs 在 SQLite 的
 * `settings` 表,讀它是 `await`;而且偵測快取尚未完成時也要等,同步介面做不到。
 */

// ---- e2e 測試掛鉤:DESKMONY_E2E_EXTRA_PROVIDERS ----------------------------------------------

/**
 * ⚠️ **測試掛鉤**(只給 `scripts/e2e-*.mjs` 用,不是使用者功能):原本 e2e 是透過 profile 的
 * `acpConfig.command/args` 指定 fake ACP agent / fake PTY / fake opencode server 執行檔,沒有
 * profile 之後需要一條讓 e2e 指定 fake 執行檔的路徑。core 啟動時若設了環境變數
 * `DESKMONY_E2E_EXTRA_PROVIDERS`(JSON 陣列,元素 = `ProviderCatalogEntry` 欄位 + `command`/`args`),
 * 就把它們併入 catalog 當成**已安裝**的 provider(`software` 只能是 AdapterRegistry 有註冊的四種)。
 *
 * **為什麼這樣不擴大攻擊面**:
 *   1. **只吃環境變數,不經 gateway**——gateway 上沒有任何能新增 provider/command 的方法
 *      (`session.create` 只收 `providerId`)。遠端 client 沒有辦法讓 core 執行一個它指定的
 *      執行檔;否則 gateway 就等於「遠端可執行任意程式」。
 *   2. 能設定 core 行程環境變數的人,本來就是啟動這個 core 的人——他能直接在同一台機器上執行任意
 *      程式,這個掛鉤沒有給他任何他原本沒有的能力。(同類先例:`DESKMONY_YOLO_DURATION_MS`、
 *      `DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS` 等 e2e 專用覆寫,都是只吃環境變數、不經設定檔/gateway。)
 *   3. 解析失敗(JSON 壞掉、元素不符 schema)只 `console.error` 並略過該項,**不能讓 core 起不來**。
 *   4. id 與內建 provider 重複的元素會被略過(env 不能偷換內建 provider 的啟動方式)。
 *
 * 元素裡 `models`/`supportsModelSelection`/`order` 可省略(預設 `[]`/`false`/`1000 + 序號`),
 * 方便 e2e 只寫 `{id, label, software, command, args}`。
 */
export const E2E_EXTRA_PROVIDERS_ENV = "DESKMONY_E2E_EXTRA_PROVIDERS";

const ExtraProviderSchema = ProviderCatalogEntrySchema.partial({
  models: true,
  supportsModelSelection: true,
  order: true,
}).extend({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

interface ExtraProvider {
  entry: ProviderCatalogEntry;
  command: string;
  args?: string[];
}

/** 解析 `DESKMONY_E2E_EXTRA_PROVIDERS` 的值。永遠不丟例外(見上方安全說明第 3 點)。 */
export function parseExtraProviders(raw: string | undefined): ExtraProvider[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[agent-catalog] ${E2E_EXTRA_PROVIDERS_ENV} 不是合法的 JSON,已忽略: ${String(err)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`[agent-catalog] ${E2E_EXTRA_PROVIDERS_ENV} 必須是 JSON 陣列,已忽略。`);
    return [];
  }
  const builtinIds = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  const seen = new Set<string>();
  const result: ExtraProvider[] = [];
  parsed.forEach((item, index) => {
    const checked = ExtraProviderSchema.safeParse(item);
    if (!checked.success) {
      console.error(`[agent-catalog] ${E2E_EXTRA_PROVIDERS_ENV}[${index}] 不符合格式,已略過: ${checked.error.message}`);
      return;
    }
    const { command, args, ...rest } = checked.data;
    if (builtinIds.has(rest.id) || seen.has(rest.id)) {
      console.error(`[agent-catalog] ${E2E_EXTRA_PROVIDERS_ENV}[${index}] 的 id "${rest.id}" 與既有 provider 重複,已略過。`);
      return;
    }
    seen.add(rest.id);
    result.push({
      entry: {
        ...rest,
        models: rest.models ?? [],
        supportsModelSelection: rest.supportsModelSelection ?? false,
        order: rest.order ?? 1000 + index,
      },
      command,
      args,
    });
  });
  return result;
}

// ---- AgentCatalog ----------------------------------------------------------------------------

export interface AgentCatalogOptions {
  /** `DESKMONY_E2E_EXTRA_PROVIDERS` 的原始字串(由 apps/core/src/index.ts 從環境變數讀入)。 */
  extraProvidersJson?: string;
  /** 偵測函式,預設 `detectAllAgents`;單元測試可以注入假的。 */
  detect?: () => Promise<AgentDetectionEntry[]>;
}

/** session 自己存的啟動資訊(`sessions.launch_command`/`launch_args`),見 `buildLaunchSpecForSession()`。 */
export interface StoredLaunchInfo {
  command?: string;
  args?: string[];
}

/** `buildLaunchSpecForSession()` 需要的 session 欄位(刻意不 import `Session`,避免把 launch 欄位混進對外型別)。 */
export interface SessionLaunchSource {
  providerId: string;
  adapterType: AgentSoftware;
  model?: string;
  effort?: EffortLevel;
}

export class AgentCatalog {
  private readonly extras: ExtraProvider[];
  private readonly detect: () => Promise<AgentDetectionEntry[]>;
  /** 目前(或最近一次)偵測的 promise;`undefined` = 還沒開始過。永遠 resolve,不會 reject。 */
  private detection: Promise<AgentDetectionEntry[]> | undefined;

  constructor(
    private readonly settingsStore: SettingsStore,
    options: AgentCatalogOptions = {},
  ) {
    this.extras = parseExtraProviders(options.extraProvidersJson);
    this.detect = options.detect ?? detectAllAgents;
    if (this.extras.length > 0) {
      console.warn(
        `[agent-catalog] ${E2E_EXTRA_PROVIDERS_ENV} 已啟用:額外註冊 ${this.extras.length} 個測試 provider ` +
          `(${this.extras.map((e) => e.entry.id).join(", ")})——這是 e2e 測試掛鉤,正式環境不應該設定。`,
      );
    }
  }

  /** core 啟動時呼叫一次:背景偵測,**不 await、不阻塞啟動**。 */
  startBackgroundDetection(): void {
    void this.runDetection();
  }

  /** `env.detectAgents`:重新偵測 + 更新快取 + 回傳。 */
  async detectAgents(): Promise<AgentDetectionEntry[]> {
    return this.runDetection();
  }

  private runDetection(): Promise<AgentDetectionEntry[]> {
    const run = this.detect().catch((err: unknown) => {
      // 偵測本身理論上每一項都 fail-soft,不該丟;萬一丟了就當作什麼都沒偵測到,不能讓 session
      // 建立整個卡死。下一次 `detectAgents()` 可以重試。
      console.error(`[agent-catalog] 偵測 agent 失敗,暫時當作沒有偵測到任何外部 agent: ${String(err)}`);
      return [] as AgentDetectionEntry[];
    });
    this.detection = run;
    return run;
  }

  /** 偵測快取(尚未開始過就先開始);呼叫端 await 到的一定是完成的那一次。 */
  private whenDetected(): Promise<AgentDetectionEntry[]> {
    return this.detection ?? this.runDetection();
  }

  private allEntries(): ProviderCatalogEntry[] {
    return [...BUILTIN_PROVIDERS, ...this.extras.map((e) => e.entry)];
  }

  /** 把 e2e 測試 provider 的 command/args 補到 `resolveProviders()` 的結果上(它們沒有 detectKey)。 */
  private applyExtras(resolved: ResolvedProvider[]): ResolvedProvider[] {
    if (this.extras.length === 0) return resolved;
    const byId = new Map(this.extras.map((e) => [e.entry.id, e] as const));
    return resolved.map((p) => {
      const extra = byId.get(p.id);
      return extra ? { ...p, command: extra.command, defaultArgs: extra.args, installed: true } : p;
    });
  }

  /** 完整的 provider 清單(含已停用、未安裝的)。 */
  async resolve(): Promise<ResolvedProvider[]> {
    const [detection, prefs] = await Promise.all([this.whenDetected(), getProviderPrefsMap(this.settingsStore)]);
    return this.applyExtras(resolveProviders(this.allEntries(), detection, prefs));
  }

  /**
   * providerId → 顯示名稱(含使用者在偏好裡改的 label)。**不等偵測結果**——label 與偵測無關,復原視圖
   * (`recovery.list`)只需要這個,不該為了顯示名稱去等好幾秒的 `opencode models` 之類探測。
   */
  async labelsById(): Promise<Map<string, string>> {
    const prefs = await getProviderPrefsMap(this.settingsStore);
    return new Map(resolveProviders(this.allEntries(), [], prefs).map((p) => [p.id, p.label] as const));
  }

  /** `enabled && installed` 的項目——「現在真的能開 session」的 agent。 */
  async listAvailable(): Promise<ResolvedProvider[]> {
    return (await this.resolve()).filter((p) => p.enabled && p.installed);
  }

  /**
   * `list_agents` 工具與 `agent.listForAgent` gateway 方法共用的最小摘要:只含 agent 做決策
   * 需要的欄位(id/label/software/models/defaultModelId/canUseTools),**不含 command/args/env**(本機路徑與
   * 可能的密鑰不該進 agent 的對話 context)。兩個入口共用這個函式,結構上保證回傳一致。
   * `canUseTools`:只有 claude-agent-sdk 與 acp 能掛工具、主動傳訊息(見 `softwareCanUseTools()`)。
   */
  async summarizeAvailable(): Promise<NetworkAgentSummary[]> {
    return (await this.listAvailable()).map((p) => ({
      id: p.id,
      label: p.label,
      software: p.software,
      models: p.models.map((m) => ({ id: m.id, label: m.label })),
      defaultModelId: p.defaultModelId,
      canUseTools: softwareCanUseTools(p.software),
    }));
  }

  /** 找單一 provider(含已停用/未安裝的),只等「這個 provider 真的需要」的偵測。 */
  private async resolveOne(providerId: string): Promise<ResolvedProvider | undefined> {
    const entry = this.allEntries().find((p) => p.id === providerId);
    if (!entry) return undefined;
    // 內嵌的 claude-agent-sdk 與 e2e 測試 provider(沒有 detectKey)不需要偵測結果:不等偵測,
    // 否則 e2e 的第一個 session.create 會被好幾秒的 `opencode models` 之類探測拖住。
    const needsDetection = entry.software !== "claude-agent-sdk" && entry.detectKey !== undefined;
    const [detection, prefs] = await Promise.all([
      needsDetection ? this.whenDetected() : Promise.resolve([] as AgentDetectionEntry[]),
      getProviderPrefsMap(this.settingsStore),
    ]);
    return this.applyExtras(resolveProviders([entry], detection, prefs))[0];
  }

  /**
   * 組出啟動規格。`model` 省略時用 provider **明確標記 `isDefault`** 的 model(沒有標記就不帶,
   * 讓 agent/CLI 自己決定——不退回清單第一項:`opencode models` 清單是依字母排序的,把第一項當預設
   * 會悄悄把使用者的 opencode 換到一個不是他設定的 model)。`supportsModelSelection` 為 false 的
   * provider 一律忽略 `model`;`effort` 只有 claude-agent-sdk 有意義,其餘忽略。
   */
  async buildLaunchSpec(providerId: string, model?: string, effort?: EffortLevel): Promise<AgentLaunchSpec> {
    return (await this.buildLaunch(providerId, model, effort)).spec;
  }

  /** 同 `buildLaunchSpec()`,另外回傳 provider 的顯示名稱(session 建立時給筆記指路段落用)。 */
  async buildLaunch(
    providerId: string,
    model?: string,
    effort?: EffortLevel,
  ): Promise<{ spec: AgentLaunchSpec; label: string }> {
    const provider = await this.resolveOne(providerId);
    if (!provider) {
      throw new DeskmonyError("agent.notFound", { providerId }, `找不到 agent「${providerId}」,請先用 agent 清單確認可用的 id`);
    }
    if (!provider.enabled) {
      throw new DeskmonyError("agent.disabled", { providerId, label: provider.label }, `agent「${provider.label}」已在設定中停用`);
    }
    if (!provider.installed) {
      throw new DeskmonyError(
        "agent.notInstalled",
        { providerId, label: provider.label },
        `agent「${provider.label}」目前沒有在這台電腦上偵測到,請安裝後到設定重新偵測`,
      );
    }

    const effectiveModel = provider.supportsModelSelection
      ? (model ?? provider.models.find((m) => m.isDefault)?.id)
      : undefined;
    const base: AgentLaunchSpec = {
      software: provider.software,
      providerId: provider.id,
      model: effectiveModel,
      effort: provider.software === "claude-agent-sdk" ? effort : undefined,
    };
    if (provider.software === "claude-agent-sdk") return { spec: base, label: provider.label };

    if (!provider.command) {
      throw new DeskmonyError(
        "agent.notInstalled",
        { providerId, label: provider.label },
        `agent「${provider.label}」沒有偵測到可執行的路徑,請安裝後到設定重新偵測`,
      );
    }
    const defaultArgs = provider.defaultArgs ?? [];
    if (provider.software === "acp") {
      return { spec: { ...base, acpConfig: { command: provider.command, args: nonEmpty(defaultArgs) } }, label: provider.label };
    }
    if (provider.software === "opencode") {
      // opencode 的 args 語意是「完全取代預設的 serve 參數」(見 OpencodeAgentConfigSchema 註解):
      // 內建的 opencode provider 沒有 defaultArgs,args 維持 undefined。
      return {
        spec: { ...base, opencodeConfig: { command: provider.command, args: nonEmpty(defaultArgs) } },
        label: provider.label,
      };
    }
    // pty。claude-cli 的「支援 model 選擇」是把 `--model <別名>` 烤進固定的啟動參數(pty 建立後不能
    // 像 SDK 一樣中途切換 model,見 provider-catalog.ts 的 claude-cli 項目註解)——只對這個 provider。
    const modelArgs = provider.id === "claude-cli" && effectiveModel ? ["--model", effectiveModel] : [];
    return {
      spec: { ...base, ptyConfig: { command: provider.command, args: nonEmpty([...defaultArgs, ...modelArgs]) } },
      label: provider.label,
    };
  }

  /**
   * 續接/接手等「重新 spawn 既有 session」的路徑一律從 session 自己的資料重建(絕不讀已移除的
   * `agent_profiles` 表):先用 `providerId` 走 `buildLaunchSpec(providerId, session.model,
   * session.effort)`;provider 已不存在/未安裝/已停用,或重建出來的 software 對不上 session 的
   * `adapterType`(目錄版本間 provider 的 software 改過)時,退回
   * `adapterType + launch_command + launch_args`。連退路也沒有(舊資料回填不出啟動資訊)就丟明確錯誤。
   */
  async buildLaunchSpecForSession(
    session: SessionLaunchSource,
    stored: StoredLaunchInfo,
  ): Promise<{ spec: AgentLaunchSpec; label: string }> {
    try {
      const built = await this.buildLaunch(session.providerId, session.model, session.effort);
      if (built.spec.software === session.adapterType) return built;
    } catch (err) {
      if (!(err instanceof DeskmonyError) || !FALLBACK_ERROR_CODES.has(err.code)) throw err;
    }
    return { spec: launchSpecFromStored(session, stored), label: session.providerId };
  }
}

/** provider 目錄找不到/未安裝/已停用時,允許退回 session 自己存的啟動資訊的錯誤碼。 */
const FALLBACK_ERROR_CODES = new Set(["agent.notFound", "agent.notInstalled", "agent.disabled"]);

function nonEmpty(args: string[]): string[] | undefined {
  return args.length > 0 ? args : undefined;
}

/** 從 session 存的 `adapterType + launch_command + launch_args` 組啟動規格(provider 已不存在時的退路)。 */
function launchSpecFromStored(session: SessionLaunchSource, stored: StoredLaunchInfo): AgentLaunchSpec {
  const base: AgentLaunchSpec = {
    software: session.adapterType,
    providerId: session.providerId,
    model: session.model,
    effort: session.adapterType === "claude-agent-sdk" ? session.effort : undefined,
  };
  if (session.adapterType === "claude-agent-sdk") return base;

  const { command, args } = stored;
  if (!command || (session.adapterType !== "acp" && session.adapterType !== "pty" && session.adapterType !== "opencode")) {
    throw new DeskmonyError(
      "agent.launchInfoMissing",
      { providerId: session.providerId, adapterType: session.adapterType },
      `這個 session 的 agent「${session.providerId}」已不在偵測清單裡,而且 session 沒有留下啟動資訊(建立於舊版),無法重新啟動;請改用新的 session`,
    );
  }
  if (session.adapterType === "acp") return { ...base, acpConfig: { command, args } };
  if (session.adapterType === "pty") return { ...base, ptyConfig: { command, args } };
  return { ...base, opencodeConfig: { command, args } };
}

/** 啟動規格裡要持久化進 `sessions.launch_command`/`launch_args` 的部分(env/systemPrompt 一律不存)。 */
export function storedLaunchFromSpec(spec: AgentLaunchSpec): StoredLaunchInfo {
  const config = spec.acpConfig ?? spec.ptyConfig ?? spec.opencodeConfig;
  return config ? { command: config.command, args: config.args } : {};
}

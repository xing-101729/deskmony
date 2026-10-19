import { z } from "zod";
import type { AgentFamily } from "./provider-catalog.js";

/**
 * agent-launch.ts:原本的 `agent-profile.ts`(2026-10-02 P2「移除 profile」改名,見
 * docs/DECISIONS.md §H、docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P2)。
 *
 * AgentProfile(「使用者手動建立、有名字/角色/systemPrompt 的 agent 設定檔」)已整個
 * 移除——session 現在直接以「從這台電腦偵測到的 agent(providerId)+ model」建立,
 * 啟動資訊由 core 的 `AgentCatalog.buildLaunchSpec()` 組出,存進 session 自己的欄位。
 * 這個檔案只留下仍有人用的共用型別:`AgentSoftware`、effort、權限模式、各 adapter 的
 * 啟動設定 schema,以及取代 AgentProfile 傳給 `AgentAdapter.spawn()` 的 `AgentLaunchSpec`。
 */

/**
 * 支援的 agent 軟體種類(對應 ARCHITECTURE.md 3.4 節 Adapter Layer)。
 * M1 僅實作 claude-agent-sdk,其餘保留供 M2+ 使用。
 */
export const AgentSoftwareSchema = z.enum([
  "claude-agent-sdk",
  "acp",
  "opencode",
  "codex",
  "pty",
]);
export type AgentSoftware = z.infer<typeof AgentSoftwareSchema>;

/**
 * S7(auto-mode-and-yolo)L4 §1.1:**破壞性收窄**——移除 `auto-accept-all`。
 * YOLO(全繞過 config deny-list,見 auto-mode-and-yolo_detail.md §2)只能是
 * session 暫態(見下方 `SessionPermissionModeSchema`),**絕不可持久化**——
 * 否則 core 重啟後,一個原本只是「這次先不管我」的臨時決定,會在使用者毫無察覺
 * 的情況下變成永久生效的無人值守繞過,這正是 HLD §2 明講「YOLO 暫態、崩潰不復活」
 * 要防的事。
 *
 * 2026-10-02(P2):profile 移除後這個型別不再有持久化的地方(session 一律從
 * `"always-ask"` 開始,見 session-manager.ts 的 `createSession()`);保留它只是讓
 * 「session 初始權限模式只可能是這兩種」這條不變式在型別上有個落腳點。
 */
export const PermissionLevelSchema = z.enum(["always-ask", "auto-accept-edits"]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/**
 * S7 L4 §1.1:session **暫態**可達的權限模式(含 YOLO)——只存在
 * `SessionManager` 記憶體(見 apps/core/src/session/session-permission-coordinator.ts 的
 * `SessionPermissionState`),不落地 DB。一個 session 建立時的初值一律是
 * `"always-ask"`,之後可透過 `session.setPermissionMode` gateway 方法提升到
 * `"auto-accept-edits"`(auto)或 `"auto-accept-all"`(YOLO),YOLO 30 分鐘後惰性
 * 過期回落 `"always-ask"`。
 *
 * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):`session.setPermissionMode`
 * **本機與遠端皆可呼叫**——已從 `LOCAL_ONLY_METHODS` 移除(原文件寫「僅本機」
 * 已過時)。額外的「真.無限制」層(疊在 `"auto-accept-all"` 之上,連
 * hard-deny 都繞過)透過獨立的 `session.setTrueUnrestricted` 方法控制,同樣
 * 本機遠端皆可,見 apps/core/src/session/session-manager.ts 的
 * `setTrueUnrestricted()`。
 */
export const SessionPermissionModeSchema = z.enum(["always-ask", "auto-accept-edits", "auto-accept-all"]);
export type SessionPermissionMode = z.infer<typeof SessionPermissionModeSchema>;

/**
 * ACP(Agent Client Protocol)agent 的啟動方式(M2 Round A 新增)。
 * `AcpAdapter.spawn()` 會用這裡的 command/args/env 起一個子程序,經 stdio
 * 建立 ACP JSON-RPC 連線(見 packages/adapters/src/acp-adapter.ts)。
 */
export const AcpAgentConfigSchema = z.object({
  /** 子程序執行檔(可為 PATH 上的名稱,或絕對路徑) */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
});
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;

/**
 * `software="pty"` 的 GenericPtyAdapter 啟動方式(M2 Round B 新增)。與
 * `AcpAgentConfigSchema` 同構(command/args/env),額外多了 `cols`/`rows`
 * 這兩個終端初始尺寸 —— pty 是「直通任意互動式 CLI 的終端」,沒有結構化的
 * session/update 協議可以告知 agent 終端大小,只能在 spawn 當下就決定
 * (未來若要支援 resize,需要另外擴充 AgentAdapter 介面,M2 Round B 範圍
 * 只做「固定尺寸 spawn」)。
 */
export const PtyAgentConfigSchema = z.object({
  /** 子程序執行檔(可為 PATH 上的名稱,或絕對路徑) */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
  /** 終端欄數,預設 80(見 GenericPtyAdapter) */
  cols: z.number().int().positive().optional(),
  /** 終端行數,預設 24(見 GenericPtyAdapter) */
  rows: z.number().int().positive().optional(),
});
export type PtyAgentConfig = z.infer<typeof PtyAgentConfigSchema>;

/**
 * `software="opencode"` 的 OpenCodeAdapter 啟動方式(這輪新增,見
 * packages/adapters/src/opencode-adapter.ts 頂端對接策略註解)。
 *
 * `command` 是 `opencode` 執行檔(或 e2e 測試用的替身腳本)的完整路徑,由
 * `AgentCatalog.buildLaunchSpec()` 從偵測結果自動帶入,使用者不需要手動輸入。
 *
 * `args` **與 `AcpAgentConfigSchema`/`PtyAgentConfigSchema` 的語意不同**:
 * 那兩者的 `args` 是「附加在使用者指定 command 後面」的參數,原封不動傳給
 * `spawn()`;這裡的 `args`(若有提供且非空陣列)則是**完全取代**
 * `OpenCodeAdapter.spawn()` 原本會自動組出的 `["serve", "--port", "0",
 * "--hostname", "127.0.0.1"]` 這組固定參數 —— 因為真正對接 opencode 需要的
 * 是「用某個 port/host 啟動 headless server」這個特定子命令,不是任意透傳,
 * 一般情況下(`args` 省略)`OpenCodeAdapter` 會自己組出正確的 `serve` 參數,
 * 使用者/UI 完全不需要填這個欄位。這個逃生閥的唯一實際用途是
 * `scripts/fake-opencode-server.mjs`(e2e 決定性測試):它不是真的 opencode
 * 執行檔,不接受 `serve --port ...` 這組參數,而是直接被當成
 * `command=process.execPath, args=[fakeServerScriptPath]` 啟動,此時就需要
 * 完全取代預設參數,而不是附加在 `serve` 後面(2026-10-02 起,e2e 經
 * `DESKMONY_E2E_EXTRA_PROVIDERS` 環境變數把這組 command/args 注入 `AgentCatalog`,
 * 見 apps/core/src/agents/agent-catalog.ts)。
 */
export const OpencodeAgentConfigSchema = z.object({
  /** opencode 執行檔完整路徑(或 e2e 替身腳本的直譯器,見上方註解)。 */
  command: z.string().min(1),
  /** 見上方註解:提供時完全取代預設的 `serve` 參數,不是附加。 */
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
});
export type OpencodeAgentConfig = z.infer<typeof OpencodeAgentConfigSchema>;

/**
 * **Claude** 的思考程度(reasoning effort)5 級。查證於 sdk.d.ts:`query()` 的 `Options.effort?:
 * EffortLevel` 欄位與執行中 `Query.applyFlagSettings({ effortLevel })` 都是 SDK 正式公開 API(非
 * deprecated);`claude` CLI 2.1.199 的 `--effort <level>` 接受同樣這 5 個值(`claude --help` 實測)。
 *
 * 2026-10-06 起這**不再是**所有 agent 的思考程度型別——各 agent 的值由 agent 自己定義(見
 * session-options.ts 的 `EffortValueSchema`:codex/opencode 有 `none`/`minimal`,Gemini 有
 * `minimal`/`high`……)。session、gateway、`AgentLaunchSpec` 一律用字串;這個 enum 只用來驗證
 * claude-agent-sdk 與 claude-cli 收到的值,以及作為那兩個 provider 的固定選項清單。
 */
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * AgentLaunchSpec:`AgentAdapter.spawn()` 的輸入——「怎麼啟動這個 agent」的完整
 * 規格(取代過去傳給 `spawn()` 的 `AgentProfile`)。
 *
 * **只在 core ↔ adapters 之間以記憶體物件傳遞**:不持久化(session 只存
 * `providerId`/`launch_command`/`launch_args` 三個欄位,見 packages/db/src/schema.ts)、
 * 也不經 gateway 曝露——`env` 可能含 provider 層級設定的 API key,下一次 spawn 時
 * 由 `SessionManager.prepareSpawnSpec()` 重新從 `SettingsStore` 讀,不落地。
 * 因此這裡用純 TS interface 而非 zod schema(沒有任何需要在邊界驗證的輸入)。
 *
 * 由 `AgentCatalog.buildLaunchSpec()`(找得到 provider 時)或
 * `buildLaunchSpecFromStored()`(provider 已不存在,退回 session 自己存的
 * `adapterType + launch_command + launch_args`)產生。
 */
export interface AgentLaunchSpec {
  software: AgentSoftware;
  /** 這個 spec 是從哪個 provider 目錄項目(`ProviderCatalogEntry.id`)組出的;只做來源標記與
   *  provider 層級 env 的查找 key,不影響怎麼 spawn(`software`/`*Config` 才是權威)。
   *  退回舊資料時可能是 `"legacy-<software>"` 這種沒有目錄項目對應的值。 */
  providerId?: string;
  /**
   * 這個 agent 的「家族」(見 provider-catalog.ts 的 `AgentFamilySchema`):由 `AgentCatalog` 依 provider 目錄項目
   * 帶入(退回 session 自己存的啟動資訊時,依 providerId 反查目錄)。adapter 靠它決定要不要在啟動子程序時
   * 介入該家族的預設權限策略——對 `software: "acp"` 這是**唯一**能分辨「這是 opencode acp」的資訊。
   */
  family?: AgentFamily;
  /**
   * 明確指定的 model / 思考程度(使用者或 agent 建立 session 時選的):adapter **必須**套用,做不到
   * (agent 不支援、值不在 agent 回報的清單裡)就讓 spawn 失敗並給明確錯誤——不可悄悄用別的設定跑。
   * effort 的值由各 agent 定義,見 session-options.ts。
   */
  model?: string;
  effort?: string;
  /**
   * 2026-10-06:**軟性偏好**——「這個 provider 上次選的」model / 思考程度(見 SessionManager 的
   * provider 上次選擇),或續接時 session 自己記得的值。只給「要等 session 開起來才知道有哪些選項」的
   * agent(ACP)用:adapter 拿到選項後,值在清單裡才套用,不在就略過(只記 log),**不讓 spawn 失敗**。
   * 有明確的 `model`/`effort` 時以明確值為準。
   */
  preferredModel?: string;
  preferredEffort?: string;
  /** 會與 process.env 合併傳給子程序(claude-agent-sdk 併入 SDK `Options.env`)。 */
  env?: Record<string, string>;
  /** 附加在 claude_code preset system prompt 尾端的文字(目前只放 `.deskmony/notes/` 指路段落)。 */
  systemPrompt?: string;
  /** software="acp" 時的子程序啟動設定。 */
  acpConfig?: AcpAgentConfig;
  /** software="pty" 時的子程序啟動設定。 */
  ptyConfig?: PtyAgentConfig;
  /** software="opencode" 時的子程序啟動設定。 */
  opencodeConfig?: OpencodeAgentConfig;
}

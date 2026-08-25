import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpAdapter, AdapterRegistry, ClaudeAgentSdkAdapter, GenericPtyAdapter, OpenCodeAdapter } from "@deskmony/adapters";
import type { SubagentPort } from "@deskmony/shared";
import { initDb } from "./db.js";
import { ProfileStore, createDefaultProfile } from "./profiles.js";
import { PermissionGateway } from "./permissions/permission-gateway.js";
import { PolicyEngine } from "./permissions/policy-engine.js";
import { SqliteAuditLog } from "./enforcement/audit-log.js";
import { RealNotifier } from "./enforcement/notifier.js";
import { SessionManager } from "./session/session-manager.js";
import { TurnLimiter } from "./cost/turn-limiter.js";
import { CostGovernor } from "./cost/cost-governor.js";
import { WaitingWatchdog } from "./cost/waiting-watchdog.js";
import { RecoveryService } from "./recovery/recovery-service.js";
import { WsGateway } from "./gateway/ws-gateway.js";
import { TeamManager } from "./team/team-manager.js";
import { MessageBus } from "./bus/message-bus.js";
import { WorkspaceManager } from "./workspace/workspace-manager.js";
import { TaskService } from "./tasks/task-service.js";
import { createStaticRequestHandler } from "./http/static-server.js";
import { SettingsStore, migrateLegacyEnabledModelIds } from "./settings/settings-store.js";
import { applyConsoleLogLevel, loadConfig } from "./config/load-config.js";
import { backfillPolicyRuleIds } from "./config/config-file-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * apps/core 進入點 —— headless orchestration server(ARCHITECTURE.md 3.3 節)。
 * M2 Round A:AdapterRegistry 註冊了 ClaudeAgentSdkAdapter(software=
 * "claude-agent-sdk")與 AcpAdapter(software="acp")。
 * M2 Round B:另外註冊 GenericPtyAdapter(software="pty"),SessionManager
 * 依 AgentProfile.software 動態選擇 adapter(見 packages/adapters 的
 * AdapterRegistry)。
 * 這輪(修復 opencode 只是 PTY 直通的問題):補上一直是 TODO 的
 * OpenCodeAdapter(software="opencode",HTTP + SSE 對接 opencode 的 headless
 * server,見 packages/adapters/src/opencode-adapter.ts 頂端對接策略註解)。
 * M3 Round A:新增 TeamManager + MessageBus(ARCHITECTURE.md 第 4 節)。
 * 建構順序刻意如下(見 SessionManager/MessageBus 內的註解):
 *   1. ProfileStore / TeamManager 先建好(TeamManager 依賴 ProfileStore)。
 *   2. SessionManager 建構子需要 TeamManager(建立 team 成員的 session 時
 *      要查 member 資訊),但這時還沒有 MessageBus 實例。
 *   3. MessageBus 建構子需要 SessionManager(查詢 session 狀態、注入
 *      prompt)—— 兩者互相依賴,用 `sessionManager.setTeamBus(messageBus)`
 *      事後注入 TeamBusPort 打破循環。
 * M4 Round A:新增 TaskService + WorkspaceManager(ARCHITECTURE.md 3.3 節、
 * 第 5 節任務協作流程狀態機、第 6 節 TASK/WORKSPACE ERD)。WorkspaceManager
 * 不依賴任何其他 core 模組(只需要 db),TaskService 依賴 TeamManager(查
 * team.workingDir/team member)與 WorkspaceManager(指派任務時建立 git
 * worktree);MessageBus 額外注入 TaskService(選填的第五個建構子參數),
 * 讓 report_status 帶 taskId 時可以嘗試同步任務狀態(見
 * apps/core/src/bus/message-bus.ts 的 reportStatus() 註解)—— 這條依賴是
 * 單向的(TaskService 不依賴 MessageBus),不影響既有的 SessionManager/
 * MessageBus 循環依賴打破方式。
 * 尚不含 Scheduler(見 README 已知限制,規劃於 M4+)。
 *
 * M5 Round A:apps/core 正式化為可獨立部署(headless)——`pnpm start:core`
 * 直接跑編譯後的 dist/index.js,不依賴 Electron。新增兩個環境變數:
 *   - `DESKMONY_BIND_HOST`:WS server 綁定位址,預設 `127.0.0.1`(僅本機,
 *     安全預設)。要對外(例如 `0.0.0.0`)必須明確設定,且必須同時設定
 *     `DESKMONY_AUTH_TOKEN`,否則直接拒絕啟動(見下方 validateBindSafety()
 *     與 README「認證(token-based)」「綁定位址安全預設」章節)。
 *   - `DESKMONY_AUTH_TOKEN`:設定時所有 WS 連線都必須先通過認證才能發送
 *     其他 request(見 apps/core/src/gateway/ws-gateway.ts)。未設定時維持
 *     免認證(本機開發預設),啟動時印警告。
 * 啟動時印出目前綁定位址與是否啟用認證的摘要,但絕不印出 token 本身。
 *
 * M5 Round B:路線圖最後一輪(瀏覽器/行動裝置 client + 安全強化)。
 *   - 任務1(靜態網頁):`WsGateway.listen()` 這輪改成同時服務一般 HTTP GET
 *     請求(見 apps/core/src/http/static-server.ts),把 apps/desktop 既有的
 *     Vite build 產物(`apps/desktop/dist`)透過與 WS **相同的 port** 服務
 *     出去,讓瀏覽器不需要另外架設任何東西就能載入 UI 殼。目錄可由
 *     `DESKMONY_STATIC_DIR` 覆寫(預設依 monorepo 佈局從 `__dirname` 推算,
 *     與 electron/main.ts 的 `resolveCoreEntry()` 用同樣的相對路徑手法)。
 *     這個 HTTP server 完全不檢查 `DESKMONY_AUTH_TOKEN`——靜態頁面本身不需要
 *     認證即可下載(它只是不含機敏資料的前端 UI 殼),真正的存取控制在 WS
 *     層,見 README「瀏覽器存取方式與安全界線」章節的完整說明。
 *   - 任務3(安全強化):`WsGateway` 新增兩個可選環境變數
 *     `DESKMONY_AUTH_RATE_LIMIT_MAX`/`DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`
 *     (比照 `DESKMONY_PERMISSION_TIMEOUT_MS` 的既有慣例),覆寫認證失敗
 *     rate limiting 的門檻/冷卻期(預設 5 次 / 30 秒),主要給 e2e 測試縮短
 *     冷卻期用。
 *
 * M6 Round A:把這輪之前散落在這個檔案(與 db.ts)各處的 `process.env.
 * DESKMONY_*` 讀取,改成「分層合併的設定檔」(defaults → `<DESKMONY_HOME>/
 * config.json` → 環境變數,設計移植自 Paseo 的全域設定,見
 * `apps/core/src/config/load-config.ts`、`packages/shared/src/core-config.ts`
 * 頂端的完整背景說明)。這個檔案現在只呼叫一次 `loadConfig()`,之後全程使用
 * 回傳的 `config`/`effective`,不再有任何一行直接讀 `process.env.DESKMONY_*`
 * ——**唯一例外是 `DESKMONY_AUTH_TOKEN`**,它刻意不是設定檔欄位(見
 * core-config.ts「安全決定」說明),仍然只從環境變數讀。`validateBindSafety()`
 * 這輪改看「合併後」的 `config.daemon.bindHost`,不再只看環境變數——這是
 * 防止「使用者改設定檔就意外把無認證的 core 曝露到區網」的關鍵防線,見 README
 * 「綁定安全檢查用合併後的值」章節。
 */

const LOCAL_ONLY_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 對外綁定卻沒有 token 時直接拒絕啟動(安全預設,不允許無認證對外曝露)。
 * 只用「是否為公認的本機位址」白名單判斷,不嘗試猜測/解析其他情況(例如
 * 機器本身的 LAN IP)是否「其實也算本機」——任何不在白名單內的值一律視為
 * 對外曝露,必須有 token 才放行,寧可誤判過嚴也不要誤判過寬。
 */
function validateBindSafety(bindHost: string, authToken: string | undefined): void {
  const isExternalBind = !LOCAL_ONLY_BIND_HOSTS.has(bindHost);
  if (isExternalBind && !authToken) {
    console.error(
      `[core] 拒絕啟動:DESKMONY_BIND_HOST="${bindHost}" 為對外綁定,但未設定 DESKMONY_AUTH_TOKEN。\n` +
        "[core] 對外綁定時務必同時設定認證 token,否則任何人連上這個位址都能操控 agent 與檔案系統。\n" +
        "[core] 請設定 DESKMONY_AUTH_TOKEN 環境變數後再重新啟動,或移除 DESKMONY_BIND_HOST 改用預設的 127.0.0.1。",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // M6 Round A:設定的唯一載入入口——`defaultStaticDir` 是 M5 Round B 就有的
  // monorepo 佈局推算(往上兩層到 apps/,再進 desktop/dist),依賴這個檔案的
  // `__dirname`,所以由這裡算好傳給通用的 `loadConfig()`(見 load-config.ts
  // 的 `LoadConfigOptions` 註解)。`loadConfig()` 內部若偵測到設定檔 JSON
  // 壞掉或已知欄位型別錯誤,會丟出 `ConfigLoadError`,交由這個函式最外層的
  // `main().catch()` 統一印出 + `process.exit(1)`(既有慣例,見檔案最底部)。
  const defaultStaticDir = path.join(__dirname, "..", "..", "desktop", "dist");
  const { config, effective, configPath, authToken } = loadConfig({ defaultStaticDir });

  // 只做「哪個等級以上才印」的最小過濾(見 load-config.ts 的
  // `applyConsoleLogLevel()`)——預設 "info" 時完全是 no-op,以下所有既有的
  // console.log/warn 呼叫點行為不變。
  applyConsoleLogLevel(config.log.level);

  const { port, bindHost } = config.daemon;
  // 安全關鍵(M6 Round A):這裡看的是「合併後」的 bindHost(可能來自設定檔),
  // 不再只看環境變數——防止使用者改設定檔就意外把無認證的 core 曝露到區網
  // (見 README「綁定安全檢查用合併後的值」章節)。
  validateBindSafety(bindHost, authToken);

  const db = initDb(config.data.dataDir);
  const profiles = new ProfileStore(db);
  // M3 Round A:profile 落地成資料表後,預設 profile 改用冪等 seed(core
  // 重啟多次不會重複插入,也不會覆蓋使用者已修改過的版本)。
  await profiles.ensureSeed(createDefaultProfile(config.workspace.defaultWorkingDir));
  const teamManager = new TeamManager(db, profiles);
  const workspaceManager = new WorkspaceManager(db, config.workspace.worktreesRoot);
  const taskService = new TaskService(db, teamManager, workspaceManager);
  // M5 Round E:「設定」介面的持久化偏好(目前只有「啟用哪些偵測到的 Claude
  // model」,見 apps/core/src/settings/settings-store.ts)。不依賴任何其他
  // core 模組,只需要 db。
  const settingsStore = new SettingsStore(db);
  // 這輪新增(provider 目錄重構):把舊版扁平 `enabledClaudeModelIds` 遷移到
  // per-provider 偏好結構(冪等,見 settings-store.ts 的
  // `migrateLegacyEnabledModelIds()` 完整說明)。務必在任何讀取/寫入
  // per-provider 偏好的邏輯(SessionManager/WsGateway)開始運作之前跑完,
  // 確保第一次讀取就拿到遷移後的一致狀態。
  await migrateLegacyEnabledModelIds(settingsStore);
  // S12 Phase2 R2:保留 claude adapter 的具名參考——SessionManager 建好後要用
  // `setSubagentPort()` 把 `spawn_subagent` 的實作(SpawningChildFromTool)注入
  // 給它(見下方 sessionManager 建好後的注入行),adapter 建立時 SessionManager
  // 還不存在,沿用既有的「先建構、事後注入」手法。
  const claudeAdapter = new ClaudeAgentSdkAdapter();
  // Phase 2(ACP 掛載 team-bus/subagent MCP 工具):保留具名參考——`WsGateway`
  // 建好後要用 `setTokenMinter()` 把 scoped token 的核發/撤銷實作(委派給
  // `WsGateway.mintMcpBridgeToken()`/`revokeMcpBridgeTokensForSession()`)注入
  // 給它,理由同 `claudeAdapter` 的既有先例(見下方注入處的完整說明)。
  const acpAdapter = new AcpAdapter();
  const adapters = new AdapterRegistry()
    .register("claude-agent-sdk", claudeAdapter)
    .register("acp", acpAdapter)
    .register("pty", new GenericPtyAdapter())
    .register("opencode", new OpenCodeAdapter());
  const permissionGateway = new PermissionGateway(config.daemon.permissionTimeoutMs);
  // S1(PolicyEngine + Enforcement 底座):policy.rules/allowedHosts 只吃啟動時
  // 合併好的設定(見 packages/shared/src/core-config.ts 的 `ConfigSetFilePatchSchema`
  // 不含 `policy` 的說明——`config.setFile` 這條「一般設定 patch」通道遠端仍不可
  // 改政策,也因此這裡的「啟動時讀一次」不需要熱重載機制;但 in-memory 的
  // `PolicyEngine.rules` 本身**不是**靜態的——`addRule()`/`removeRule()` 讓它
  // 在 session 內即時變化,2026-08-25 起 `policy.addRule`/`removeRule` 這兩個
  // gateway 方法(見 docs/DECISIONS.md §G)讓本機與遠端都能觸發這個既有的
  // 即時生效機制,只是新增了「除了 rememberRule 這個既有入口,現在多一個
  // 獨立的管理入口」,不是新發明熱重載)。AuditLog 落地到 `enforcement_audit`
  // 表,Notifier 這輪是 stub(S11 才接真通道)。
  //
  // 2026-08-25 新增:`backfillPolicyRuleIds()` 補上舊規則缺少的 `id`(見該函式
  // 註解)——**必須**用它的回傳值(而不是原始 `config.policy.rules`)建構
  // `PolicyEngine`,否則記憶體裡的規則會跟剛寫回 config.json 的版本不一致。
  const backfilledPolicyRules = backfillPolicyRuleIds(configPath, config.policy.rules);
  const policyEngine = new PolicyEngine({ rules: backfilledPolicyRules, allowedHosts: config.policy.allowedHosts });
  const auditLog = new SqliteAuditLog(db);
  // S11(Notification):`DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS` 比照
  // `DESKMONY_YOLO_DURATION_MS` 的既有慣例——純粹讓 e2e 能在合理時間內驗證
  // 「批次視窗到期後彙總送出」,不經過 `loadConfig()` 的分層合併,也不落地
  // 任何設定檔(見 enforcement/notifier.ts 的 `RealNotifierOptions.batchIntervalMsOverride` 註解)。
  const notificationBatchIntervalMsOverride = process.env.DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS
    ? Number(process.env.DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS)
    : undefined;
  // §4.1 深連結的 http base——這裡用「合併後」的 bindHost/port(與
  // `validateBindSafety()` 同一份合併後的值),對外綁定/隧道情境下這個連結
  // 是否能在外網打開不是這裡該處理的事(見 notification_detail.md §4.1:
  // 「若 core 只綁 loopback,此連結在外網無法開啟——這是正常的」)。
  const notifier = new RealNotifier(config.notification, auditLog, {
    batchIntervalMsOverride:
      notificationBatchIntervalMsOverride && Number.isFinite(notificationBatchIntervalMsOverride)
        ? notificationBatchIntervalMsOverride
        : undefined,
    linkBase: `http://${bindHost}:${port}`,
  });
  // S5(dispose-gate):TaskService 需要 Notifier 才能在「無 acceptance / 連續
  // 驗收失敗」時 escalate 給人類(見 task-service.ts 的 applyHumanReviewGate()/
  // applyAcceptanceRunGate())——同樣的「先建構、事後用 setter 注入」手法,
  // taskService 在 notifier 之前建構(見上方 M4 Round A 建構順序註解),不需要
  // 等 SessionManager 就緒(這條路徑完全不查 sessionId,見 RealNotifier 的
  // "task-review" 分支),所以直接在這裡注入即可。
  taskService.setNotifier(notifier);
  // S7(auto-mode-and-yolo):`DESKMONY_YOLO_DURATION_MS` 純粹是 e2e 測試用的
  // 覆寫(見 session-manager.ts 的 `DEFAULT_YOLO_DURATION_MS` 頂端說明)——與
  // `DESKMONY_AUTH_TOKEN` 一樣刻意留在這個檔案之外的「唯一例外」之列,不經過
  // `loadConfig()` 的分層合併,也不落地任何設定檔。
  const yoloDurationMsOverride = process.env.DESKMONY_YOLO_DURATION_MS
    ? Number(process.env.DESKMONY_YOLO_DURATION_MS)
    : undefined;
  // Phase 2(ACP scoped MCP bridge token):同樣是純 e2e 測試用的覆寫(比照
  // 上面 DESKMONY_YOLO_DURATION_MS 的既有慣例)——縮短 scoped token 的絕對
  // 過期保底時間(預設 24 小時),讓 e2e 能在合理時間內決定性地驗證「過期後
  // 拒絕」這條規則,不落地任何設定檔。
  const mcpBridgeTokenTtlMsOverride = process.env.DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS
    ? Number(process.env.DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS)
    : undefined;
  // S3b(CostGovernor):三個成本治理元件,建構順序刻意在 SessionManager 之前
  // ——`TurnLimiter`/`CostGovernor`/`WaitingWatchdog` 都需要在 trip 時回頭呼叫
  // `SessionManager.interrupt()`/查詢 session 狀態,但 `SessionManager` 的
  // 建構子又需要拿到這三者(接 `usage`/`tool-call` 事件、`sendPrompt()` 前的
  // 預算檢查)——與既有的 `setTeamBus()`/`setClientPresence()` 同一個「先建構、
  // 事後用 setter 打破循環」手法(見這三個類別各自的 `setSessionControl()`
  // 註解)。`CostGovernor` 需要 `taskService`(已在上面建好,無循環)。
  //
  // §0.1:`TurnLimiter` 不依賴 usage,是「Claude Code 經 ACP」這類完全拿不到
  // 用量的後端唯一的保護,`config.budget.turn` 預設寬鬆(30 分鐘/200 次工具
  // 呼叫)。`DESKMONY_TURN_LIMITER_CHECK_INTERVAL_MS` 比照
  // `DESKMONY_YOLO_DURATION_MS` 的既有慣例,純粹讓 e2e 能在合理時間內驗證
  // 「定時檢查」這條規則,不落地任何設定檔。
  const turnLimiterCheckIntervalMsOverride = process.env.DESKMONY_TURN_LIMITER_CHECK_INTERVAL_MS
    ? Number(process.env.DESKMONY_TURN_LIMITER_CHECK_INTERVAL_MS)
    : undefined;
  const turnLimiter = new TurnLimiter(
    config.budget.turn,
    auditLog,
    notifier,
    turnLimiterCheckIntervalMsOverride && Number.isFinite(turnLimiterCheckIntervalMsOverride)
      ? turnLimiterCheckIntervalMsOverride
      : undefined,
  );
  const costGovernor = new CostGovernor(db, taskService, config.budget, auditLog, notifier);
  // S3b §4:T1/T2 的預設值(6h/72h)與掃描間隔(10 分鐘)同樣開放 e2e 覆寫,
  // 理由同上。
  const waitingT1MsOverride = process.env.DESKMONY_WAITING_T1_MS ? Number(process.env.DESKMONY_WAITING_T1_MS) : undefined;
  const waitingT2MsOverride = process.env.DESKMONY_WAITING_T2_MS ? Number(process.env.DESKMONY_WAITING_T2_MS) : undefined;
  const waitingScanIntervalMsOverride = process.env.DESKMONY_WAITING_SCAN_INTERVAL_MS
    ? Number(process.env.DESKMONY_WAITING_SCAN_INTERVAL_MS)
    : undefined;
  const waitingWatchdog = new WaitingWatchdog(
    auditLog,
    notifier,
    waitingT1MsOverride && Number.isFinite(waitingT1MsOverride) ? waitingT1MsOverride : undefined,
    waitingT2MsOverride && Number.isFinite(waitingT2MsOverride) ? waitingT2MsOverride : undefined,
    waitingScanIntervalMsOverride && Number.isFinite(waitingScanIntervalMsOverride) ? waitingScanIntervalMsOverride : undefined,
  );
  const sessionManager = new SessionManager(
    adapters,
    db,
    profiles,
    permissionGateway,
    teamManager,
    settingsStore,
    policyEngine,
    auditLog,
    notifier,
    configPath,
    turnLimiter,
    costGovernor,
    yoloDurationMsOverride && Number.isFinite(yoloDurationMsOverride) ? yoloDurationMsOverride : undefined,
  );
  // 見上方建構順序說明:SessionManager 建好後才能回頭注入(同 setTeamBus()/
  // setClientPresence() 的既有手法)。
  turnLimiter.setSessionControl(sessionManager);
  costGovernor.setSessionControl(sessionManager);
  waitingWatchdog.setSessionControl(sessionManager);
  // S8(agent-lifecycle):TaskService 需要 SessionManager 才能對 ephemeral
  // member 自動 spawn/dispose session(§2.1/§2.2)——同樣的「先建構、事後用
  // setter 打破循環」手法(taskService 建構時 sessionManager 還不存在,見上方
  // M4 Round A 註解的建構順序說明)。
  taskService.setSessionControl(sessionManager);
  // S3b §6「崩潰重啟」:從 DB 還原 rollup 快取與目前是否已超標,必須在任何
  // session 建立/usage 事件抵達之前完成,否則重啟後的空窗期會讓
  // `checkSendPromptAllowed()` 誤判為「未超標」而放行(見 cost-governor.ts 的
  // `initialize()` 完整說明)。
  await costGovernor.initialize();
  // S11:`RealNotifier` 需要把 sessionId 換成人類可讀的顯示名(§4 的
  // `sessionNames`),但建構時 `SessionManager` 還不存在(`SessionManager` 的
  // 建構子本身就需要 `notifier`)——與 `setTeamBus()`/`setClientPresence()` 同一
  // 個事後注入手法(見 enforcement/notifier.ts 的 `SessionInfoPort` 註解)。
  notifier.setSessionInfo({
    getSessionTitle: async (sessionId) => (await sessionManager.getSession(sessionId))?.title,
  });
  // S2(message-budget):與 costGovernor 同樣的建構順序考量——MessageBus 需要
  // 已建好的 sessionManager(查詢 session 狀態、呼叫 sendPrompt/interrupt),
  // 所以放在 sessionManager 之後;`config.messageBudget`/`auditLog`/`notifier`
  // 都已在上面建好,無循環依賴。
  const messageBus = new MessageBus(db, teamManager, sessionManager, profiles, taskService, config.messageBudget, auditLog, notifier);
  sessionManager.setTeamBus(messageBus);
  // S12 Phase2 R2+R4+R5:注入 `spawn_subagent`/`send_to_subagent`/
  // `list_subagents` 的 SubagentPort——子 session 預設沿用父 session 自己的
  // profile,agent 也可以呼叫 list_profiles 查完可用選項後自行指定別的
  // profile(見 session-manager.ts 的 spawnChildFromTool());`send_to_subagent`
  // (R4)讓 agent 對已經開好的子 session 追加訊息(見 sendToChildFromTool());
  // `list_subagents`(R5)讓 agent 查自己名下有哪些子——包含使用者透過 UI
  // 手動開、agent 完全不知情的那些(見 listChildrenFromTool())。與
  // setTeamBus() 同一位置群組:SessionManager 已建好,正是能回頭注入的時機。
  //
  // Phase 2(ACP 掛載 team-bus/subagent MCP 工具):抽成具名變數,**同一個
  // 實例**同時注入給 `claudeAdapter` 與 `acpAdapter`——兩個 adapter 對
  // `spawn_subagent`/`send_to_subagent`/`list_subagents`/`list_profiles` 的
  // 行為(誰能對誰做什麼、看到哪些欄位)必須完全一致,共用同一個物件參考從
  // 結構上保證不會漂移,比各自組一份重複的物件字面量更不容易之後兩邊不同步。
  // **這是刻意的取捨**:讓 `AcpAdapter` 也拿到 subagentPort,代表**所有**
  // ACP session(不只是 team 成員,含目前唯一在測的 Gemini 個人單機情境)都
  // 會在 spawn 時核發一個 scoped token、掛載 mcp-bridge-server.ts(見
  // `AcpAdapter.spawn()`/`buildMcpBridgeServer()`)——多一個子行程與一條
  // (惰性建立,只在 agent 真的呼叫工具時才連線)WS 連線。選擇補齊這一步(而
  // 非只掛 team-bus)的理由:(a) 這輪的目標本來就是讓 ACP 也具備與
  // ClaudeAgentSdkAdapter 對等的 team-bus **與** subagent 兩種能力,只掛一半
  // 是不完整的功能;(b) 唯有這樣接,`session.spawnChildForSubagent`/
  // `session.sendToChild`/`session.listChildren`/`profile.listForSubagent`
  // 這四個這輪新增的 gateway 方法才能透過標準的 `apps/core/dist/index.js`
  // 產物被 e2e 決定性測試真正走過一次完整管線(見
  // scripts/e2e-gateway.mjs 的 `scopedMcpBridgeTokenSmokeTest()`),而不是
  // 只測到型別/白名單邏輯本身。若之後覺得這個資源足跡不划算,把下面這一行
  // `acpAdapter.setSubagentPort(subagentPort);` 刪掉即可完全回退,`AcpAdapter`
  // 本身的 `subagentPort` 欄位/setter/spawn() 內的累加掛載邏輯不需要跟著改。
  const subagentPort = {
    spawnChild: (input: Parameters<SubagentPort["spawnChild"]>[0]) => sessionManager.spawnChildFromTool(input),
    sendToChild: (input: Parameters<SubagentPort["sendToChild"]>[0]) => sessionManager.sendToChildFromTool(input),
    listChildren: (input: Parameters<SubagentPort["listChildren"]>[0]) => sessionManager.listChildrenFromTool(input.parentSessionId),
    // listProfiles:只回傳 agent 決策需要的最小欄位,不把 env/mcpConfig 等可能
    // 含密鑰的欄位送進 agent 的對話 context(見 SubagentPort.listProfiles() 的
    // 介面註解)。
    listProfiles: async () => {
      const list = await profiles.list();
      return list.map((p) => ({ id: p.id, name: p.name, software: p.software, model: p.model, role: p.role }));
    },
  };
  claudeAdapter.setSubagentPort(subagentPort);
  acpAdapter.setSubagentPort(subagentPort);
  // L4 §2「已知限制」的對稱補洞:core 啟動時重新計算每個 context 目前的訊息數,
  // 還原 trippedContexts——否則崩潰重啟會讓「這個 context 已經 trip」這個
  // 記憶體旗標消失,變相多放行一則訊息(見 message-bus.ts 的 `initialize()`
  // 完整說明)。必須在 gateway 開始接受連線(進而可能有 agent 呼叫 send_message)
  // 之前完成。
  await messageBus.initialize();

  // S6(crash-recovery):純組合層,不擁有任何狀態,見 recovery-service.ts 頂端
  // 說明。放在這裡是因為它需要 sessionManager/profiles/teamManager/
  // taskService/workspaceManager 全部建構完成——這幾個都已經在上面建好了。
  const recoveryService = new RecoveryService(sessionManager, profiles, teamManager, taskService, workspaceManager);

  const gateway = new WsGateway(
    sessionManager,
    profiles,
    teamManager,
    messageBus,
    taskService,
    workspaceManager,
    settingsStore,
    costGovernor,
    recoveryService,
    notifier,
    effective,
    configPath,
    authToken,
    config.daemon.authRateLimit.max,
    config.daemon.authRateLimit.cooldownMs,
    mcpBridgeTokenTtlMsOverride && Number.isFinite(mcpBridgeTokenTtlMsOverride) ? mcpBridgeTokenTtlMsOverride : undefined,
  );
  // S7 L4 §2.1:`ExecContext` 的 `attended`/`local` 是**環境事實**(現在有沒有
  // 人看得到彈窗、有沒有遠端 client 連線中),只有 Gateway 知道。與上面
  // `setTeamBus()` 同一個解耦手法:Gateway 的建構子需要 SessionManager,所以
  // 反向依賴只能在 Gateway 建好之後用 setter 注入(見 session-manager.ts 的
  // `ClientPresencePort`)。**務必在 `gateway.listen()` 之前注入**——不然第一
  // 個連上來的 client 有機會在注入完成前就觸發權限決策,那一筆會用退化預設值
  // (attended=false)決定逾時語意。
  sessionManager.setClientPresence(gateway);
  // Phase 2(ACP 掛載 team-bus/subagent MCP 工具):`AcpAdapter` 需要
  // `WsGateway` 才能核發/撤銷 scoped MCP bridge token(見
  // `apps/core/src/gateway/ws-gateway.ts` 的 `mintMcpBridgeToken()`/
  // `revokeMcpBridgeTokensForSession()`)——與上面 `setClientPresence()` 同一
  // 個解耦手法:`AcpAdapter` 建構時 `WsGateway` 還不存在,`WsGateway` 的建構子
  // 又需要 `SessionManager`,只能在 `WsGateway` 建好之後用 setter 事後注入。
  acpAdapter.setTokenMinter({
    mint: (scope) => gateway.mintMcpBridgeToken(scope),
    revokeForSession: (sessionId) => gateway.revokeMcpBridgeTokensForSession(sessionId),
  });

  // M5 Round B 任務1:apps/desktop 的 Vite build 產物(dist/),與 WS 共用
  // 同一個 port。`config.features.staticDir` 已經是 load-config.ts 算好的最終值
  // (env/設定檔覆寫,或前面算好的 monorepo 佈局預設值,見 loadConfig() 呼叫處)。
  const desktopDistDir = config.features.staticDir ?? defaultStaticDir;
  const staticDirReady = existsSync(path.join(desktopDistDir, "index.html"));
  if (!staticDirReady) {
    console.warn(
      `[core] 警告:找不到瀏覽器 UI 靜態檔案(${desktopDistDir}/index.html)。瀏覽器/手機 client 將無法載入頁面` +
        "(WS API 本身不受影響,桌面殼透過 Electron 載入前端不受此影響)。" +
        "請先執行 pnpm build(或設定 DESKMONY_STATIC_DIR/features.staticDir 指向正確目錄)。",
    );
  }
  const staticHandler = createStaticRequestHandler(desktopDistDir);

  // S6(crash-recovery)L4 §3:啟動對帳——**必須在開 gateway 之前**執行
  // (crash-recovery_detail.md §3),否則有機會出現「gateway 已經接受連線、
  // UI 已經在顯示 session 清單,但對帳還沒把孤兒標記出來」的短暫不一致窗口。
  // DB 損毀時 `reconcileOnStartup()` 內的 `db.select()`/`db.update()` 會直接
  // 拋出例外,原樣往上傳給 `main().catch()`(見該函式最外層,同 config 損毀
  // 的既有作風:啟動失敗並明確報錯,不帶著壞資料啟動)。
  const reconcileResult = await sessionManager.reconcileOnStartup();
  if (reconcileResult.count > 0) {
    console.warn(
      `[core] 啟動對帳:發現 ${reconcileResult.count} 個上次未被乾淨關閉的 session(視為崩潰中斷),` +
        `已標記為 interrupted,等待人工於復原視圖分流(繼續/接手/重跑/放棄): ${reconcileResult.sessionIds.join(", ")}`,
    );
    auditLog.appendRecoveryReconcile({ count: reconcileResult.count, sessionIds: reconcileResult.sessionIds, ts: Date.now() });
  } else {
    console.log("[core] 啟動對帳:上次是乾淨關閉,沒有發現中斷的 session。");
  }

  gateway.listen(port, bindHost, staticHandler);

  // 啟動摘要(M5 Round A 任務1):印出目前綁定位址與是否啟用認證,但絕不
  // 印出 token 本身(即使是 DEBUG 等級也不印,避免經由終端機 log/log 檔外流)。
  // M6 Round A:同樣不把整個 `config`/`effective` 物件原樣印出(即使內容本身
  // 不含機敏資料),只印目前既有的這幾個具體欄位。
  const isExternalBind = !LOCAL_ONLY_BIND_HOSTS.has(bindHost);
  console.log(
    `[core] 綁定位址: ws://${bindHost}:${port}${isExternalBind ? "(對外綁定)" : "(僅本機)"}`,
  );
  console.log(`[core] 認證: ${authToken ? "已啟用(DESKMONY_AUTH_TOKEN 已設定)" : "未啟用(免認證)"}`);
  if (!authToken) {
    console.warn(
      "[core] 警告:未設定 DESKMONY_AUTH_TOKEN,目前允許任何連上這個 WS 位址的 client 免認證發送 request。" +
        "僅建議本機開發使用;若這個位址對外可及,請務必設定 DESKMONY_AUTH_TOKEN。",
    );
  }
  console.log(
    `[core] 瀏覽器 UI: http://${bindHost}:${port}/${
      staticDirReady ? "" : "(尚未 build,目前會回傳 404,見上方警告)"
    } —— 靜態頁面本身不需認證即可下載,但頁面連上 WS 後,若 core 已啟用認證,` +
      "仍必須送出正確 token 才能使用(見 README「瀏覽器存取方式與安全界線」)。",
  );
  console.log(`[core] 設定檔: ${configPath}(DESKMONY_HOME=${path.dirname(configPath)})`);

  // S6(crash-recovery)L4 §2:優雅關閉主動收尾——這是「`closed` 與
  // `interrupted` 能被明確區分」的關鍵(crash-recovery_detail.md 開頭的驗收
  // 標準)。改成 async,並在 `sessionManager.shutdownAll()` 完成(或逾時)後
  // 才 `process.exit(0)`。**5 秒逾時保護**:寧可留下孤兒被下次啟動的對帳抓到,
  // 也不要卡住不關(見該文件 §2「shutdown 逾時保護」)。
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // SIGINT/SIGTERM 可能在極短時間內重複觸發,避免重入。
    shuttingDown = true;
    console.log("[core] shutting down...");
    gateway.close(); // 先停止接受新請求。
    turnLimiter.dispose();
    waitingWatchdog.dispose();
    await Promise.race([
      sessionManager.shutdownAll(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn(
            `[core] shutdownAll() 逾時(${SHUTDOWN_TIMEOUT_MS}ms),放棄剩餘 session 的收尾直接退出` +
              "——這些 session 下次啟動會被對帳視為崩潰(保守方向正確,見 crash-recovery_detail.md §6)。",
          );
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[core] fatal error during startup:", err);
  process.exit(1);
});

import type { AgentDetectionEntry } from "./detect.js";
import type { AgentSoftware } from "./agent-profile.js";

/**
 * agent-target.ts(M5 Round E 新增):把「一個偵測到的 agent 軟體」推導成
 * 「一個實際可以建立 session 的 (software, command) 組合」的純函式。
 *
 * ---- 為什麼需要這一層(務必先讀,避免誤改成別的映射)----
 *
 * `apps/core/src/index.ts` 的 `AdapterRegistry` 註冊了四種可建立 session 的
 * software:`claude-agent-sdk` / `acp` / `pty` / `opencode`(這輪新增
 * `OpenCodeAdapter`,見 packages/adapters/src/opencode-adapter.ts)。而
 * `apps/core/src/detect/agent-detector.ts` 的偵測結果(`AgentDetectionEntry.
 * software`)卻會把 gemini/claude CLI 分類成 `acp`、codex 分類成
 * `codex`——`codex` 這個分類目前仍然沒有對應的 adapter,若 UI 直接照抄偵測
 * 結果的 `software` 去建 profile,建出來的 session 會在
 * `SessionManager.createSession()` 因 `adapters.get(software)` 找不到對應
 * adapter 而直接失敗。
 *
 * 因此這裡的 `deriveDefaultAgentTarget()` 是「ProfileCreateDialog 選了某個
 * 偵測項之後,預設要帶入哪個 (software, command)」唯一的推導邏輯,原則:
 *   - 內嵌 `claude-agent-sdk`:維持原樣,不需要 command(ClaudeAgentSdkAdapter
 *     直接呼叫 SDK,不 spawn 任何子程序)。
 *   - 偵測分類為 `opencode`:映射成 `software: "opencode"`,`command` 帶入
 *     偵測到的完整路徑——`OpenCodeAdapter` 這輪已經實作(HTTP + SSE 對接
 *     opencode 的 headless server API,見 opencode-adapter.ts 頂端對接策略
 *     註解),不再需要退化成 PTY 終端直通(修復「opencode 只是把 TUI 塞進
 *     終端視圖」的問題)。
 *   - 其餘外部 CLI(偵測分類為 acp/codex/pty,codex 目前仍無對應 adapter):
 *     一律預設映射成 `software: "pty"`,`command` 帶入偵測到的完整路徑
 *     (`entry.path`)——PTY 直通對任何可互動的 CLI 都保證能跑(它就是把
 *     stdin/stdout 接到終端,不要求對方講任何結構化協議),不像 ACP 那樣
 *     要求對方是真的 ACP server(bare `claude`/`gemini` 直接跑通常不是)。
 *
 * 若使用者明確知道自己的 CLI 有支援 ACP(`--experimental-acp` 之類),可以
 * 透過 `canUseAcpAdvanced()`/`deriveAcpAdvancedTarget()` 取得「進階:改用
 * ACP」的另一個候選——但那必須是使用者主動選擇的例外路徑,不是這裡的預設值
 * (`deriveDefaultAgentTarget()` 只會回傳 claude-agent-sdk/opencode/pty 三者
 * 之一,絕不會回傳 acp/codex,見下方函式實作與其單元測試,
 * scripts/e2e-gateway.mjs 步驟22 的決定性斷言)。
 */

export interface DerivedAgentTarget {
  /** 一定是 AdapterRegistry 實際註冊過的四種之一——絕不會是 codex。 */
  software: Extract<AgentSoftware, "claude-agent-sdk" | "acp" | "pty" | "opencode">;
  /** claude-agent-sdk 不需要 command;其餘 software 一律帶入偵測到的完整路徑。 */
  command?: string;
}

/**
 * 這個偵測項的「預設可建立」目標——ProfileCreateDialog 選到某個偵測項時,
 * command 欄位應該直接帶入這個函式的回傳值,不需要使用者手動輸入。
 */
export function deriveDefaultAgentTarget(entry: AgentDetectionEntry): DerivedAgentTarget {
  if (entry.software === "claude-agent-sdk") {
    return { software: "claude-agent-sdk" };
  }
  if (entry.software === "opencode") {
    // OpenCodeAdapter 已實作(HTTP + SSE),不再需要退化成 pty(見上方檔案
    // 頂端註解)。`entry.path` 未偵測到時(installed=false)理論上不該被
    // UI 選中,這裡仍保守地允許 command 為 undefined。
    return { software: "opencode", command: entry.path };
  }
  // codex/acp/pty 分類的外部 CLI 一律預設走 PTY 直通(見上方檔案頂端註解)
  // ——`entry.path` 未偵測到時(installed=false)理論上不該被 UI 選中,這裡
  // 仍保守地允許 command 為 undefined,呼叫端(ProfileCreateDialog)應只讓
  // installed=true 的項目可被選取。
  return { software: "pty", command: entry.path };
}

/**
 * 這個偵測項是否有「進階:改用 ACP」的選項可用——只有偵測邏輯本身就把它歸類
 * 為 `software: "acp"` 的項目(目前是 claude-code-cli / gemini-cli,見
 * apps/core/src/detect/agent-detector.ts 的 AGENT_ALLOWLIST)才有意義,且
 * 必須偵測到完整路徑。opencode/codex/aider 沒有這個選項——它們的偵測分類
 * 本身就不是 acp,沒有理由假設它們講 ACP 協議。
 */
export function canUseAcpAdvanced(entry: AgentDetectionEntry): boolean {
  return entry.software === "acp" && Boolean(entry.path);
}

/**
 * 使用者明確選擇「進階:改用 ACP」時的目標(僅在 `canUseAcpAdvanced()` 為
 * true 時才有意義,否則回傳 undefined)。
 */
export function deriveAcpAdvancedTarget(entry: AgentDetectionEntry): DerivedAgentTarget | undefined {
  if (!canUseAcpAdvanced(entry)) return undefined;
  return { software: "acp", command: entry.path };
}

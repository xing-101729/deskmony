/**
 * scripts/lib/e2e-providers.mjs
 *
 * 2026-10-02(P2:移除 profile):e2e 指定 fake 後端(fake ACP agent / fake opencode server /
 * fake PTY)的唯一方式。
 *
 * 過去 e2e 是 `profile.create({ acpConfig: { command, args } })` 再 `session.create({ agentProfileId })`。
 * profile 移除後,session 只能用 core 的 `AgentCatalog` 裡的 provider 建立,而 gateway 沒有任何能新增
 * 任意 command 的方法(否則等於遠端可執行任意程式)。唯一的入口是 core 啟動時讀的環境變數
 * `DESKMONY_E2E_EXTRA_PROVIDERS`(JSON 陣列,元素 = `ProviderCatalogEntry` 欄位 + `command`/`args`,
 * 見 apps/core/src/agents/agent-catalog.ts 的完整安全說明)——只有啟動 core 的人(這些 e2e 腳本)能設。
 *
 * 用法:啟動 core 子行程時,把 `e2eProvidersEnv()` 展開進 env;之後直接
 * `session.create({ providerId: FAKE_ACP, workingDir, title })`。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const E2E_PROVIDERS_ENV_NAME = "DESKMONY_E2E_EXTRA_PROVIDERS";

/** 三個標準 fake provider 的 id。 */
export const FAKE_ACP = "e2e-fake-acp";
export const FAKE_OPENCODE = "e2e-fake-opencode";
export const FAKE_PTY = "e2e-fake-pty";

/**
 * 2026-10-03:宣告 `family: "opencode"` 的 fake ACP provider(**不在** `standardFakeProviders()` 裡,需要的測試用
 * `e2eProvidersEnv([fakeAcpOpencodeProvider()])` 明確加入)。真實的 `opencode-acp` provider 會被 core 當成已偵測到的
 * opencode 執行檔——e2e 沒有真的 opencode,這個 provider 讓測試走得到「opencode 家族的 ACP 子行程啟動時注入
 * `OPENCODE_CONFIG_CONTENT`」的邏輯(見 packages/adapters/src/acp-adapter.ts、opencode-config.ts)。
 */
export const FAKE_ACP_OPENCODE = "e2e-fake-acp-opencode";
export function fakeAcpOpencodeProvider() {
  return {
    id: FAKE_ACP_OPENCODE,
    label: "E2E Fake ACP (opencode family)",
    software: "acp",
    family: "opencode",
    command: process.execPath,
    args: [path.join(SCRIPTS_DIR, "fake-acp-agent.mjs")],
  };
}

/** fake opencode 的 model 清單(給需要 `session.setModel`/model 選單的測試用,沒有它 supportsModelSelection 為 false)。 */
export const FAKE_OPENCODE_MODELS = [
  { id: "fake/model-a", label: "Fake Model A" },
  { id: "fake/model-b", label: "Fake Model B" },
];

/** 三個標準 fake provider(都以 `process.execPath` 跑 scripts/ 底下對應的假後端)。 */
export function standardFakeProviders() {
  return [
    {
      id: FAKE_ACP,
      label: "E2E Fake ACP",
      software: "acp",
      command: process.execPath,
      args: [path.join(SCRIPTS_DIR, "fake-acp-agent.mjs")],
    },
    {
      id: FAKE_OPENCODE,
      label: "E2E Fake OpenCode",
      software: "opencode",
      supportsModelSelection: true,
      models: FAKE_OPENCODE_MODELS,
      // opencode 的 args 語意是「完全取代預設的 serve 參數」(見 OpencodeAgentConfigSchema 註解)——
      // 這正是 fake server 需要的:它不是真的 opencode,不接受 `serve --port ...`。
      command: process.execPath,
      args: [path.join(SCRIPTS_DIR, "fake-opencode-server.mjs")],
    },
    {
      id: FAKE_PTY,
      label: "E2E Fake PTY",
      software: "pty",
      command: process.execPath,
      args: [path.join(SCRIPTS_DIR, "fake-pty-echo.mjs")],
    },
  ];
}

/**
 * 要併進 core 子行程 env 的 `DESKMONY_E2E_EXTRA_PROVIDERS`。`extra` 是這支測試額外需要的 provider
 * (例如指向特殊 wrapper 的 ACP provider)。
 */
export function e2eProvidersEnv(extra = []) {
  return { [E2E_PROVIDERS_ENV_NAME]: JSON.stringify([...standardFakeProviders(), ...extra]) };
}

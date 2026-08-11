import { execFile } from "node:child_process";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type AgentDetectionEntry, type AgentSoftware, type DetectedModel } from "@deskmony/shared";

/**
 * agent-detector.ts(M5 Round D 新增):偵測本機裝了哪些已知 agent CLI(以及
 * 內嵌的 Claude Agent SDK),供「設定」介面(`env.detectAgents` gateway 方法,
 * 見 apps/core/src/gateway/ws-gateway.ts)使用。
 *
 * ---- 安全設計(這個檔案最重要的部分,務必維持)----
 *
 * 1. **固定 allowlist,不接受外部輸入**:`AGENT_ALLOWLIST` 是這個檔案內寫死
 *    的常數陣列,`detectAllAgents()`(唯一真正組裝完整偵測結果、被 gateway
 *    呼叫的函式)不接受任何參數 —— 呼叫端(UI)沒有辦法透過這個管道要求
 *    偵測任意命令。`probeCommand()` 本身雖然接受一個 `command: string` 參數
 *    (方便下方的 allowlist 迴圈呼叫,也方便 e2e 直接呼叫驗證探測邏輯本身,
 *    見 scripts/e2e-gateway.mjs 步驟21),但它**不是** gateway 方法、也不會
 *    透過 WS 暴露給任何 client——`env.detectAgents` 這個唯一對外的入口完全
 *    不吃參數,見 packages/shared/src/gateway.ts 對應的 schema 註解。
 * 2. **一律 `execFile` 陣列參數,不開 shell、不組字串**(比照
 *    apps/core/src/workspace/workspace-manager.ts 呼叫 git 的既有寫法):
 *    找執行檔用 `where`/`which`(本身是原生執行檔,不需要 shell),確定完整
 *    路徑後才呼叫 `--version`。Windows 上 `.cmd`/`.bat` 這類 shim 執行檔
 *    (例如 npm 全域安裝的 `gemini.cmd`)在 `shell:false` 時 Node 會直接丟出
 *    `EINVAL`(見 packages/adapters/src/acp-adapter.ts 的
 *    `resolveWindowsSpawnCommand()` 對同一問題的詳細說明)——這裡採用該檔案
 *    記錄的其中一個選項:「用 `where` 拿到完整路徑後,依副檔名決定是否需要
 *    `shell:true`」。因為要下的引數固定只有 `--version`(或呼叫端指定的
 *    `versionArgs`,同樣是寫死的常數,不是外部輸入),真正需要手動 quoting
 *    的只有「解析出來的完整路徑本身」(可能含空白,例如
 *    `C:\Program Files\nodejs\npm.cmd`)——`quoteForShell()` 處理這件事,
 *    邏輯與 acp-adapter.ts 的 `quoteWindowsShellArg()` 相同,獨立在這裡重新
 *    寫一份小函式而非匯入該檔案內部(未 export)的版本,避免額外的跨套件
 *    private 依賴。
 * 3. **每次探測都有逾時**:`PROBE_TIMEOUT_MS`(3000ms)套用在「找執行檔」
 *    與「跑 --version」這兩次子程序呼叫上,逾時/找不到/非 0 結束一律當
 *    「未安裝或無法判定」處理(`resolve(undefined)`,不 reject、不拋錯),
 *    確保任何一個探測卡住都不會拖垨整個 `detectAllAgents()`(內部用
 *    `Promise.all` 平行探測,單一項目最壞情況 ~2 個逾時週期,不會被其他
 *    項目的逾時拖著排隊)。
 * 4. **model 偵測務實降級**:`claude-agent-sdk`(內嵌)有 `ANTHROPIC_API_KEY`
 *    時會呼叫 Anthropic 官方 Models API(`GET /v1/models`,見下方
 *    `detectClaudeModelsFromApi()`)動態列出真正可用的清單;沒有金鑰或查詢
 *    失敗一律回空陣列 + `modelsNote` 說明原因(**不**內建任何寫死的 model
 *    清單當退路——舊清單會隨 Anthropic 發布新 model/棄用舊 model 而過時,
 *    顯示過時清單比完全不顯示更容易誤導使用者)。各外部 CLI 除了
 *    `opencode`(見 `modelsCommandArgs`)以外只做「安裝與否 + 版本」,`models`
 *    回空陣列 + `modelsNote` 說明「模型由該工具自行管理」——不臆測、不嘗試跑
 *    任何可能互動式/昂貴的「列出 model」指令。
 */

const PROBE_TIMEOUT_MS = 3_000;

/** Anthropic Models API(`client.models.list()`)逾時——單純一次 HTTPS 請求,
 *  不像 `opencode models` 需要啟動整個 CLI process,5 秒對正常網路狀況綽綽
 *  有餘;逾時/任何錯誤一律 fail-soft 回空陣列(見 `detectClaudeModelsFromApi()`),
 *  不影響 `detectAllAgents()` 其餘偵測項目。 */
const CLAUDE_MODELS_API_TIMEOUT_MS = 5_000;

/** 「列出 model」子命令(目前只有 `opencode models`)實測比 `--version` 慢得多
 *  ——本機實測透過 `shell:true`(.cmd shim)跑一次要 4~5 秒,3000ms 的
 *  `PROBE_TIMEOUT_MS` 幾乎每次都會在拿到結果前把它殺掉,導致 `models` 靜默
 *  退回空陣列、UI 上完全不會出現 model 選單,而且沒有任何錯誤訊息可看
 *  (fail-soft 設計吞掉了逾時)。獨立開一個較長的逾時,只套用在
 *  `runModelsCommand()`,不影響 `--version` 探測的既有 3000ms 節奏。 */
const MODELS_PROBE_TIMEOUT_MS = 10_000;

/** Windows 上 `where` 可能列出同名但不可直接執行的候選(例如 npm 同時安裝了
 *  一個無副檔名的 unix shell script 版本),依這個優先順序挑一個「Node 在
 *  `shell:false` 下也能直接執行,或明確知道要不要開 shell」的候選。 */
const WINDOWS_EXECUTABLE_EXT_PRIORITY = [".exe", ".cmd", ".bat", ".ps1"];

export interface ProbeResult {
  installed: boolean;
  version?: string;
  path?: string;
}

/**
 * 探測單一命令是否存在、其版本為何。
 *
 * **安全前提**:呼叫端必須保證 `command` 是一個寫死的字面字串常數(這個檔案
 * 內唯一的正式呼叫端是下方 `detectExternalCli()`,`command` 一律來自
 * `AGENT_ALLOWLIST` 常數陣列)。這個函式本身不做 allowlist 檢查、也不限制
 * `command` 的值——之所以仍然 export 它,是為了讓 e2e
 * (scripts/e2e-gateway.mjs 步驟21)能不經過 gateway、直接呼叫這個編譯後的
 * 函式來驗證「探測邏輯本身」的行為(`node` 這個必定存在的命令 → installed
 * =true 且 version 非空;一個亂數 bogus 命令 → installed=false),而不需要
 * 在 gateway 層新增一個「可指定任意命令」的方法——那樣的方法本身就是一種
 * 「執行任意命令」的能力,即使限制成只能帶 `--version`,仍是不必要的攻擊面。
 * `env.detectAgents`(見 apps/core/src/gateway/ws-gateway.ts)完全不吃參數,
 * 是唯一透過 WS 暴露出去的入口。
 */
export async function probeCommand(command: string, versionArgs: string[] = ["--version"]): Promise<ProbeResult> {
  const resolved = await findExecutable(command);
  if (!resolved) return { installed: false };
  const version = await runVersionCommand(resolved, versionArgs);
  return { installed: true, path: resolved, version };
}

/** 用 `where`(Windows)/`which`(POSIX)找出命令的完整路徑;找不到/逾時都回 undefined。 */
function findExecutable(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [command], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) {
        resolve(undefined);
        return;
      }
      resolve(process.platform === "win32" ? pickWindowsCandidate(lines) : lines[0]);
    });
  });
}

/** 見上方 WINDOWS_EXECUTABLE_EXT_PRIORITY 註解。 */
function pickWindowsCandidate(lines: string[]): string {
  for (const ext of WINDOWS_EXECUTABLE_EXT_PRIORITY) {
    const found = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (found) return found;
  }
  return lines[0];
}

/** 對已解析出的完整路徑跑 `--version`(或呼叫端指定的 versionArgs);逾時/失敗都回 undefined。 */
function runVersionCommand(resolvedPath: string, versionArgs: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const ext = path.extname(resolvedPath).toLowerCase();
    // 只有 .cmd/.bat 這類 shell shim 需要 shell:true(見 class 頂端註解第2點)。
    const needsShell = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
    const file = needsShell ? quoteForShell(resolvedPath) : resolvedPath;
    execFile(file, versionArgs, { timeout: PROBE_TIMEOUT_MS, shell: needsShell }, (error, stdout, stderr) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(extractVersion(stdout || stderr));
    });
  });
}

/** `cmd.exe` 基本引號規則(含空白/雙引號時才加引號):同 acp-adapter.ts 的 quoteWindowsShellArg()。 */
function quoteForShell(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 對已解析出的完整路徑跑一個「列出模型」子命令(目前只有 opencode 的
 * `opencode models` 用得到,見下方 AllowlistEntry.modelsCommandArgs)——與
 * `runVersionCommand()` 共用一模一樣的安全前提與執行方式(同一個
 * `execFile`,同一套 Windows shim 判斷/quoting),只是逾時改用較長的
 * `MODELS_PROBE_TIMEOUT_MS`(見該常數註解:實測列 model 比 `--version` 慢
 * 得多,沿用 3000ms 會幾乎每次都被殺掉),拿到 stdout 之後改用
 * `parseModelsOutput()` 解析,而不是 `extractVersion()`。任何錯誤(執行失敗、
 * 逾時、找不到子命令)一律 resolve 空陣列,絕不 throw——呼叫端
 * (`detectExternalCli()`)才能在「模型偵測失敗」時優雅降級回 `modelsNote`
 * 說明,不影響其餘偵測項目或整條 `detectAllAgents()` pipeline(比照 class
 * 頂端註解第3點「每次探測都有逾時」的既有紀律)。
 */
function runModelsCommand(resolvedPath: string, args: string[]): Promise<DetectedModel[]> {
  return new Promise((resolve) => {
    const ext = path.extname(resolvedPath).toLowerCase();
    const needsShell = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
    const file = needsShell ? quoteForShell(resolvedPath) : resolvedPath;
    execFile(file, args, { timeout: MODELS_PROBE_TIMEOUT_MS, shell: needsShell }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(parseModelsOutput(stdout));
    });
  });
}

/**
 * 解析 `opencode models` 的 stdout——每一行是純文字的 `providerID/modelID`
 * 組合(見本檔案這輪新增的說明:opencode 的 model 識別碼全部是這個複合形式,
 * 例如 `anthropic/claude-3-5-sonnet-20241022`)。只接受形狀像
 * `provider/model` 的行(用一個寬鬆的字元白名單判斷,允許英數字、點、
 * 底線、冒號、連字號——涵蓋常見的 provider/model id 命名慣例),過濾掉標題、
 * 空白行、警告訊息等其他雜訊行;不臆測、不嘗試修正解析不出的行,單純略過。
 * 以 id 去重,保留第一次出現的順序。
 */
function parseModelsOutput(raw: string): DetectedModel[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const modelLinePattern = /^[\w.-]+\/[\w.:-]+$/;
  const seen = new Set<string>();
  const models: DetectedModel[] = [];
  for (const line of lines) {
    if (!modelLinePattern.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    models.push({ id: line, label: line });
  }
  return models;
}

/**
 * 不臆測各工具 `--version` 的確切輸出格式(README/需求明講「不臆測 CLI 的
 * --version 輸出格式」)——單純取第一個非空白行,去除頭尾空白;解析不出就回
 * undefined(呼叫端顯示「已安裝,版本未知」,見 detectExternalCli())。
 */
function extractVersion(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine;
}

/** allowlist 內一個外部 agent CLI 的宣告(見 class 頂端註解第1點,這是唯一資料來源)。 */
interface AllowlistEntry {
  key: string;
  displayName: string;
  /** 寫死的命令名稱(不含路徑,由 PATH 解析)——絕不可來自外部輸入。 */
  command: string;
  /** 對應 Deskmony 的 AgentSoftware 分類(見 packages/shared/src/agent-profile.ts)。 */
  software: AgentSoftware;
  modelsNote: string;
  /**
   * 這輪新增(選填):有結構化「列出模型」非互動子命令的工具才填——目前只有
   * opencode 的 `opencode models`(印出純文字 `provider/model` 清單,不需要
   * 啟動 server、不需要等 port,見 packages/adapters/src/opencode-adapter.ts
   * 頂端註解與這輪需求描述的外部研究結論)。其餘工具(claude/gemini/codex/
   * aider)目前沒有已知的可靠非互動列模型機制,不臆測、維持省略,一律回落到
   * `modelsNote` 說明「模型由該工具自行管理」(見 class 頂端註解第4點)。
   */
  modelsCommandArgs?: string[];
}

/**
 * 已知 agent CLI 的 allowlist(需求明列的 5 個,未來要擴充新工具只需要在這裡
 * 加一筆,不需要改動安全機制本身)。`software` 的選擇:
 *   - `claude`/`gemini`:實務上多半經 ACP 對接(見 README/需求描述),歸類
 *     為 "acp"。
 *   - `opencode`/`codex`:`AgentSoftwareSchema` 剛好已經有對應的獨立列舉值
 *     (`"opencode"`/`"codex"`),直接沿用,不需要額外新增型別。
 *   - `aider`:目前只能透過 PTY 直通對接(無結構化協議),歸類為 "pty"。
 */
const AGENT_ALLOWLIST: AllowlistEntry[] = [
  {
    key: "claude-code-cli",
    displayName: "Claude Code CLI",
    command: "claude",
    software: "acp",
    modelsNote: "模型由 claude CLI 自行管理(依登入帳號與 CLI 版本決定可用清單),此處不臆測。",
  },
  {
    key: "gemini-cli",
    displayName: "Gemini CLI",
    command: "gemini",
    software: "acp",
    modelsNote: "模型由 gemini CLI 自行管理,此處不臆測。",
  },
  {
    key: "opencode-cli",
    displayName: "OpenCode",
    command: "opencode",
    software: "opencode",
    modelsNote: "模型由 opencode 自行管理,此處不臆測。",
    // `opencode models` 是純文字輸出的非互動子命令(見上方 AllowlistEntry.
    // modelsCommandArgs 註解),不需要啟動 `opencode serve`、不需要等 port
    // 就緒,是這輪選用的偵測機制。
    modelsCommandArgs: ["models"],
  },
  {
    key: "codex-cli",
    displayName: "Codex CLI",
    command: "codex",
    software: "codex",
    modelsNote: "模型由 codex CLI 自行管理,此處不臆測。",
  },
  {
    key: "aider-cli",
    displayName: "Aider",
    command: "aider",
    software: "pty",
    modelsNote: "模型由 aider 自行管理(依 --model 參數或設定檔決定),此處不臆測。",
  },
];

async function detectExternalCli(entry: AllowlistEntry): Promise<AgentDetectionEntry> {
  const probe = await probeCommand(entry.command);
  // 只有「已安裝且有對應完整路徑」才值得嘗試列模型(未安裝就沒有可執行的
  // 命令;`probe.path` 理論上在 `installed:true` 時必定存在,這裡仍防禦性
  // 檢查,避免對 undefined 路徑呼叫 execFile)。失敗一律回空陣列(見
  // runModelsCommand() 頂端註解的 fail-soft 保證),不影響其餘偵測欄位。
  const models =
    entry.modelsCommandArgs && probe.installed && probe.path
      ? await runModelsCommand(probe.path, entry.modelsCommandArgs)
      : [];
  return {
    key: entry.key,
    displayName: entry.displayName,
    software: entry.software,
    installed: probe.installed,
    version: probe.version,
    path: probe.path,
    models,
    // 有真的列出模型清單時,原本「模型由該工具自行管理」的說明就沒有意義
    // 了(UI 已經有結構化清單可以顯示/挑選),省略;仍然拿不到清單(未安裝、
    // 沒有 modelsCommandArgs、指令失敗/逾時)才保留這句說明。
    modelsNote: models.length > 0 ? undefined : entry.modelsNote,
  };
}

/**
 * 呼叫 Anthropic 官方 Models API(`GET /v1/models`,SDK 方法是
 * `client.models.list()`,見 node_modules 內
 * `@anthropic-ai/sdk/resources/models.d.ts`——`ModelInfo` 有 `id`/`display_name`
 * 兩個欄位剛好對應 `DetectedModel` 的 `id`/`label`,不需要轉換格式)動態列出
 * 這把 API 金鑰真正能用的 model 清單(官方文件:「More recently released
 * models are listed first」)。只取第一頁(`list()` 預設分頁上限通常遠大於
 * 目前 Anthropic 對外發布的 model 數量,不為了理論上的完整性去走多頁,保持
 * 這裡簡單)。任何錯誤(金鑰無效、逾時、網路問題)一律 resolve `undefined`,
 * 絕不 throw——呼叫端 `detectClaudeAgentSdk()` 才能安全地退回空陣列 +
 * `modelsNote` 說明(比照 `runModelsCommand()` 的既有 fail-soft 紀律)。
 */
async function detectClaudeModelsFromApi(apiKey: string): Promise<DetectedModel[] | undefined> {
  try {
    const client = new Anthropic({ apiKey, timeout: CLAUDE_MODELS_API_TIMEOUT_MS, maxRetries: 0 });
    const page = await client.models.list();
    const models = page.data.map((m) => ({ id: m.id, label: m.display_name }));
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 「Claude Agent SDK(內嵌)」這個特殊項:不是外部 CLI,是隨 apps/core 一起
 * 安裝的內嵌 SDK,永遠 `installed: true`。可用性真正的關鍵是「有沒有可用憑證」
 * ——這裡採用保守、不會誤報的判斷:只檢查 `ANTHROPIC_API_KEY` 環境變數是否
 * 設定;本機是否有 `claude login` 落地的登入憑證屬於 Claude CLI 私有的憑證
 * 儲存格式/位置(不同版本/平台可能不同,沒有穩定公開的探測方式),與其猜測
 * 檔案位置冒著「誤報沒有其實有」或「誤報有其實沒有」的風險,不如老實回報
 * 「憑證狀態未知」——這正是需求明講的「拿不準就報『已內建,憑證狀態未知』」。
 *
 * model 清單:這輪起**移除**寫死的 `KNOWN_CLAUDE_MODELS` fallback(該清單會
 * 隨 Anthropic 發布新 model/棄用舊 model 而過時,失去維護就是一份會誤導使用者
 * 的舊清單,比完全不顯示更危險)——只有 `ANTHROPIC_API_KEY` 存在且
 * `detectClaudeModelsFromApi()` 真的查得到資料時,`models` 才非空;其餘情況
 * (沒有金鑰、查詢失敗/逾時)一律回空陣列 + `modelsNote` 如實說明原因,UI 端
 * 因為 `models.length > 0` 才顯示選單的既有條件(見 ProfileCreateDialog.tsx)
 * 會自然隱藏 model 選單,不會顯示任何過時資訊。刻意**不**在只有 `claude
 * login`(無 API 金鑰、僅本機 CLI 登入)的情況下嘗試呼叫 Models API——沒有
 * 金鑰可傳,呼叫只會確定失敗。
 */
async function detectClaudeAgentSdk(): Promise<AgentDetectionEntry> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const hasApiKey = Boolean(apiKey);
  const dynamicModels = apiKey ? await detectClaudeModelsFromApi(apiKey) : undefined;
  const models = dynamicModels ?? [];
  return {
    key: "claude-agent-sdk",
    displayName: "Claude Agent SDK(內嵌)",
    software: "claude-agent-sdk",
    installed: true,
    models,
    // 有真的查到動態清單時不需要額外說明(比照 detectExternalCli() 對
    // opencode 的既有處理);查不到時如實說明原因,不再有「內建已知清單」
    // 這種退路可以說。
    modelsNote: dynamicModels
      ? undefined
      : hasApiKey
        ? "已偵測到 ANTHROPIC_API_KEY,但查詢 Anthropic Models API 失敗,暫時無法列出可用 model。"
        : "未偵測到 ANTHROPIC_API_KEY,無法動態查詢可用 model 清單(若已用 `claude login` 完成本機登入,SDK 仍可正常運作,只是這裡列不出清單)。",
    credentialHint: hasApiKey
      ? "已偵測到 ANTHROPIC_API_KEY 環境變數。"
      : "已內建,憑證狀態未知(未偵測到 ANTHROPIC_API_KEY;若已用 `claude login` 完成本機登入,SDK 仍可正常運作)。",
  };
}

/**
 * 組裝完整偵測結果 —— `env.detectAgents` gateway 方法的唯一呼叫對象(見
 * apps/core/src/gateway/ws-gateway.ts)。`claude-agent-sdk` 固定排第一個
 * (它不依賴任何外部 CLI,必定出現在清單裡),其餘依 `AGENT_ALLOWLIST` 宣告
 * 順序、平行探測(`Promise.all`)——每一項各自的逾時互不影響,整體耗時約等於
 * 「單一探測的兩次逾時週期」,不會隨 allowlist 項目數線性增加。
 */
export async function detectAllAgents(): Promise<AgentDetectionEntry[]> {
  const [claudeAgentSdk, externalResults] = await Promise.all([
    detectClaudeAgentSdk(),
    Promise.all(AGENT_ALLOWLIST.map((entry) => detectExternalCli(entry))),
  ]);
  return [claudeAgentSdk, ...externalResults];
}

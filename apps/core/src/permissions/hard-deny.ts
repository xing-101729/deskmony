import os from "node:os";
import path from "node:path";
import { extractCommandCandidates, extractPathCandidates } from "@deskmony/shared";
import { extractHostCandidates, isPathUnder, resolveRealpathBestEffort } from "./tool-input.js";

/**
 * hard-deny.ts(S1:內建、config 不可關閉的硬性 deny 類 — F4)。
 *
 * 對應 docs/LAYER-4-detail-design/policy-engine_detail.md §3。四類:
 *   1. worktree 外寫入/刪除
 *   2. 讀秘密路徑(~/.ssh、~/.aws、~/.deskmony、桌面殼的 Electron userData(含加密保存的遠端存取 token)、`**​/.env*`、`**​/id_rsa*`、`**​/credentials`)
 *   3. force-push / 危險 git
 *   4. 非白名單外連
 *
 * **判定失敗的方向**:任何「無法確定是否命中」的情況(路徑解析失敗、指令
 * 無法解析、猜不到 toolName 屬於哪一類)⇒ **不視為 hard-deny**(`matched:
 * false`),但呼叫端(policy-engine.ts 的 `decide()`)在這裡回傳 false 之後,
 * 仍然會依序比對 config 規則 → autoMode → 最終落到 `escalate`(default-deny)。
 * 也就是說「判定不出來」只代表**不會被這個函式擋下**,不代表會被放行——真正
 * 保證安全方向的是呼叫端的 default-deny 兜底,這個函式本身只需要對「猜得到」
 * 的情況做出正確判斷即可,不需要也不應該用臆測把它硬套進某一類(見下方各
 * 判定函式對「猜不到」的處理)。
 */

export type HardDenyCategory = "worktree-escape" | "secret-path" | "dangerous-git" | "non-allowlisted-network";

export interface HardDenyResult {
  matched: boolean;
  category?: HardDenyCategory;
  reason: string;
}

export interface HardDenyCheckInput {
  toolName: string;
  input: unknown;
  /** 這個 session 的 worktree 邊界——用 `Session.workingDir`(建立
   *  session 時傳給 adapter.spawn() 的 cwd)近似 HLD 說的
   *  `workspace.worktreePath`(見 policy-engine.ts 的 `PermissionRequest.workingDir`
   *  欄位註解:session 不綁定任何任務 git worktree——該機制已於 2026-10-02 移除——
   *  `workingDir` 是 session 層級唯一的邊界)。 */
  workingDir: string;
  /** `policy.allowedHosts`(見 core-config.ts),預設空 = 全擋。 */
  allowedHosts: string[];
}

/**
 * Deskmony 自己的 `browser_navigate` MCP 工具(session 網路 MCP server `deskmony`,見 packages/adapters/src/session-network-mcp.ts)在三種
 * adapter 的政策引擎裡的**完整名稱**——判斷綁死 `deskmony` 這個 server 名稱,**不能只比結尾**(別的 MCP server 可能也有叫
 * `browser_navigate` 的工具,它們仍要受第 4 類「非白名單外連」約束)。三種寫法各有來源(2026-10-21 查證):
 *  - `mcp__deskmony__browser_navigate`:Claude Agent SDK 的 `canUseTool` 收到的工具名。SDK 把 in-process MCP 工具一律組成
 *    `mcp__${serverName}__${toolName}`(查證:`@anthropic-ai/claude-agent-sdk` 的 sdk.mjs 組名的樣板字串與 sdk.d.ts 的說明),
 *    server 名稱就是我們掛的 `deskmony`;claude-code-acp 這類 ACP 後端用的也是同一種寫法。
 *  - `deskmony_browser_navigate`:OpenCode 的 MCP 工具名 = `<server>_<tool>`。**實測**(2026-10-21,真實 opencode 1.18.7 + `opencode/big-pickle`,
 *    掛一個名為 `deskmony` 的 stdio MCP server):HTTP 的 tool part `tool` 與 `permission.asked` 的 `permission` 都是這個字串;
 *    `opencode acp`(用 `AcpAdapter` 實際啟動)送進政策引擎的 permission-request `toolName` 也是這個字串。兩條路在權限請求當下 input 都還是空的
 *    (url 在之後的 running 才到),所以 OpenCode 的 `browser_navigate` 本來就不會被第 4 類看到 url。
 *  - `mcp.deskmony.browser_navigate`:codex-acp(`@agentclientprotocol/codex-acp` 1.13.1)對 MCP 工具呼叫的 `tool_call` title
 *    (查證:它的 dist/index.js `createMcpToolCallUpdate()` 用 `mcp.${item.server}.${item.tool}`)。
 *    ⚠️ 但 codex-acp 的 MCP **權限請求**(`session/request_permission`)在已有對應 tool_call 時只帶 `toolCallId`、沒有 title 也沒有 rawInput,
 *    `AcpAdapter` 因此把 call id 當成 toolName、input 是空的——這種請求在這裡認不出是什麼工具,但它也沒有 url 可供第 4 類比對,所以不會被誤判成外連;
 *    (這是 `AcpAdapter` 既有的限制:codex 的 MCP 工具權限請求拿不到工具名,見 docs/DECISIONS.md §L.2 的備註。)
 * 其他寫法(例如沒查證過的 gemini)不在這份名單裡,保守起見仍受第 4 類約束。
 */
const DESKMONY_BROWSER_NAVIGATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mcp__deskmony__browser_navigate",
  "deskmony_browser_navigate",
  "mcp.deskmony.browser_navigate",
]);

/** 這個 toolName 是不是 Deskmony 自己的 `browser_navigate`(完整比對,見上方名單的說明)。 */
export function isDeskmonyBrowserNavigateTool(toolName: string): boolean {
  return DESKMONY_BROWSER_NAVIGATE_TOOL_NAMES.has(toolName);
}

/** 工具名裡含這些關鍵字(不分大小寫)才視為「會修改/刪除檔案系統」的操作——
 *  worktree-escape 只對這類工具的路徑做檢查,單純讀取(Read/Glob/Grep)不算,
 *  避免「讀取 worktree 外的檔案」被誤判成「worktree 外寫入/刪除」這個更嚴重
 *  的分類(讀取仍會受 §3 第 2 類「讀秘密路徑」與 default-deny 兜底,不是沒有
 *  防護,只是分類不同)。best-effort,見 ACP `toolName` 是人類標題的限制。 */
const MUTATING_TOOL_KEYWORDS = ["write", "edit", "delete", "remove", "mkdir", "move", "rename", "create"];

function isMutatingToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return MUTATING_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 桌面殼(Electron)的 userData 目錄樹——2026-10-05 納入秘密路徑。
 *
 * 桌面殼把「遠端存取 token」用 Electron `safeStorage`(Windows DPAPI/macOS Keychain/Linux Secret Service)加密存在
 * `<userData>/auth-token.enc`(apps/desktop/electron/main.ts 的 `authTokenFilePath()`)。**同一個作業系統使用者底下的任何程序都能
 * 解密它**(DPAPI 以使用者身分解密)——agent 若能讀到這個檔案再解密,就拿到主認證 token(= 能自己核准權限/切 YOLO)。把整個目錄樹
 * 列為秘密路徑,讓「讀這個檔案」的工具呼叫一律升級給使用者(hard-deny 不可學習、auto/YOLO 也擋)。
 *
 * core 不知道 Electron 實際的 userData 路徑(core 是獨立程序,可能 headless、也可能被 CLI 啟動),所以這裡依 Electron 的**平台慣例**
 * 推算(`app.getPath("userData")` = appData 基底 + app 名稱),兩個名稱都納入:
 *  - `Deskmony`:打包後的 app(electron-builder 的 `productName`,2026-10-05 在 Windows 實測對應 `%APPDATA%\Deskmony`);
 *  - `@deskmony`:開發模式(`electron .`,app 名稱是 package.json 的 `@deskmony/desktop`,實測落在 `%APPDATA%\@deskmony\desktop`)。
 * appData 基底:Windows `%APPDATA%`(沒有就 `~/AppData/Roaming`)、macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME`(沒有就 `~/.config`)。
 *
 * **只擋「工具 input 裡結構化的路徑欄位」**(同其他秘密路徑規則,見 policy-engine_detail.md §2「shell 的誠實限制」):agent 在 bash 裡
 * `cat` 這個檔案是一串指令字串,這裡看不到——所以這條只是縱深防禦的一層,**不是**擋住「同使用者程序解密本機檔案」的機制;那屬於
 * 沙箱/作業系統隔離的範疇(docs/DECISIONS.md §J)。
 */
function electronUserDataDirs(): string[] {
  const home = os.homedir();
  let appData: string;
  if (process.platform === "win32") appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (process.platform === "darwin") appData = path.join(home, "Library", "Application Support");
  else appData = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [path.join(appData, "Deskmony"), path.join(appData, "@deskmony")];
}

/** ~/.ssh、~/.aws、~/.deskmony、桌面殼的 Electron userData(整個目錄樹)+ `**​/.env*`、`**​/id_rsa*`、
 *  `**​/credentials`(任何深度)。 */
function isSecretPath(rawPath: string, baseDir: string): boolean {
  const resolved = resolveRealpathBestEffort(rawPath, baseDir);
  const home = os.homedir();

  for (const boundaryPath of [
    ...[".ssh", ".aws", ".deskmony"].map((dirName) => path.join(home, dirName)),
    ...electronUserDataDirs(),
  ]) {
    const boundary = resolveRealpathBestEffort(boundaryPath);
    if (isPathUnder(resolved, boundary)) return true;
  }

  const segments = resolved.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (/^\.env/i.test(seg)) return true;
    if (/^id_rsa/i.test(seg)) return true;
    if (/^credentials$/i.test(seg)) return true;
  }
  return false;
}

/**
 * 危險 git 的指令 regex——刻意**不加 `^...$` 錨定**(與 policy-engine.ts 對
 * 使用者 allowlist 的 `commandMatches` 相反):hard-deny 要抓的是「即使藏在
 * 一長串 `cd /tmp && git push --force` 這種複合指令裡」也要命中,錨定完整
 * 匹配反而會讓攻擊者用一個無關前綴就繞過。這是刻意的不對稱設計——allowlist
 * 錨定是為了不誤放行,hard-deny 不錨定是為了不漏擋。
 */
const DANGEROUS_GIT_PATTERNS: { category: string; test: (command: string) => boolean }[] = [
  { category: "force-push", test: (c) => /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/i.test(c) },
  { category: "delete-remote-branch", test: (c) => /\bgit\s+push\b[^\n]*--delete\b/i.test(c) },
  {
    category: "force-delete-branch",
    /**
     * 2026-09-04(稽核修補):這條原本是單一個帶 `/i` 的 regex
     * `/\bgit\s+branch\b[^\n]*\s-D\b/i` —— 而 `/i` 讓 `-D` 連 `-d` 一起命中。
     *
     * 這兩個旗標的語意天差地遠:`-D` 是**強制**刪除,連未合併的分支也照刪
     * (真的會弄丟工作,屬於 §C5「不可逆」那一類);`-d` 只刪已完全合併的
     * 分支,未合併時 git 自己就會拒絕 —— 那是例行清理,不是危險操作。
     *
     * 把 `-d` 誤判成 hard-deny 的代價不只是「多問一次」:hard-deny 是**永遠
     * 升級、不可學習**的類別(§C4 紀律③,不給「永遠允許」),所以每一次例行的
     * 分支清理都會硬生生擋住且無法透過 allowlist 消除。一個經常誤喊的地板,
     * 會讓人開始習慣性略過真正該看的那幾次警告。
     *
     * 修法:指令字本身維持大小寫不敏感(與另外兩條一致),但**旗標比對必須
     * 大小寫敏感** —— 這正是 `-D` 與 `-d` 唯一的區別所在。
     */
    test: (c) => /\bgit\s+branch\b/i.test(c) && /\s-D\b/.test(c),
  },
];

export function checkHardDeny(req: HardDenyCheckInput): HardDenyResult {
  // 1) worktree 外寫入/刪除——只檢查「猜得到路徑」且「猜得到是 mutating 工具」
  //    的情況,兩者缺一都視為猜不到(不 matched,落到 default-deny 兜底)。
  if (isMutatingToolName(req.toolName)) {
    const candidates = extractPathCandidates(req.input);
    if (candidates.length > 0) {
      const boundary = resolveRealpathBestEffort(req.workingDir);
      for (const rawPath of candidates) {
        const resolved = resolveRealpathBestEffort(rawPath, req.workingDir);
        if (!isPathUnder(resolved, boundary)) {
          return {
            matched: true,
            category: "worktree-escape",
            reason: `工具 ${req.toolName} 的目標路徑 "${rawPath}"(解析後 ${resolved})不在 worktree(${boundary})之下`,
          };
        }
      }
    }
  }

  // 2) 讀秘密路徑——不分讀寫,任何工具只要路徑猜得到都檢查。
  for (const rawPath of extractPathCandidates(req.input)) {
    if (isSecretPath(rawPath, req.workingDir)) {
      return {
        matched: true,
        category: "secret-path",
        reason: `工具 ${req.toolName} 的目標路徑 "${rawPath}" 命中秘密路徑規則(~/.ssh、~/.aws、~/.deskmony、桌面殼的 userData、.env*、id_rsa*、credentials)`,
      };
    }
  }

  // 3) force-push / 危險 git——只對猜得到「指令字串」的工具做 regex 掃描
  //    (見 policy-engine_detail.md §2「shell 的誠實限制」:這裡的 pattern 只
  //    擋明顯的意外,擋不住 `bash -c`/`$()`/base64 刻意繞過)。
  for (const command of extractCommandCandidates(req.input)) {
    for (const { category, test } of DANGEROUS_GIT_PATTERNS) {
      if (test(command)) {
        return {
          matched: true,
          category: "dangerous-git",
          reason: `指令 "${command}" 命中危險 git pattern(${category})`,
        };
      }
    }
  }

  // 4) 非白名單外連——只對猜得到 host 的工具檢查,allowedHosts 預設空 = 全擋。
  //    **例外(2026-10-21,右側面板 P4a,docs/DECISIONS.md §L.2)**:Deskmony 自己的 `browser_navigate`(見
  //    `isDeskmonyBrowserNavigateTool()`,完整比對三種 adapter 的寫法、綁 `deskmony` server 名稱)不做這個檢查——loopback 依 Q5 不算外連,
  //    外部網站則由 core 的 `BrowserRelay` 導覽規則擋(只放行 loopback、`policy.allowedHosts`、或該 session 開著真.無限制,
  //    而且比這裡**更嚴**:沒有「逐次強確認放行」這條路)。WebFetch 等其他工具的第 4 類判斷完全不變。
  const hostCandidates = isDeskmonyBrowserNavigateTool(req.toolName) ? [] : extractHostCandidates(req.input);
  for (const host of hostCandidates) {
    const allowed = req.allowedHosts.some((h) => h.toLowerCase() === host.toLowerCase());
    if (!allowed) {
      return {
        matched: true,
        category: "non-allowlisted-network",
        reason: `工具 ${req.toolName} 的目標 host "${host}" 不在 policy.allowedHosts 內`,
      };
    }
  }

  return { matched: false, reason: "未命中任何 hard-deny 規則(不代表放行,仍會落到 policy-engine 的 default-deny 兜底)" };
}

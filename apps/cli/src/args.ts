import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EffortLevelSchema, SessionPermissionModeSchema, type EffortLevel, type SessionPermissionMode } from "@deskmony/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 用法錯誤——bin.ts 收到這個之後一律印訊息到 stderr、指向 `--help`,退出碼 2
 * (docs/LAYER-3-hld/cli_hld.md §2 退出碼表:「用法錯誤(未知旗標/缺參數)」)。
 * 刻意獨立成一個型別,而不是隨便丟一個字串或用 `connect.ts` 的
 * `CliExitError`——這個檔案完全不知道「退出碼 2」這件事,退出碼是 bin.ts 的
 * 職責,這裡只表達「這是一個用法問題」這個語意,兩者故意分開。
 */
export class CliUsageError extends Error {}

/**
 * 全域旗標解析後的結果。所有指令共用同一份(即使某些欄位只有特定指令會讀,
 * 例如 `session`/`permissionMode` 只有 chat/run 用得到)——手寫的 parser 不
 * 分「這個旗標只能接在某個子指令後面」這種context-sensitive 規則,單一
 * flat 命名空間最簡單,也最符合「未知旗標一律在解析當下就報錯」的驗收要求
 * (不用等到 dispatch 到特定指令才發現某個旗標不認識)。
 */
export interface GlobalOptions {
  url: string;
  /**
   * `commands/serve.ts` 專用:`--url`/`DESKMONY_URL` 是否**真的有被使用者
   * 指定**,而不是落到 `DEFAULT_URL`。這個區分只對 `serve` 有意義——其餘
   * 指令一律把 `url` 當「要連去哪裡」用,有沒有預設值不重要;但 `serve`
   * 是拿 `--url` 反推「新開的 core 該綁在哪裡」,若不分辨「使用者真的要
   * 覆寫」與「使用者根本沒提,只是拿到寫死的預設值」,`deskmony serve`
   * (不帶任何旗標)會把 CLI 自己的預設值誤當成使用者的明確指示,蓋掉
   * 使用者已經在 `<DESKMONY_HOME>/config.json` 設定好的 bindHost/port
   * (見 commands/serve.ts 對這個欄位的實際用法)。
   */
  urlExplicit: boolean;
  token: string | undefined;
  cwd: string;
  profile: string;
  model: string | undefined;
  effort: EffortLevel | undefined;
  json: boolean;
  /** 已經套用 isTTY / NO_COLOR / --no-color / --json 全部規則後的最終值,
   *  render.ts 只看這個欄位,不重新判斷任何一個來源。 */
  color: boolean;
  timeoutMs: number;
  /**
   * HLD §5「usage / context-usage:只在 --verbose 印」——§2 的全域旗標表沒有
   * 列出這個旗標(表格本身不完整),但 §5 明確要求要有,所以在這裡補上。
   */
  verbose: boolean;
  /**
   * HLD §7:「一律只用 ASCII 當結構符號」——render.ts 本來就無條件只輸出
   * ASCII 結構符號(`->`/`*`/`|`),不會因為終端機看起來像是 UTF-8 就切換成
   * Unicode 版本(cmd.exe 的 codepage 沒有可靠的偵測方式,錯誤成本是輸出
   * 變亂碼,不值得賭)。這個旗標目前因此是 no-op,保留純粹是向前相容:
   * §7 原文明講「需要的話另外提供 --ascii 強制」,若之後真的想在偵測到
   * UTF-8 終端機時改用 Unicode 符號當預設值,這個旗標就有事可做,呼叫端
   * 現在先開始寫腳本帶這個旗標也不會在那次改動後突然壞掉。
   */
  ascii: boolean;
  /** 只有 run/chat 會讀。省略時沿用 session 建立當下 profile 的
   *  permissionLevel,不主動呼叫 session.setPermissionMode。 */
  permissionMode: SessionPermissionMode | undefined;
  /** 只有 chat 會讀。省略則建立新 session。 */
  session: string | undefined;
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "chat"; options: GlobalOptions }
  | { kind: "run"; options: GlobalOptions; promptArg: string }
  | { kind: "serve"; options: GlobalOptions }
  | { kind: "tui"; options: GlobalOptions }
  | { kind: "session-list"; options: GlobalOptions }
  | { kind: "session-rm"; options: GlobalOptions; sessionId: string }
  | { kind: "profile-list"; options: GlobalOptions }
  | { kind: "doctor"; options: GlobalOptions }
  | { kind: "config-show"; options: GlobalOptions };

type FlagKind = "string" | "boolean";

/**
 * 單一 flat 旗標表——刻意不用 commander/yargs(HLD §4.2「新相依只有
 * ws」),手寫的解析器只需要處理這份表格已經窮舉的旗標,足夠應付 Phase 1
 * 的命令表面。新增旗標時只需要在這裡加一行,`parseArgv()` 本身不用改。
 */
const FLAG_SPECS: Record<string, FlagKind> = {
  "--url": "string",
  "--token": "string",
  "--cwd": "string",
  "--profile": "string",
  "--model": "string",
  "--effort": "string",
  "--permission-mode": "string",
  "--session": "string",
  "--timeout": "string",
  "--json": "boolean",
  "--no-color": "boolean",
  "--verbose": "boolean",
  "--ascii": "boolean",
  "--help": "boolean",
  "-h": "boolean",
  "--version": "boolean",
  "-v": "boolean",
};

const DEFAULT_URL = "ws://127.0.0.1:4317";
const DEFAULT_PROFILE = "default-claude-code";
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/**
 * 逐一 token 掃描,分流成「已知旗標(含值)」與「positional」。
 *
 * 支援 `--flag value` 與 `--flag=value` 兩種寫法——後者在腳本裡比較常見
 * (避免 shell 對空白的分詞問題),兩者刻意等價。
 *
 * 未知旗標**在掃描當下**就丟例外,不是等全部掃完、也不是等 dispatch 到子
 * 指令才發現——這樣 `deskmony --bogus-flag`(沒有任何子指令)才會如驗收
 * 要求地退出碼 2,而不是先被當成「隱含 chat」吃掉,直到 chat 內部才報錯
 * (那樣會是退出碼 1 或更糟的堆疊,不是使用者該看到的東西)。
 */
function tokenize(argv: string[]): { raw: Map<string, string | true>; positionals: string[] } {
  const raw = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const looksLikeFlag = tok.startsWith("-") && tok !== "-";
    if (!looksLikeFlag) {
      positionals.push(tok);
      continue;
    }
    const eqIdx = tok.indexOf("=");
    const name = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
    const kind = FLAG_SPECS[name];
    if (!kind) {
      throw new CliUsageError(`未知的旗標:${tok}`);
    }
    if (kind === "boolean") {
      if (eqIdx >= 0) throw new CliUsageError(`旗標 ${name} 不接受帶值(用法:${name},不要加 =值)`);
      raw.set(name, true);
      continue;
    }
    if (eqIdx >= 0) {
      raw.set(name, tok.slice(eqIdx + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) throw new CliUsageError(`旗標 ${name} 需要一個值`);
    raw.set(name, next);
    i++; // 吃掉下一個 token 當作這個旗標的值。
  }
  return { raw, positionals };
}

function strFlag(raw: Map<string, string | true>, name: string): string | undefined {
  const v = raw.get(name);
  if (v === undefined) return undefined;
  if (v === true) throw new CliUsageError(`旗標 ${name} 需要一個值`);
  return v;
}

function boolFlag(raw: Map<string, string | true>, name: string): boolean {
  return raw.get(name) === true;
}

/**
 * 判斷是否要輸出 ANSI 色碼(HLD §7):
 *   1. `--json` 一律不上色——NDJSON 每一行都要是合法 JSON,混入 SGR 逸出碼
 *      會讓消費端的 `JSON.parse()` 直接失敗,這條規則不可被 --no-color 以外
 *      的任何東西打開(即使 stdout 剛好是 TTY)。
 *   2. `NO_COLOR` 環境變數——依 https://no-color.org 慣例,只要有設定
 *      (不論值是什麼,包含空字串)就關閉,見下方呼叫處只判斷 `!== undefined`。
 *   3. `--no-color` 旗標。
 *   4. 最後才看 `stdout.isTTY`——輸出被導向檔案/管線時預設不上色(色碼對
 *      `grep`/`tee` 之類的消費端只是雜訊)。
 */
function resolveColor(json: boolean, noColorFlag: boolean): boolean {
  if (json) return false;
  if (noColorFlag) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliUsageError(`--timeout 必須是正整數(毫秒),收到:${raw}`);
  return Math.floor(n);
}

function parseEffort(raw: string | undefined): EffortLevel | undefined {
  if (raw === undefined) return undefined;
  const parsed = EffortLevelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(`--effort 必須是以下其中之一:${EffortLevelSchema.options.join("、")}(收到:${raw})`);
  }
  return parsed.data;
}

function parsePermissionMode(raw: string | undefined): SessionPermissionMode | undefined {
  if (raw === undefined) return undefined;
  const parsed = SessionPermissionModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(
      `--permission-mode 必須是以下其中之一:${SessionPermissionModeSchema.options.join("、")}(收到:${raw})`,
    );
  }
  return parsed.data;
}

function buildOptions(raw: Map<string, string | true>): GlobalOptions {
  const json = boolFlag(raw, "--json");
  const noColor = boolFlag(raw, "--no-color");
  return {
    url: strFlag(raw, "--url") ?? process.env.DESKMONY_URL ?? DEFAULT_URL,
    urlExplicit: strFlag(raw, "--url") !== undefined || process.env.DESKMONY_URL !== undefined,
    token: strFlag(raw, "--token") ?? process.env.DESKMONY_AUTH_TOKEN ?? undefined,
    cwd: path.resolve(strFlag(raw, "--cwd") ?? process.cwd()),
    profile: strFlag(raw, "--profile") ?? DEFAULT_PROFILE,
    model: strFlag(raw, "--model"),
    effort: parseEffort(strFlag(raw, "--effort")),
    json,
    color: resolveColor(json, noColor),
    timeoutMs: parseTimeout(strFlag(raw, "--timeout"), DEFAULT_RUN_TIMEOUT_MS),
    verbose: boolFlag(raw, "--verbose"),
    ascii: boolFlag(raw, "--ascii"),
    permissionMode: parsePermissionMode(strFlag(raw, "--permission-mode")),
    session: strFlag(raw, "--session"),
  };
}

/**
 * `--cwd` 相對路徑以 `process.cwd()` 為基準、一律 `path.resolve()`(HLD §7
 * 「路徑」那一列)——上面 `buildOptions()` 已經處理過;這裡額外把
 * `--url`/`--token` 以外、真正代表「本機路徑」的旗標也 resolve 掉,避免
 * 之後每個 command 檔案各自記得要不要 resolve 一次。
 */
export function parseArgv(argv: string[]): ParsedCommand {
  const { raw, positionals } = tokenize(argv);

  if (boolFlag(raw, "--help") || boolFlag(raw, "-h")) return { kind: "help" };
  if (boolFlag(raw, "--version") || boolFlag(raw, "-v")) return { kind: "version" };

  const options = buildOptions(raw);
  const [cmd, ...rest] = positionals;
  const effectiveCmd = cmd ?? "chat"; // 裸執行 = chat(HLD §2)。

  switch (effectiveCmd) {
    case "chat": {
      if (rest.length > 0) throw new CliUsageError(`chat 不接受額外參數:${rest.join(" ")}`);
      return { kind: "chat", options };
    }
    case "run": {
      if (rest.length === 0) {
        throw new CliUsageError("run 需要一個 prompt 參數(或用「run -」從 stdin 讀取)");
      }
      // 多個 positional 視為使用者忘記加引號,直接以空白重新接回去(比照
      // `echo a b c` 的慣例),而不是只取第一個、把其餘的默默丟掉。
      return { kind: "run", options, promptArg: rest.join(" ") };
    }
    case "serve": {
      if (rest.length > 0) throw new CliUsageError(`serve 不接受額外參數:${rest.join(" ")}`);
      return { kind: "serve", options };
    }
    case "tui": {
      if (rest.length > 0) throw new CliUsageError(`tui 不接受額外參數:${rest.join(" ")}`);
      return { kind: "tui", options };
    }
    case "session": {
      const [sub, ...subRest] = rest;
      if (sub === "list") {
        if (subRest.length > 0) throw new CliUsageError("session list 不接受額外參數");
        return { kind: "session-list", options };
      }
      if (sub === "rm") {
        if (subRest.length !== 1) throw new CliUsageError("session rm 需要剛好一個 session id");
        return { kind: "session-rm", options, sessionId: subRest[0] };
      }
      throw new CliUsageError(`未知的 session 子指令:${sub ?? "(缺少)"}(可用:list、rm)`);
    }
    case "profile": {
      const [sub, ...subRest] = rest;
      if (sub === "list") {
        if (subRest.length > 0) throw new CliUsageError("profile list 不接受額外參數");
        return { kind: "profile-list", options };
      }
      throw new CliUsageError(`未知的 profile 子指令:${sub ?? "(缺少)"}(可用:list)`);
    }
    case "doctor": {
      if (rest.length > 0) throw new CliUsageError("doctor 不接受額外參數");
      return { kind: "doctor", options };
    }
    case "config": {
      const [sub, ...subRest] = rest;
      if (sub === "show") {
        if (subRest.length > 0) throw new CliUsageError("config show 不接受額外參數");
        return { kind: "config-show", options };
      }
      throw new CliUsageError(`未知的 config 子指令:${sub ?? "(缺少)"}(可用:show)`);
    }
    default:
      throw new CliUsageError(`未知的指令:${effectiveCmd}(執行 deskmony --help 查看可用指令)`);
  }
}

/** 讀自己的 package.json 版本號——刻意用執行期讀檔而非 `import pkg from
 *  "../package.json"`:`type:"module"` + `NodeNext` 下,JSON import 需要
 *  import attribute(`with { type: "json" }`),不同 Node 20 patch 版本的
 *  支援狀況不一致(這是這個專案要求的最低版本,見根目錄 package.json
 *  `engines.node`),用 `readFileSync` 沒有這個相容性風險。找不到/解析失敗
 *  時吞掉錯誤、退回 "0.0.0"——`--version` 印不出精確版號不該讓整個指令
 *  當掉。 */
function readOwnVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function printVersion(): void {
  process.stdout.write(`deskmony ${readOwnVersion()}\n`);
}

/**
 * 刻意每行都很短(見任務要求「Keep --help readable in a narrow terminal」)
 * ——不用任何自動換行/排版邏輯,手動控制每一行的寬度,windows 預設
 * cmd.exe 視窗寬度(80 欄)下不會被迫換行變得難讀。
 */
export function printHelp(): void {
  const lines = [
    "用法:deskmony [全域旗標] <指令> [參數]",
    "",
    "指令:",
    "  (無)                       等同 chat",
    "  chat [--session <id>]      互動 REPL;不給 --session 就建新的",
    "  run <prompt>               一次性:送出、串流輸出、完成後退出",
    "  run -                      prompt 從 stdin 讀(支援 pipe)",
    "  serve                      在前景跑 headless core",
    "  tui                        全螢幕 TUI(需要 Node 22+ 與真正的終端機)",
    "  session list               列出 session(可加 --json)",
    "  session rm <id>            刪除 session",
    "  profile list               列出 agent profile(可加 --json)",
    "  doctor                     環境偵測 + 連線自我檢查",
    "  config show                顯示 core 生效設定",
    "  --version, -v              顯示版本",
    "  --help, -h                 顯示這份說明",
    "",
    "全域旗標:",
    "  --url <ws://…>             gateway 位址(預設 ws://127.0.0.1:4317,",
    "                             或環境變數 DESKMONY_URL)",
    "  --token <t>                認證 token(或環境變數 DESKMONY_AUTH_TOKEN)",
    "  --cwd <path>               session 的 workingDir(預設目前目錄)",
    "  --profile <id>             agent profile(預設 default-claude-code)",
    "  --model <m>                建 session 時覆寫 model",
    "  --effort <e>               建 session 時覆寫 effort",
    "  --permission-mode <mode>   對應 session.setPermissionMode:",
    "                             always-ask / auto-accept-edits /",
    "                             auto-accept-all(僅 run/chat 適用)",
    "  --json                     輸出 NDJSON,供腳本消費",
    "  --no-color                 關閉 ANSI 色彩(或環境變數 NO_COLOR)",
    "  --verbose                  額外印出 usage/context-usage 事件",
    "  --timeout <ms>             run 的整體逾時上限(預設 600000)",
    "  --ascii                    強制 ASCII 輸出(目前一律如此,見文件)",
    "",
    "範例:",
    "  deskmony run \"幫我看一下這個 repo 有哪些 TODO\"",
    "  deskmony --profile my-acp run - < prompt.txt",
    "  deskmony session list --json",
    "  deskmony serve",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

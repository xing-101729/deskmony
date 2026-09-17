import readline from "node:readline";
import type { GatewayClient } from "@deskmony/client";
import {
  SessionPermissionModeSchema,
  type AgentOverride,
  type MessageRecord,
  type Session,
  type SessionEventEnvelope,
  type SlashCommandInfo,
} from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { CliExitError, closeGateway, connectGateway } from "../connect.js";
import {
  createStdoutTracker,
  formatEventNdjson,
  paint,
  renderAgentEventPretty,
  renderErrorEvent,
  renderTable,
} from "../render.js";
import { askPermission, createDoubleCtrlCGuard, suspendEchoKeepingCtrlC } from "../prompt.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function createNewSession(client: GatewayClient, options: GlobalOptions): Promise<Session> {
  // 同 commands/run.ts 的 agentOverride 建構邏輯(刻意保留兩份而不是抽成
  // 共用模組——HLD §4.2 給的檔案佈局沒有「session 共用邏輯」這一個檔案,
  // 這幾行本身也短到抽出去反而要多繞一層 import)。
  const agentOverride: AgentOverride | undefined =
    options.model !== undefined || options.effort !== undefined ? { model: options.model, effort: options.effort } : undefined;
  const { session } = (await client.call("session.create", {
    agentProfileId: options.profile,
    workingDir: options.cwd,
    agentOverride,
  })) as { session: Session };
  return session;
}

async function findExistingSession(client: GatewayClient, sessionId: string): Promise<Session> {
  // 沒有 `session.get` 這個 gateway 方法(見 packages/shared/src/gateway.ts
  // 的 ClientRequestSchema——只有 list/create/history 等),用 list 找一次。
  const { sessions } = (await client.call("session.list", {})) as { sessions: Session[] };
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) {
    throw new CliExitError(1, `找不到 session:${sessionId}(用「deskmony session list」查看目前有哪些)`);
  }
  return found;
}

async function replayHistory(client: GatewayClient, sessionId: string, color: boolean): Promise<void> {
  try {
    const { messages } = (await client.call("session.history", { sessionId })) as { messages: MessageRecord[] };
    if (messages.length === 0) return;
    process.stdout.write(paint(`-- 歷史紀錄(${messages.length} 則)--`, "dim", color) + "\n");
    for (const m of messages) {
      // system/tool 訊息這裡不重播——Phase 1 的 REPL 只重播使用者與 agent
      // 之間的對話本身,一大串工具呼叫細節反而會蓋過真正的對話脈絡。
      if (m.role === "user") process.stdout.write(`${paint("你", "cyan", color)}: ${m.content}\n`);
      else if (m.role === "assistant") process.stdout.write(`${paint("agent", "green", color)}: ${m.content}\n`);
    }
    process.stdout.write(paint("-- 歷史紀錄結束 --", "dim", color) + "\n");
  } catch (err) {
    process.stderr.write(`[deskmony] 讀取歷史紀錄失敗(忽略,繼續開始新的對話):${describeError(err)}\n`);
  }
}

function printBanner(options: GlobalOptions, session: Session): void {
  process.stdout.write(
    `Deskmony CLI —— 已連線 ${options.url}\n` +
      `session: ${session.id}(profile: ${session.agentProfileId}, adapter: ${session.adapterType}, cwd: ${session.workingDir})\n` +
      "輸入 /help 查看指令,Ctrl+D 或 /exit 離開,Ctrl+C 中斷這一輪(兩秒內再按一次離開)。\n",
  );
}

function printReplHelp(agentCommands: SlashCommandInfo[]): void {
  const lines = [
    "REPL 內建指令:",
    "  /help                 顯示這份說明",
    "  /exit                 離開(同 Ctrl+D)",
    "  /new                  建立新 session(取代目前這個,舊的不會被刪除)",
    "  /sessions             列出所有 session",
    "  /model <m>            切換這個 session 的 model",
    "  /mode <mode>          切換 permission mode:",
    "                        always-ask / auto-accept-edits / auto-accept-all",
    "  /interrupt            中斷正在跑的這一輪(同 Ctrl+C 第一次按)",
    "  /clear                清除畫面",
    "",
    "以 / 開頭但不是上面任何一個的輸入,會原封不動送給 agent" +
      "(部分後端自己支援伺服器端的 slash command)。",
  ];
  if (agentCommands.length > 0) {
    lines.push("", "這個 agent 額外回報支援的指令:");
    for (const c of agentCommands) {
      const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
      const desc = c.description ? `  -- ${c.description}` : "";
      lines.push(`  /${c.name}${hint}${desc}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * `deskmony chat`——唯一的互動 REPL 指令,詳細設計取捨全部寫在 prompt.ts
 * (串流輸出與輸入行的管理、Ctrl+C 雙擊確認)——這個檔案只負責把那些機制
 * 接起來,以及 REPL 本身的斜線指令(HLD §8)。
 */
export async function chatCommand(options: GlobalOptions): Promise<void> {
  const client = await connectGateway({ url: options.url, token: options.token });

  let currentSession: Session;
  try {
    currentSession = options.session ? await findExistingSession(client, options.session) : await createNewSession(client, options);
  } catch (err) {
    closeGateway(client);
    throw err instanceof CliExitError ? err : new CliExitError(1, `建立/連接 session 失敗:${describeError(err)}`);
  }

  if (options.permissionMode !== undefined) {
    try {
      await client.call("session.setPermissionMode", { sessionId: currentSession.id, mode: options.permissionMode });
    } catch (err) {
      // 不是致命錯誤——REPL 還是能用,只是沒套用到指定的 permission mode,
      // 印出警告讓使用者知道,而不是整個指令直接失敗退出。
      process.stderr.write(`[deskmony] 設定 permission mode 失敗(略過,沿用預設):${describeError(err)}\n`);
    }
  }

  printBanner(options, currentSession);
  if (options.session) await replayHistory(client, currentSession.id, options.color);

  let agentCommands: SlashCommandInfo[] = [];
  const unsubscribeCommands = client.onPush((push) => {
    if (push.channel !== "session-event") return;
    const envelope = push.payload as SessionEventEnvelope;
    if (envelope.sessionId !== currentSession.id) return;
    if (envelope.event.type === "available-commands") agentCommands = envelope.event.commands;
  });

  // terminal:明確依 stdin/stdout 是否都是 TTY 判斷,不靠 readline 的自動
  // 推斷(它只看 output.isTTY)——這個 REPL 的「串流期間管理輸入行」機制
  // (suspendEchoKeepingCtrlC)只有在 stdin 真的是可以設 raw mode 的 TTY 時
  // 才有意義,兩者都不是 TTY 時單純退化成逐行讀取,見 prompt.ts 頂端說明。
  const isFullyInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isFullyInteractive,
    prompt: "> ",
  });

  const tracker = createStdoutTracker();
  const doubleCtrlC = createDoubleCtrlCGuard();
  let exiting = false;

  /**
   * 判斷4 的「非互動模式退出碼 130」是 §7 表格的另外一列——這裡是它的
   * 對照組:**互動模式** Ctrl+C 完全不對應任何 §2 的退出碼,離開 REPL
   * (不論是 /exit、Ctrl+D、還是雙擊 Ctrl+C)一律視為使用者正常結束操作,
   * 退出碼 0。130 只保留給「使用者根本沒有機會表達『正常離開』意圖、
   * 一次性指令被強制中斷」的情境(見 bin.ts 對 run/session/profile/doctor/
   * config 完全不裝 SIGINT handler、刻意讓 Node 預設行為接管的說明)。
   */
  const cleanupAndExit = (code: number): void => {
    if (exiting) return;
    exiting = true;
    unsubscribeCommands();
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      // 不是 TTY 時沒有這個方法,忽略。
    }
    rl.close();
    closeGateway(client);
    // 明講 process.exit()(不是設 exitCode 讓事件迴圈自然結束)——TTY 的
    // stdin 即使呼叫 rl.close() 之後,仍然可能是一個讓事件迴圈不肯結束的
    // 活躍 handle(這是 Node 一個廣為人知的坑:readline 關閉不保證底層
    // stdin stream 也跟著釋放),一次性指令(run/session/...)沒有這個問題
    // (它們從來不曾把 stdin 切進 raw mode),所以只有這裡需要明講退出。
    process.exit(code);
  };

  const requestInterruptOrQuit = (): void => {
    if (doubleCtrlC.press() === "quit") {
      process.stdout.write("\n再見。\n");
      cleanupAndExit(0);
      return;
    }
    process.stdout.write("\n[deskmony] 已送出中斷——兩秒內再按一次 Ctrl+C 可離開 REPL。\n");
    void client.call("session.interrupt", { sessionId: currentSession.id }).catch(() => {
      // session 目前可能本來就是 idle(沒有回合可中斷)——core 端如何處理
      // 這種呼叫不是 CLI 該猜的,失敗就單純忽略,不影響 REPL 繼續運作。
    });
  };

  rl.on("SIGINT", requestInterruptOrQuit); // idle 時(readline 正常運作中)。

  /**
   * 輸入行的序列化佇列。
   *
   * `suspendEchoKeepingCtrlC()`(見 prompt.ts)只在**真正的 TTY**(`isFullyInteractive`
   * 為真)時才會攔住使用者這一輪期間打的字——非 TTY(管線)輸入完全不受它
   * 保護:readline 對一個管線來源會把緩衝區裡已經有的每一行都立刻轉成
   * `"line"` 事件(不會等前一行的非同步處理完才發下一個),若不自己序列化,
   * 用 `deskmony chat < script.txt` 這種方式餵一連串指令時,第二則
   * `session.sendPrompt` 有機會在第一輪的 `completed` 抵達前就送出,兩輪的
   * `session-event` 訂閱互相干擾。這裡讓每一行都排進同一條 promise 鏈,
   * 確保**不論輸入來源是不是 TTY**,永遠一次只處理一行。
   *
   * 同一個佇列也解決「EOF 追上還沒處理完的行」的問題:管線一次把所有內容
   * 寫完就關閉時,`"line"`(每一行)與 `"close"`(EOF)幾乎在同一輪
   * event loop 內接連觸發——`"close"` 的處理程式如果不等佇列排空就直接
   * `process.exit()`,會把還沒跑完的行(例如還在等 RPC 回應的 `/sessions`)
   * 直接腰斬。見下方 `rl.on("close", ...)`。
   */
  let lineQueue: Promise<void> = Promise.resolve();
  function enqueueLine(rawLine: string): void {
    lineQueue = lineQueue.then(() => handleLine(rawLine)).catch((err: unknown) => {
      process.stderr.write(`[deskmony] 處理輸入時發生未預期錯誤(忽略,繼續處理下一行):${describeError(err)}\n`);
    });
  }

  rl.on("close", () => {
    // Ctrl+D,或非 TTY 輸入到 EOF——先等佇列排空(見上方說明),再真正離開。
    void lineQueue.finally(() => cleanupAndExit(0));
  });

  async function sendPromptAndWait(promptText: string): Promise<void> {
    const sessionId = currentSession.id;
    tracker.ensureNewline();
    // 見 prompt.ts 的 suspendEchoKeepingCtrlC() 完整說明:這一輪期間吞掉
    // 一般按鍵,只保留 Ctrl+C——避免串流輸出跟使用者這時候打的字互相干擾。
    let restoreEcho = isFullyInteractive ? suspendEchoKeepingCtrlC(requestInterruptOrQuit) : (): void => {};

    let unsubscribe: () => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        unsubscribe = client.onPush((push) => {
          if (push.channel !== "session-event") return;
          const envelope = push.payload as SessionEventEnvelope;
          if (envelope.sessionId !== sessionId) return;
          const event = envelope.event;

          if (options.json) {
            process.stdout.write(`${formatEventNdjson(envelope)}\n`);
          } else {
            const text = renderAgentEventPretty(event, { color: options.color, verbose: options.verbose });
            if (text !== undefined) tracker.write(text);
          }

          switch (event.type) {
            case "permission-request": {
              // 問答需要 readline 正常運作(rl.question() 要能回顯使用者
              // 輸入),先還原、問完再重新吞鍵——見 prompt.ts 對這個交接
              // 順序的完整說明。
              restoreEcho();
              void (async () => {
                tracker.ensureNewline();
                const answer = await askPermission(
                  rl,
                  { sessionId, toolName: event.toolName, input: event.input, strong: event.strong === true },
                  options.color,
                );
                try {
                  await client.call("permission.resolve", {
                    sessionId,
                    requestId: event.requestId,
                    decision: answer.decision,
                    rememberRule: answer.rememberRule,
                  });
                } catch (err) {
                  process.stdout.write(`[deskmony] 送出權限決定失敗:${describeError(err)}\n`);
                }
                if (isFullyInteractive) restoreEcho = suspendEchoKeepingCtrlC(requestInterruptOrQuit);
              })();
              break;
            }
            case "user-dialog-request": {
              // 見 commands/run.ts 對同一個事件的說明——chat REPL 這輪同樣
              // 尚未支援互動回答 AskUserQuestion,先誠實地自動略過,不要讓
              // 這一輪永遠卡住。
              void client
                .call("dialog.resolve", { sessionId, requestId: event.requestId, result: { behavior: "cancelled" } })
                .catch(() => {});
              if (!options.json) {
                tracker.ensureNewline();
                tracker.write("( agent 問了一個問題,但 chat 尚未支援互動回答,已自動略過作答 )\n");
              }
              break;
            }
            case "completed": {
              unsubscribe();
              tracker.ensureNewline();
              resolve();
              break;
            }
            case "error": {
              unsubscribe();
              if (!options.json) {
                tracker.ensureNewline();
                process.stderr.write(renderErrorEvent(event.message, event.detail, options.color));
              }
              // 錯誤不會讓整個 REPL 死掉——只是這一輪失敗,resolve 而非
              // reject,讓使用者可以接著打下一句話或 /new 重來。
              resolve();
              break;
            }
          }
        });
        client.call("session.sendPrompt", { sessionId, prompt: { text: promptText } }).catch((err: unknown) => {
          unsubscribe();
          reject(new Error(`送出 prompt 失敗:${describeError(err)}`));
        });
      });
    } catch (err) {
      process.stderr.write(`[deskmony] ${describeError(err)}\n`);
    } finally {
      restoreEcho();
    }
  }

  async function handleSlashCommand(line: string): Promise<"handled" | "pass-through"> {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/help":
        printReplHelp(agentCommands);
        return "handled";
      case "/exit":
        cleanupAndExit(0);
        return "handled";
      case "/new": {
        try {
          currentSession = await createNewSession(client, options);
          process.stdout.write(`已建立新 session:${currentSession.id}\n`);
        } catch (err) {
          process.stdout.write(`建立新 session 失敗:${describeError(err)}\n`);
        }
        return "handled";
      }
      case "/sessions": {
        try {
          const { sessions } = (await client.call("session.list", {})) as { sessions: Session[] };
          const rows = sessions.map((s) => [s.id, s.status, s.adapterType, s.title]);
          for (const l of renderTable(["ID", "STATUS", "ADAPTER", "TITLE"], rows)) process.stdout.write(`${l}\n`);
        } catch (err) {
          process.stdout.write(`列出 session 失敗:${describeError(err)}\n`);
        }
        return "handled";
      }
      case "/model": {
        const model = rest.join(" ");
        if (!model) {
          process.stdout.write("用法:/model <model 名稱>\n");
          return "handled";
        }
        try {
          const result = (await client.call("session.setModel", { sessionId: currentSession.id, model })) as { session: Session };
          currentSession = result.session;
          process.stdout.write(`已切換 model:${model}\n`);
        } catch (err) {
          process.stdout.write(`切換 model 失敗:${describeError(err)}\n`);
        }
        return "handled";
      }
      case "/mode": {
        const parsed = SessionPermissionModeSchema.safeParse(rest[0]);
        if (!parsed.success) {
          process.stdout.write("用法:/mode <always-ask|auto-accept-edits|auto-accept-all>\n");
          return "handled";
        }
        try {
          const result = (await client.call("session.setPermissionMode", {
            sessionId: currentSession.id,
            mode: parsed.data,
          })) as { mode: string };
          process.stdout.write(`已切換 permission mode:${result.mode}\n`);
        } catch (err) {
          process.stdout.write(`切換 permission mode 失敗:${describeError(err)}\n`);
        }
        return "handled";
      }
      case "/interrupt":
        requestInterruptOrQuit();
        return "handled";
      case "/clear":
        if (process.stdout.isTTY) {
          process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        } else {
          process.stdout.write("(非終端機輸出,略過清除畫面)\n");
        }
        return "handled";
      default:
        // 不是我們認得的內建指令——原封不動當成一般 prompt 送給 agent
        // (部分後端自己支援伺服器端的 slash command,見 printReplHelp()
        // 的說明)。
        return "pass-through";
    }
  }

  async function handleLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (exiting) return; // 佇列裡排在 /exit 之後的行——不用再處理。
    if (line.length === 0) {
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) {
      const result = await handleSlashCommand(line);
      if (exiting) return; // /exit 已經觸發 cleanupAndExit()。
      if (result === "handled") {
        rl.prompt();
        return;
      }
    }
    await sendPromptAndWait(line);
    if (!exiting) rl.prompt();
  }

  rl.on("line", (rawLine) => enqueueLine(rawLine));

  rl.prompt();
}

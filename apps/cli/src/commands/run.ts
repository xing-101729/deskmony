import type { GatewayClient } from "@deskmony/client";
import type { AgentOverride, Session, SessionEventEnvelope } from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { CliExitError, closeGateway, connectGateway } from "../connect.js";
import { createStdoutTracker, formatEventNdjson, renderAgentEventPretty, renderErrorEvent, summarizeToolInputLines } from "../render.js";

interface SessionCreateResult {
  session: Session;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HLD §7:「讀 stdin 時 .replace(/\r\n/g, "\n")」——Windows 上用 `run - < file`
 *  餵一個 CRLF 檔案時,不應該讓每一行結尾多一個 `\r` 混進 prompt 文字裡。 */
async function readPromptFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
}

/**
 * 這一輪(一個 `session.sendPrompt`)結束時的三種可能結果——之所以要自己
 * 定義這個型別,而不是直接回傳 `CompletedEvent`,是因為「有沒有被拒絕」
 * 這件事**不在**任何一個事件欄位裡(見 §13.4),是呼叫端自己在迴圈裡累積
 * 出來的衍生狀態。
 */
interface TurnOutcome {
  finalText: string;
  deniedTools: string[];
}

/**
 * 判斷1(任務要求的四個判斷之一):`run` 怎麼知道這一輪結束了。
 *
 * `session.sendPrompt` 立刻回 `{ok:true}`(§13.1,ws-gateway.ts:1178),不代表
 * agent 講完了——真正的結束訊號要靠訂閱 `session-event` channel、用
 * `sessionId` 過濾(**所有** client 都會收到**全部** session 的推播,見
 * `SessionEventEnvelopeSchema` 的既有約定,§11 表格已查證),等到:
 *   - `completed`:正常結束路徑。但 §13.4/§13.5 是這支程式碼最重要的兩個
 *     假設——**成功、被拒絕、被中斷,三者在事件層面完全長得一樣,全部只送
 *     `completed`**。所以這裡自己維護 `deniedTools`(見下方 permission-
 *     request 分支),`completed` 抵達時用它決定退出碼是 0 還是 4,不能只看
 *     事件型別就判定成功。
 *   - `error`:agent 或 adapter 層真的出錯(例如子程序掛掉)——這才是貨真
 *     價實的「非成功」事件,對應退出碼 1。
 *   - 逾時(`--timeout`,預設 600000ms):HLD 沒有明講逾時要不要嘗試中斷,
 *     但這個系統的核心精神是「無人值守也要有安全罩」(docs/DECISIONS.md
 *     §0)——一個已經逾時、CLI 即將放棄等待的回合,繼續佔用 agent 子程序
 *     沒有任何好處,所以逾時時最後嘗試送一次 `session.interrupt`(fire-and-
 *     forget,不等它的回應,因為這個 promise 本來就要以逾時失敗結束了)。
 *     退出碼給 1(執行期錯誤),不是 4——逾時不是「被安全罩擋下」,是
 *     「agent 沒能在時限內做完事」,語意不同。
 */
function waitForTurn(client: GatewayClient, sessionId: string, options: GlobalOptions): Promise<TurnOutcome> {
  const tracker = createStdoutTracker();
  return new Promise<TurnOutcome>((resolve, reject) => {
    const deniedTools: string[] = [];
    let sawDelta = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      void client.call("session.interrupt", { sessionId }).catch(() => {
        // 逾時已經要失敗了,中斷失敗不改變結果,忽略即可。
      });
      reject(new CliExitError(1, `逾時(${options.timeoutMs}ms):agent 未在時限內完成這一輪,已嘗試送出中斷。`));
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      fn();
    };

    const unsubscribe = client.onPush((push) => {
      if (push.channel !== "session-event") return;
      const envelope = push.payload as SessionEventEnvelope;
      if (envelope.sessionId !== sessionId) return;
      const event = envelope.event;

      if (options.json) {
        process.stdout.write(`${formatEventNdjson(envelope)}\n`);
      } else {
        if (event.type === "message-delta") sawDelta = true;
        const text = renderAgentEventPretty(event, { color: options.color, verbose: options.verbose });
        if (text !== undefined) tracker.write(text);
      }

      switch (event.type) {
        case "permission-request": {
          // HLD §6:「非互動模式(run、或 stdin 不是 TTY):不問,直接拒絕」
          // ——`run` 不論 stdin 是不是 TTY 都在這個集合裡(見該段原文),
          // 不是只有管線輸入才這樣,一次性指令的語意本來就不該卡住等輸入。
          deniedTools.push(event.toolName);
          if (!options.json) {
            tracker.ensureNewline();
            const detail = summarizeToolInputLines(event.input)
              .map((l) => `  ${l}`)
              .join("\n");
            process.stderr.write(`[deskmony] 非互動模式,自動拒絕權限請求:${event.toolName}\n${detail}\n`);
          }
          void client
            .call("permission.resolve", { sessionId, requestId: event.requestId, decision: "deny" })
            .catch((err: unknown) => {
              process.stderr.write(`[deskmony] 送出權限拒絕失敗(忽略,繼續等這一輪結束):${describeError(err)}\n`);
            });
          break;
        }
        case "user-dialog-request": {
          // AskUserQuestion——run 沒有真人可以回答,送出「使用者略過作答」
          // (DialogAnswerSchema 的 "cancelled" 變體),避免這一輪永遠卡住
          // 等一個不會出現的答案。目前尚未在任何驗收案例中觸發(fake ACP
          // agent 不會送這個事件,只有 claude-agent-sdk 的 AskUserQuestion
          // 攔截路徑會),但不處理的話是一個真實的 hang 風險,值得先補上。
          void client
            .call("dialog.resolve", { sessionId, requestId: event.requestId, result: { behavior: "cancelled" } })
            .catch(() => {});
          break;
        }
        case "completed": {
          finish(() => {
            const finalText = event.finalText ?? "";
            // 見 render.ts 的呼叫慣例:deltas 已經串流過的文字不再重印一次
            // ——`completed.finalText` 只是「完整版本」,用來持久化,不是
            // 新內容。只有完全沒收到過 delta 的後端才需要靠這裡補印。
            if (!sawDelta && finalText.length > 0 && !options.json) {
              tracker.write(finalText);
            }
            tracker.ensureNewline();
            resolve({ finalText, deniedTools });
          });
          break;
        }
        case "error": {
          finish(() => {
            if (!options.json) {
              tracker.ensureNewline();
              process.stderr.write(renderErrorEvent(event.message, event.detail, options.color));
            }
            reject(new CliExitError(1, `agent 回報錯誤:${event.message}`));
          });
          break;
        }
      }
    });
  });
}

/**
 * `deskmony run <prompt>` / `deskmony run -`。
 *
 * 不會在結束後刪除建立出來的 session(HLD 沒有要求自動清理,§2 另外提供
 * 獨立的 `session rm` 子指令)——這個決定與桌面殼的行為一致:session 的
 * 歷史紀錄本身有價值(復原、之後用 `deskmony chat --session <id>` 接續),
 * 自動刪除反而讓使用者失去這個選項。
 */
export async function runCommand(options: GlobalOptions, promptArg: string): Promise<void> {
  const promptText = promptArg === "-" ? (await readPromptFromStdin()).trim() : promptArg;
  if (promptText.length === 0) {
    throw new CliExitError(2, "prompt 不能是空字串(讀到的內容 trim 後長度為 0)。");
  }

  const client = await connectGateway({ url: options.url, token: options.token });
  try {
    // HLD §4.2/session.ts 的 AgentOverrideSchema 註解:「只給 model(省略
    // software):software/command/args 全部沿用 profile 原本的設定」——
    // --model/--effort 都沒給時整個 agentOverride 留 undefined,不送一個
    // 空物件(避免 core 端把「使用者明確要求覆寫但兩個欄位都留空」與
    // 「使用者根本沒有要覆寫」混為一談,雖然目前 core 的實作對空物件與
    // undefined 應該同義,但語意上這樣寫比較誠實)。
    const agentOverride: AgentOverride | undefined =
      options.model !== undefined || options.effort !== undefined
        ? { model: options.model, effort: options.effort }
        : undefined;

    let session: Session;
    try {
      const result = (await client.call("session.create", {
        agentProfileId: options.profile,
        workingDir: options.cwd,
        agentOverride,
      })) as SessionCreateResult;
      session = result.session;
    } catch (err) {
      throw new CliExitError(1, `建立 session 失敗:${describeError(err)}`);
    }

    if (options.permissionMode !== undefined) {
      try {
        await client.call("session.setPermissionMode", { sessionId: session.id, mode: options.permissionMode });
      } catch (err) {
        throw new CliExitError(1, `設定 permission mode 失敗:${describeError(err)}`);
      }
    }

    // 訂閱(在 waitForTurn 內部)必須先於 sendPrompt 完成才安全——但這兩者
    // 都是同一輪 microtask/event-loop tick 內的動作,`onPush()` 是同步註冊
    // (見 gateway-client.ts,`pushListeners.add()` 沒有任何 await),
    // `sendPrompt` 真正觸發 adapter 開始工作是 core 端收到 request 之後的
    // 事,不可能比我們自己這行程式碼還早跑完,所以先建立 turnPromise 再
    // `await sendPrompt` 不會漏接任何事件。
    const turnPromise = waitForTurn(client, session.id, options);
    try {
      await client.call("session.sendPrompt", { sessionId: session.id, prompt: { text: promptText } });
    } catch (err) {
      throw new CliExitError(1, `送出 prompt 失敗:${describeError(err)}`);
    }

    const outcome = await turnPromise;
    if (outcome.deniedTools.length > 0) {
      throw new CliExitError(
        4,
        `因 ${outcome.deniedTools.length} 個工具呼叫被拒絕而以退出碼 4 結束(${outcome.deniedTools.join(", ")});` +
          "詳情見上方 stderr。要自動化請明講 --permission-mode auto-accept-edits" +
          "(對應 session.setPermissionMode),本工具不提供沉默放行的路。",
      );
    }
  } finally {
    closeGateway(client);
  }
}

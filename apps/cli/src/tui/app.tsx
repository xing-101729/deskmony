import React, { useEffect, useReducer } from "react";
import { Box, render, Text } from "ink";
import type { GatewayClient } from "@deskmony/client";
import type { EffectiveCoreConfig, MessageRecord, Session, SessionEventEnvelope } from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { CliExitError, closeGateway, connectGateway } from "../connect.js";
import {
  advancePermissionModal,
  appendPermissionYesInput,
  applyPermissionResolved,
  applySessionEvent,
  backspacePermissionYesInput,
  buildPermissionResolution,
  closePermissionModal,
  computeLayoutMode,
  createModel,
  CTRL_C_WINDOW_MS,
  cycleFocus,
  escapeStrongPermission,
  getCurrentPermission,
  getFocusedSessionView,
  getOrderedSessionViews,
  getPermissionModalPosition,
  moveSessionSelection,
  openPermissionModal,
  pressCtrlC,
  replaceSessions,
  requestQuit,
  scrollFocusedTranscript,
  seedHistoryIfEmpty,
  setConnectionStatus,
  setCostSnapshot,
  setTerminalSize,
  submitPermissionYesInput,
  toggleCollapsedSessionsExpanded,
  upsertSession,
  type PermissionResolution,
  type TuiModel,
} from "./model.js";
import { createKeyDecoder, type KeyDecoder, type ParsedKey } from "./keys.js";
import { registerExitRestore, restore } from "./restore.js";
import { SessionsPane, SessionsSummaryLine } from "./panes/SessionsPane.js";
import { TranscriptPane } from "./panes/TranscriptPane.js";
import { AlertBar } from "./panes/AlertBar.js";
import { StatusBar } from "./panes/StatusBar.js";
import { PermissionModal } from "./panes/PermissionModal.js";
import { BORDER_STYLE, connectionLabel } from "./theme.js";

/**
 * Ink 根元件與整個 `deskmony tui` 的組裝點(design 文件 §9 對這個檔案的
 * 定位)。這個檔案**才是**允許 import ink/react 的地方——`model.ts`/
 * `keys.ts` 刻意不行,見那兩個檔案檔頭的說明。
 *
 * T1 的範圍(HLD §11):骨架、四個區域版面、尺寸退化、終端還原,alert bar
 * 只顯示待決權限計數(見 panes/AlertBar.tsx),不提供處理它們的辦法。
 *
 * T2(design §4,本檔案這一輪的範圍):`a` 開啟逐一處理的權限彈窗——
 * `handlePermissionModalKey()`/`sendPermissionResolution()` 這兩個函式,
 * 與 `TuiRoot` 對 `model.permissionModalOpen` 的渲染分支。**決策邏輯本身
 * 不在這裡**——「目前該看哪一筆」「按下某個鍵該送出什麼決定」全部是
 * `tui/model.ts` 的純函式(design §9:「model.ts 不 import ink/react,才能
 * 在 e2e 裡直接單元測試,不需要跑起一個終端機」),這個檔案只負責接住
 * ParsedKey、呼叫對應的 model.ts 函式,以及真的把算好的結果送出
 * `permission.resolve` RPC。
 *
 * T1/T2 都不提供從 TUI 本身送出 prompt 的輸入框——這個 TUI 存在的理由是
 * 「唯讀監看多個 agent」(cli-tui_hld.md §2:「如果 TUI 只是把 REPL 畫進
 * 框線裡,它不值得做」),`deskmony chat`/`deskmony run`/其他 client 才是
 * 送出訊息的地方;權限彈窗是這個唯讀監看原則唯一的例外——不是「送話」,
 * 是「對別人已經在做的事表態」,兩者性質不同。
 */

const RENDER_INTERVAL_MS = 33; // §7:「setInterval 33ms(約 30fps),有髒資料才畫」。
const COST_POLL_INTERVAL_MS = 3_000;
const SESSIONS_PANE_WIDTH_FULL = 22; // §3:「Sessions(左,固定 22 欄)」。
const SESSIONS_PANE_WIDTH_COMPACT = 16; // §3.1:「80–99 欄:Sessions 窗格縮到 16 欄」。
const CHROME_ROW_HEIGHT = 3; // 一個只有一行內容的 bordered Box:上框線+內容+下框線。

function getTerminalSize(): { columns: number; rows: number } {
  return { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

interface TuiRootProps {
  model: TuiModel;
}

/**
 * 唯一會呼叫 `forceRerender()` 的地方——§7 紀律「事件進來只更新資料模型,
 * 絕不直接觸發重繪」的具體實作:WS 推播與按鍵處理常式(見下面 `runTui()`)
 * 只改 `model` 並把 `model.dirty` 設 true,由這個元件的 interval 決定什麼
 * 時候真的重繪。非焦點 session 的 delta 因此「只累積、不參與重繪」——它們
 * 的內容本來就不在目前畫出來的樹裡(見 panes/SessionsPane.tsx 只顯示圖示
 * /標題,不顯示 transcript 內容),33ms 節奏本身就已經確保不會因為它們而
 * 多重繪。
 */
function TuiRoot({ model }: TuiRootProps): React.JSX.Element {
  const [, forceRerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const id = setInterval(() => {
      if (model.dirty) {
        model.dirty = false;
        forceRerender();
      }
    }, RENDER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [model]);

  const layoutMode = computeLayoutMode(model.columns, model.rows);

  if (layoutMode === "too-small") {
    // §3.1 最後一列:「不是報錯退出,是等」——resize 監聽仍在跑(見
    // `runTui()` 的 `onResize`),一夠大就自動回到正常版面,這裡什麼都
    // 不用多做,下一次 `model.dirty` 變 true 時自然會重新算 layoutMode。
    return (
      <Box width={model.columns} height={model.rows} alignItems="center" justifyContent="center">
        <Text color="yellow">
          終端機太小(目前 {model.columns}×{model.rows},需要至少 60×16)
        </Text>
      </Box>
    );
  }

  const sessionViews = getOrderedSessionViews(model);
  const focusedView = getFocusedSessionView(model);
  const sessionTitle = (id: string): string => model.sessions.get(id)?.session.title ?? id;

  /**
   * T2:權限彈窗開著時,整個「中段 + alert bar」的版位讓給彈窗——不是疊在
   * 上面(Ink 沒有真正的 z-index/overlay,見 panes/PermissionModal.tsx 檔頭
   * 說明),而是直接取代。AlertBar 因此在彈窗開著時不畫(彈窗自己的標題列
   * 已經有「1/2」這種佇列位置資訊,兩者同時出現只是重複),但版面高度算法
   * 刻意不因為「少畫一個 alert bar」而改變——`middleHeight` 永遠假設 alert
   * bar 的空間已經被算進去,彈窗直接繼承整段高度,才不會在開/關彈窗之間
   * 造成其餘區域高度跳動。
   */
  const currentPermission = getCurrentPermission(model);
  const permissionPosition = getPermissionModalPosition(model);
  // 彈窗開著時不畫 AlertBar(見上方註解),所以這裡不必為它預留高度——
  // `middleHeight` 因此會自然地把那一段高度整個讓給彈窗或 `middle`,兩種
  // 情況共用同一個變數,不必另外算一個「彈窗高度」。
  const showAlertBar = !model.permissionModalOpen && model.pendingPermissions.length > 0;
  const alertBarHeight = showAlertBar ? CHROME_ROW_HEIGHT : 0;
  const middleHeight = Math.max(0, model.rows - CHROME_ROW_HEIGHT * 2 - alertBarHeight);

  let middle: React.JSX.Element;
  if (layoutMode === "collapsed") {
    // §3.1:「60–79 欄:Sessions 窗格收合成一列」——這裡的解讀是整個
    // Sessions 區域收合成一列(不是側欄變窄),Transcript 因此改成滿版寬,
    // 見 panes/SessionsPane.tsx 的 `SessionsSummaryLine` 註解。
    const summaryHeight = CHROME_ROW_HEIGHT;
    if (model.collapsedSessionsExpanded) {
      middle = (
        <Box flexDirection="column" height={middleHeight}>
          <SessionsSummaryLine sessions={sessionViews} expanded />
          <SessionsPane
            sessions={sessionViews}
            selectedSessionId={model.selectedSessionId}
            focused={model.focusedPane === "sessions"}
            compact={false}
            width={model.columns}
            height={Math.max(0, middleHeight - summaryHeight)}
          />
        </Box>
      );
    } else {
      middle = (
        <Box flexDirection="column" height={middleHeight}>
          <SessionsSummaryLine sessions={sessionViews} expanded={false} />
          <TranscriptPane
            view={focusedView}
            focused={model.focusedPane === "transcript"}
            width={model.columns}
            height={Math.max(0, middleHeight - summaryHeight)}
          />
        </Box>
      );
    }
  } else {
    const sidebarWidth = layoutMode === "compact" ? SESSIONS_PANE_WIDTH_COMPACT : SESSIONS_PANE_WIDTH_FULL;
    middle = (
      <Box flexDirection="row" height={middleHeight}>
        <SessionsPane
          sessions={sessionViews}
          selectedSessionId={model.selectedSessionId}
          focused={model.focusedPane === "sessions"}
          compact={layoutMode === "compact"}
          width={sidebarWidth}
          height={middleHeight}
        />
        <TranscriptPane
          view={focusedView}
          focused={model.focusedPane === "transcript"}
          width={Math.max(1, model.columns - sidebarWidth)}
          height={middleHeight}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={model.columns} height={model.rows}>
      <Box borderStyle={BORDER_STYLE} paddingX={1} flexDirection="row">
        <Text bold>Deskmony</Text>
        <Text>
          {" "}
          — {model.wsUrl} · {connectionLabel(model.connection)}
        </Text>
      </Box>
      {model.permissionModalOpen && currentPermission && permissionPosition ? (
        <PermissionModal
          current={currentPermission}
          position={permissionPosition}
          sessionTitle={sessionTitle}
          yesInput={model.permissionYesInput}
          width={model.columns}
          height={middleHeight}
        />
      ) : (
        middle
      )}
      {showAlertBar && <AlertBar pendingPermissions={model.pendingPermissions} sessionTitle={sessionTitle} width={model.columns} />}
      <StatusBar cost={model.cost} width={model.columns} ctrlCArmedUntil={model.ctrlCArmedUntil} />
    </Box>
  );
}

/**
 * 命令進入點(`commands/tui.ts` 動態 `import()` 之後呼叫)。已經確認過
 * Node 版本與 stdin/stdout 是 TTY(見 commands/tui.ts),這裡不重複檢查。
 */
export async function runTui(options: GlobalOptions): Promise<void> {
  const initialSize = getTerminalSize();
  const model = createModel(options.url, initialSize.columns, initialSize.rows);

  // §6.3:越早掛越好——之後任何一步(raw mode、alternate screen)出錯,
  // 已經做過的終端狀態變更都不該留著不還原。
  registerExitRestore();

  let client: GatewayClient | undefined;
  let costPollTimer: ReturnType<typeof setInterval> | undefined;
  let dailyCapUsd: number | undefined;
  const unsubscribeFns: Array<() => void> = [];
  let exited = false;

  function onResize(): void {
    const size = getTerminalSize();
    setTerminalSize(model, size.columns, size.rows);
  }
  process.stdout.on("resize", onResize);

  const keyDecoder: KeyDecoder = createKeyDecoder(handleKey);
  function onStdinData(chunk: Buffer): void {
    keyDecoder.feed(chunk);
  }
  // 只有真的是 TTY 才切 raw mode——`commands/tui.ts` 已經在呼叫這個函式
  // 之前擋掉非 TTY 的情況,這裡的判斷是防禦性的第二層(比照
  // commands/chat.ts 對 `process.stdin.setRawMode?.()` 的既有寫法)。
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdin.on("data", onStdinData);

  function onSigterm(): void {
    quit(0);
  }
  // bin.ts 對 run/session/profile/doctor/config 刻意**不**裝 SIGINT/SIGTERM
  // handler(見該檔案檔頭:讓 Node 的預設行為接管最安全)。這個 TUI 是
  // 唯一的例外,理由是 raw mode 已經接管了 stdin——沒有這個 handler,
  // 外部送來的 SIGTERM(沒有 listener 時的 Node 預設行為)會直接跳過
  // `process.on("exit")`,restore.ts 的三個保證就有機會完全沒機會執行,
  // 使用者的終端就這樣壞掉。這裡的 handler 刻意只做一件事——呼叫
  // `quit()`(本身是同步函式,不夾雜任何非同步操作)——呼應 bin.ts 檔頭
  // 那段「handler 裡混入非同步操作反而更危險」的警告。
  process.on("SIGTERM", onSigterm);

  /** 所有會讓行程「活著」的東西(stdin listener/raw mode、resize listener、
   *  SIGTERM handler、cost 輪詢計時器、WS push 訂閱)收在一起清——
   *  `quit()` 與連線失敗兩條路徑都需要完整跑過這一輪,重複兩份容易漏。 */
  function cleanupIo(): void {
    if (costPollTimer) clearInterval(costPollTimer);
    for (const unsubscribe of unsubscribeFns.splice(0)) unsubscribe();
    keyDecoder.dispose();
    try {
      process.stdin.removeListener("data", onStdinData);
      process.stdin.pause();
    } catch {
      // 非 TTY 或已經被關閉——忽略。
    }
    process.stdout.removeListener("resize", onResize);
    process.removeListener("SIGTERM", onSigterm);
  }

  function quit(code: number): void {
    if (exited) return;
    exited = true;
    cleanupIo();
    if (client) closeGateway(client);
    /**
     * 順序刻意如此(見 tui/restore.ts 檔頭「為什麼重複寫」那一段的完整
     * 說明):先呼叫 `instance.unmount()` 讓 ink 自己完整跑完(它會在**還
     * 在 alternate screen 內**時畫最後一次畫面,再離開 alternate screen、
     * 顯示游標),`restore()` 才不會搶在它前面切回主畫面,把最後一次畫面
     * 畫錯緩衝區。`process.on("exit")` 掛的那份 `restore()` 之後還會再跑
     * 一次(冪等),是保底,不是這裡真正依賴的路徑。
     */
    instance.unmount();
    restore();
    process.exit(code);
  }

  /**
   * T2:送出一筆 `permission.resolve` 決定。刻意集中成這一個函式,而不是在
   * `handlePermissionModalKey()` 的每個分支各自呼叫`client.call()`——所有
   * 呼叫共用同一套「沒有連線就放棄」「失敗就靜默留著讓使用者再按一次」的
   * 取捨(理由見下方 catch 區塊的說明),散在多處容易漏改。**不在這裡更新
   * `pendingPermissions` 或關閉/前進彈窗**——那是 `model.ts` 的
   * `applyPermissionResolved()`/`syncPermissionModalWithQueue()` 收到 core
   * 廣播回來的 `permission-resolved` 推播之後才做的事(見 model.ts 對應
   * 函式的完整說明),這裡搶先做的話,萬一 RPC 其實失敗了,畫面會顯示一個
   * 其實沒有真的被處理掉的狀態。
   */
  function sendPermissionResolution(resolution: PermissionResolution): void {
    if (!client) return;
    void client.call("permission.resolve", resolution).catch(() => {
      // 送出失敗(例如連線剛好斷開)——不假裝已經處理掉,讓這一筆繼續留在
      // 佇列裡,使用者可以之後再按一次。錯誤目前沒有地方顯示,比照 app.tsx
      // 其餘 RPC 呼叫的既有取捨(cost 輪詢/history 補值失敗都是靜默重試或
      // 忽略,見對應註解)。
    });
  }

  /**
   * T2(design §6.1):「權限彈窗出現時搶走全部按鍵,底層窗格不接收」——這裡
   * 是那條紀律唯一的實作點,`handleKey()` 在彈窗開著時整個轉交給這個函式,
   * **包含 Ctrl+C**:一般情況下 Ctrl+C 會中斷「目前焦點 session」,但彈窗
   * 開著時畫面上完全沒有顯示是哪個 session 有焦點(整個中段被彈窗取代,見
   * `TuiRoot` 的渲染邏輯),誤觸的代價與「以為在選 session,其實按到了
   * 允許」是同一種問題,所以連 Ctrl+C 也一併吞掉。要離開彈窗一律先按
   * `Esc`(一般請求直接關閉;strong 請求送出明確拒絕,見
   * `escapeStrongPermission()`),退出彈窗之後 Ctrl+C/`q` 才恢復原本語意。
   */
  function handlePermissionModalKey(key: ParsedKey): void {
    const current = getCurrentPermission(model);
    if (!current) {
      // 理論上不該發生:`syncPermissionModalWithQueue()` 已經會在佇列清空
      // 的當下自動關閉彈窗。防禦性地在這裡兜底,避免真的發生時卡在一個
      // 沒有任何鍵有反應的空白彈窗。
      closePermissionModal(model);
      return;
    }

    if (current.strong) {
      // design §4.3:strong 畫面沒有單鍵捷徑,`a`/`d`/`n` 這些字元在這裡
      // 一律當成「正在打字」處理(見下面 `case "char"`),不會被解讀成
      // 一般畫面的允許/拒絕/下一筆。
      switch (key.name) {
        case "escape": {
          const resolution = escapeStrongPermission(model);
          if (resolution) sendPermissionResolution(resolution);
          return;
        }
        case "return": {
          const resolution = submitPermissionYesInput(model);
          if (resolution) sendPermissionResolution(resolution);
          return;
        }
        case "backspace":
          backspacePermissionYesInput(model);
          return;
        case "char":
          appendPermissionYesInput(model, key.char ?? "");
          return;
        default:
          return; // 方向鍵/Tab 等在 strong 畫面沒有意義,吞掉。
      }
    }

    // 一般(非 strong)請求(design §4.2)。
    switch (key.name) {
      case "escape":
        closePermissionModal(model); // 「稍後再說」——不送出任何決定。
        return;
      case "char":
        if (key.char === "a") {
          const resolution = buildPermissionResolution(model, "allow", false);
          if (resolution) sendPermissionResolution(resolution);
          return;
        }
        if (key.char === "d") {
          const resolution = buildPermissionResolution(model, "deny", false);
          if (resolution) sendPermissionResolution(resolution);
          return;
        }
        if (key.char === "A") {
          const resolution = buildPermissionResolution(model, "allow", true);
          if (resolution) sendPermissionResolution(resolution);
          return;
        }
        if (key.char === "n") {
          advancePermissionModal(model);
          return;
        }
        return; // 其餘字元:吞掉,不做任何事(§6.1「搶走全部按鍵」)。
      default:
        return;
    }
  }

  function handleKey(key: ParsedKey): void {
    if (model.quitRequested) return; // 已經在收尾,不要再處理新按鍵。

    if (model.permissionModalOpen) {
      handlePermissionModalKey(key);
      return;
    }

    switch (key.name) {
      case "ctrl-c": {
        // §6.3:第一次 = 中斷焦點 session(若忙碌)並提示;兩秒內第二次 =
        // 離開。語意與 apps/cli/src/commands/chat.ts 的
        // `requestInterruptOrQuit()` 一致。
        const action = pressCtrlC(model, Date.now());
        if (action === "quit") {
          quit(0);
          return;
        }
        const focused = getFocusedSessionView(model);
        if (focused && focused.session.status === "busy" && client) {
          void client.call("session.interrupt", { sessionId: focused.session.id }).catch(() => {
            // 同 chat.ts 既有取捨:session 可能剛好已經不是 busy,失敗就忽略。
          });
        }
        /**
         * StatusBar 的「兩秒內再按一次可離開」提示只在 `model.dirty` 為
         * true 時的下一次 33ms 節奏才會畫出來——這裡按下的當下已經
         * `markDirty` 過一次(`pressCtrlC()` 內部做的),所以提示會立刻
         * 出現;但兩秒之後**沒有任何其他事件**發生的話(例如 session 一直
         * 是 idle、也沒有別的 session 在動),不會有任何東西再把
         * `model.dirty` 設回 true,提示就會卡住不消失,即使
         * `pressCtrlC()` 的判斷邏輯本身早就正確地把視窗當作已經過期。這裡
         * 額外排一個到期時間到了才觸發的計時器,單純是為了讓「畫面顯示的
         * 提示」與「真正的邏輯狀態」重新對齊,不影響任何功能性判斷。
         */
        setTimeout(() => {
          if (!exited) model.dirty = true;
        }, CTRL_C_WINDOW_MS + 50);
        return;
      }
      case "tab":
      case "shift-tab":
        // §6.1:「窗格焦點(Sessions ↔ Transcript):Tab / Shift+Tab 循環」
        // ——只有兩個窗格,循環方向對 Tab/Shift+Tab 沒有分別。
        cycleFocus(model);
        return;
      case "up":
        if (model.focusedPane === "sessions") moveSessionSelection(model, -1);
        else scrollFocusedTranscript(model, 1); // 往回捲(看較舊內容)。
        return;
      case "down":
        if (model.focusedPane === "sessions") moveSessionSelection(model, 1);
        else scrollFocusedTranscript(model, -1);
        return;
      case "pageup":
        scrollFocusedTranscript(model, 10);
        return;
      case "pagedown":
        scrollFocusedTranscript(model, -10);
        return;
      case "char":
        if (key.char === "q") {
          // 呼叫 model.ts 的 `requestQuit()` 而不是只呼叫下面的 `quit()`
          // ——讓 `model.quitRequested` 在「按 q」與「雙擊 Ctrl+C」兩條路徑
          // 都會被正確設起來,這樣之後若有測試只針對 model.ts 純函式驗證
          // (不需要真的跑 app.tsx/process.exit),看到的行為會一致。
          requestQuit(model);
          quit(0);
          return;
        }
        if (key.char === "s") {
          toggleCollapsedSessionsExpanded(model);
          return;
        }
        if (key.char === "a") {
          // T2(design §3「[a] 逐一處理」/§4.1):開啟權限佇列彈窗。佇列是
          // 空的時候維持 T1 的 no-op——`openPermissionModal()` 自己也會做
          // 同樣的防呆(見 model.ts),這裡先擋一次純粹是避免多餘的
          // `markDirty()`(雖然無害,但沒有理由不擋)。
          if (model.pendingPermissions.length > 0) openPermissionModal(model);
          return;
        }
        return; // 其餘一般字元:這個 TUI 是唯讀監看,沒有輸入框可以接收,忽略。
      default:
        return; // escape/return/backspace/ctrl-a/ctrl-d:T1 無對應用途。
    }
  }

  /**
   * `exitOnCtrlC: false`——工作說明裡已經驗證過的事實,照樣傳(見
   * tui/keys.ts 檔頭:這個 TUI 完全不用 ink 的 `useInput()`,自己接管
   * stdin,所以 ink 的 Ctrl+C 攔截路徑實際上永遠不會被觸發到;這裡仍然
   * 傳 `false` 是零成本的防禦性設定,照字面要求做,不去賭「反正用不到就
   * 不用傳」)。
   *
   * `alternateScreen: true`——讓 ink 自己管進入/離開 alternate screen 與
   * 對應的游標顯示/隱藏(見 tui/restore.ts 檔頭:這是讀過 ink 原始碼確認
   * 過的內建行為,不是猜的)。
   */
  const instance = render(<TuiRoot model={model} />, {
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnCtrlC: false,
    alternateScreen: true,
  });

  try {
    client = await connectGateway({ url: options.url, token: options.token });
  } catch (err) {
    /**
     * 這裡**不能**只是 `throw err` 交給 bin.ts 既有的 catch-all(那是其餘
     * 一次性指令的標準做法,見 bin.ts 檔頭)——這個 TUI 已經把 stdin 切進
     * raw mode。`apps/cli/src/commands/chat.ts` 對同一個問題的既有結論
     * (見該檔案 `cleanupAndExit()` 的註解)是:即使把 listener 全部拔掉、
     * 呼叫 `setRawMode(false)`,TTY 的 stdin 仍然可能是一個讓事件迴圈不肯
     * 自然結束的活躍 handle,唯一可靠的做法是明講呼叫 `process.exit()`。
     * 這裡因此就地印出訊息、決定退出碼(邏輯與 bin.ts 的 catch-all 對
     * `CliExitError` 的處理刻意一致),不依賴「拋出例外後事件迴圈自然
     * 結束」這條路。
     */
    cleanupIo();
    instance.unmount();
    restore();
    const exitCode = err instanceof CliExitError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[deskmony] ${message}\n`);
    process.exit(exitCode);
  }

  setConnectionStatus(model, "open");
  unsubscribeFns.push(client.onStatus((status) => setConnectionStatus(model, status)));

  /** 見 model.ts 的 `seedHistoryIfEmpty()` 檔頭說明——只補一次,補過的
   *  session id 記在這裡,`session-list-updated`/重連導致的重複
   *  `refreshSessions()` 呼叫不會為同一個 session 重複打 `session.history`。 */
  const historySeeded = new Set<string>();

  async function refreshSessions(): Promise<void> {
    if (!client) return;
    try {
      const result = (await client.call("session.list", {})) as { sessions: Session[] };
      replaceSessions(model, result.sessions);
      for (const session of result.sessions) {
        if (historySeeded.has(session.id)) continue;
        historySeeded.add(session.id);
        const currentClient = client;
        void currentClient
          .call("session.history", { sessionId: session.id })
          .then((raw) => {
            const { messages } = raw as { messages: MessageRecord[] };
            seedHistoryIfEmpty(model, session.id, messages);
          })
          .catch(() => {
            // 讀歷史失敗不是致命錯誤(比照 chat.ts 的 replayHistory()既有
            // 取捨)——這個 session 之後收到 live 事件時仍然能正常運作,
            // 只是少了「開場」的既有對話,不影響其餘功能。
          });
      }
    } catch {
      // 連線問題已經由 onStatus 反映在標題列,這裡不需要再另外報錯一次。
    }
  }

  unsubscribeFns.push(
    client.onPush((push) => {
      if (push.channel === "session-event") {
        applySessionEvent(model, push.payload as SessionEventEnvelope);
      } else if (push.channel === "session-updated") {
        upsertSession(model, push.payload as Session);
      } else if (push.channel === "session-list-updated") {
        // payload 恆為 null——單純是「清單變了,重新拉一次」的訊號(比照
        // apps/desktop/src/stores/session-store.ts 既有的處理方式)。
        void refreshSessions();
      } else if (push.channel === "permission-resolved") {
        const payload = push.payload as { sessionId: string; requestId: string };
        applyPermissionResolved(model, payload.sessionId, payload.requestId);
      }
    }),
  );
  unsubscribeFns.push(
    client.onReconnected(() => {
      // 見 gateway-client.ts 的 `onReconnected()` 註解:斷線期間的推播
      // 確定性遺失,重新連上後用「重新拉一次快照」收斂到正確狀態。
      void refreshSessions();
    }),
  );

  await refreshSessions();

  try {
    const result = (await client.call("config.getEffective", {})) as { effective: EffectiveCoreConfig };
    dailyCapUsd = result.effective.budget.daily.maxCostUsd.value;
  } catch {
    dailyCapUsd = undefined; // 拿不到就顯示「—」(見 StatusBar.tsx 的 formatUsd),不編造數字。
  }

  /**
   * §3 狀態列的「今日 $x / $cap」——`cost.getSummary` 需要一個 sessionId
   * (見 apps/core/src/cost/cost-governor.ts 的 `getSummary()`),但回傳
   * 的 `day` rollup 本來就是跨 session 彙總,查哪個 session 都一樣;這裡
   * 用目前選取的 session(沒有就用清單第一個),純粹是「總要給一個合法
   * id」,不影響 `day`/`dailyTripped` 的正確性。輪詢(而非推播)是因為
   * gateway 沒有對應的 push channel(見 packages/shared/src/gateway.ts 的
   * `ServerPushSchema` channel 列舉——沒有 cost 相關的項目),這是骨架
   * 顯示這個資訊唯一的辦法。
   */
  async function pollCost(): Promise<void> {
    if (!client) return;
    const sessionId = model.selectedSessionId ?? model.sessionOrder[0];
    if (!sessionId) return;
    try {
      const result = (await client.call("cost.getSummary", { sessionId })) as {
        session: { costAmount: number; costCurrency: string | undefined };
        day: { costAmount: number; costCurrency: string | undefined };
        dailyTripped: boolean;
      };
      setCostSnapshot(model, {
        sessionId,
        sessionCostUsd: result.session.costCurrency !== undefined ? result.session.costAmount : undefined,
        todayCostUsd: result.day.costCurrency !== undefined ? result.day.costAmount : undefined,
        dailyCapUsd,
        dailyTripped: result.dailyTripped,
      });
    } catch {
      // 略過這一輪,下一次 interval 再試——不值得為了一個顯示用的數字影響
      // 其他功能。
    }
  }
  costPollTimer = setInterval(() => void pollCost(), COST_POLL_INTERVAL_MS);
  void pollCost();
}

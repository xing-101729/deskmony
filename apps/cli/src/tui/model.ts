import type { AgentEvent, MessageRecord, PolicyRule, Session, SessionEventEnvelope } from "@deskmony/shared";
import { buildNarrowestRememberRule, summarizeToolCallOneLine } from "../render.js";

/**
 * `deskmony tui` 的資料模型——design 文件 docs/LAYER-3-hld/cli-tui_hld.md §9
 * 講的「事件 → 資料模型(不含任何渲染)」。這個檔案**不 import ink 或
 * react**,純粹操作 plain object/Map,理由見該文件同一段:model.ts 要能在
 * e2e(未來 T3)裡直接單元測試,不需要跑起一個終端機。
 *
 * 設計成「可變 class 風格的 reducer」而非 Redux 那種每次回傳新物件——§7
 * 明講一個 busy session 的 `message-delta` 可以每秒數十次,若每次事件都
 * 整棵複製一份 sessions Map,會製造大量不必要的配置/GC 壓力。這裡改成
 * 直接原地變更,並用 `dirty` 旗標告訴外層(app.tsx 的 33ms 節奏)「這一輪
 * 有沒有東西真的變了、值不值得重繪」——重繪節奏本身不在這個檔案裡(那是
 * app.tsx 的職責,這裡只負責把旗標立起來)。
 */

// ---- 型別 ------------------------------------------------------------------

export type ConnectionStatus = "connecting" | "open" | "closed";
export type PaneFocus = "sessions" | "transcript";
export type LayoutMode = "full" | "compact" | "collapsed" | "too-small";

/**
 * 一行已經定案、不會再變的 transcript 內容。§7 規定每個 session 的緩衝上限
 * 2000 行(`MAX_TRANSCRIPT_LINES`),超過從頭砍——alternate screen 沒有終端機
 * 原生的 scrollback 可以退回去,這個陣列就是全部,所以一定要有上限。
 *
 * `kind` 只用來決定 TranscriptPane 要用什麼顏色畫這一行(見 theme.ts),
 * 這個檔案本身不碰任何顏色/ANSI——那是渲染層的事。
 */
export interface TranscriptLine {
  kind: "tool" | "tool-error" | "system" | "permission" | "agent" | "user";
  text: string;
}

/**
 * T2(權限佇列)要接手的資料,T1 先把形狀定出來、塞進佇列,但**不**提供
 * 解決它的 UI(見本檔案 `applySessionEvent` 的 "permission-request" case
 * 與 tui/app.tsx 對 `a` 鍵的處理註解——那裡才是真正的「T1 留的縫」)。
 */
export interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  strong: boolean;
}

/** T2:送給 `permission.resolve` RPC 的參數(見 packages/shared/src/events.ts
 *  的 `PermissionDecisionSchema`)。`sessionId` 必填——design 文件 §4.2 的
 *  紀律:「TUI 天然是多 session,這裡尤其不能靠 requestId 反查」,`model.ts`
 *  底下 build/submit/escape 開頭的系列函式一律從 `PendingPermission`(本來
 *  就帶 `sessionId`)組出這個物件,呼叫端(app.tsx)不需要、也不應該自己
 *  另外湊參數。 */
export interface PermissionResolution {
  sessionId: string;
  requestId: string;
  decision: "allow" | "deny";
  rememberRule?: PolicyRule;
}

/** 見 apps/core/src/cost/cost-governor.ts 的 `getSummary()`——這裡只留
 *  TUI 用得到的欄位,不是整個 RPC 回應的鏡射。`sessionId` 記的是這份
 *  snapshot 對應哪個 session 查來的(`sessionCostUsd` 只對那個 session 有
 *  意義),`todayCostUsd`/`dailyCapUsd`/`dailyTripped` 則是全域的(不論查
 *  哪個 session 都一樣,因為 CostGovernor 的 "day" scope 本來就是跨 session
 *  彙總)。 */
export interface CostSnapshot {
  sessionId: string | undefined;
  sessionCostUsd: number | undefined;
  todayCostUsd: number | undefined;
  dailyCapUsd: number | undefined;
  dailyTripped: boolean;
}

/** 單一 session 在 TUI 裡的完整檢視狀態:核心 `Session` 物件 + 這個 session
 *  自己的 transcript 緩衝 + 捲動位置。 */
export interface SessionView {
  session: Session;
  lines: TranscriptLine[];
  /** `message-delta` 還在串流、尚未收到 `done:true` 的那一段——TranscriptPane
   *  把它當「目前正在長出來的最後一行」顯示,收到 done 才轉成 `lines` 裡
   *  定案的一行。 */
  pendingAssistant: { messageId: string; text: string } | undefined;
  /** 0 = 貼齊底部(跟隨最新輸出)。> 0 = 使用者往回捲了幾行。 */
  scrollOffset: number;
}

export interface TuiModel {
  wsUrl: string;
  connection: ConnectionStatus;
  columns: number;
  rows: number;
  sessions: Map<string, SessionView>;
  /** 顯示順序——目前用「第一次看到的順序」,不重新排序,避免 session 在
   *  列表裡跳動位置讓人找不到游標在哪。 */
  sessionOrder: string[];
  focusedPane: PaneFocus;
  selectedSessionId: string | undefined;
  /** §3.1 collapsed(60–79 欄)模式下,`[s]` 是否已展開成完整清單。只有
   *  collapsed 模式會讀這個欄位,compact/full 模式忽略它。 */
  collapsedSessionsExpanded: boolean;
  pendingPermissions: PendingPermission[];
  /** T2(design §4.2):權限彈窗是否開啟。`a` 開(僅在佇列非空時),`Esc`
   *  或佇列清空時關閉。開著的時候 app.tsx 的按鍵處理常式會把**全部**按鍵
   *  導向彈窗自己的邏輯,底下的窗格(Sessions/Transcript)不收到任何按鍵
   *  ——design §6.1:「權限彈窗出現時搶走全部按鍵,避免以為在選 session,
   *  其實按到了允許」。 */
  permissionModalOpen: boolean;
  /** 彈窗目前顯示 `pendingPermissions` 裡的哪一筆——用 (sessionId,
   *  requestId) 這組身分認定,**不是**陣列索引。原因:陣列會因為佇列裡
   *  任何一筆被解決(這個 client 自己送出決定、別的 client 處理掉,或政策
   *  引擎判定,見 `applyPermissionResolved()`)而變動,若靠索引記錄,中間
   *  被抽掉一筆時索引在數字上仍然合法,卻會不知不覺指向另一筆完全不同的
   *  請求——這正是多 session 环境下「按下的決定套用到錯的請求」這類 bug
   *  的成因(呼應 packages/shared/src/events.ts 對 `PermissionDecisionSchema.
   *  sessionId` 欄位「不能靠 requestId 單鍵反查」的說明,這裡是同一個顧慮
   *  在 client 端資料模型裡的版本)。`undefined` 代表彈窗未開啟或佇列已空。 */
  permissionModalCurrent: { sessionId: string; requestId: string } | undefined;
  /** design §4.3:strong(escalate-strong)請求要求「完整輸入 yes」才允許,
   *  不接受單鍵確認——這裡存目前打到一半的字元。只有目前顯示的請求是
   *  strong 時才有意義;切換到別的請求(`n`,或佇列變動觸發的自動前進)
   *  一律清空,避免看到殘留的舊字元。 */
  permissionYesInput: string;
  /** §6.3 雙擊 Ctrl+C:這個時間戳之前收到的下一次 Ctrl+C 視為「確認離開」。
   *  0 = 尚未按過(或視窗已過期,語意上等同未按過)。 */
  ctrlCArmedUntil: number;
  cost: CostSnapshot;
  /** 使用者已經確認要離開(雙擊 Ctrl+C 第二下,或 `q`)——app.tsx 的按鍵
   *  處理常式看到這個之後才真的觸發 unmount/process.exit(),這個欄位本身
   *  只是「決定要走了」的訊號,不代表真的已經退出。 */
  quitRequested: boolean;
  /** app.tsx 的 33ms 節奏只在這個旗標為 true 時才重繪,重繪後清成 false。
   *  §7 紀律:「事件進來只更新資料模型,絕不直接觸發重繪」——這個欄位就是
   *  那條紀律的具體實作切點。 */
  dirty: boolean;
}

// ---- 常數 ------------------------------------------------------------------

/** §7:「Transcript 的捲動緩衝有上限(每個 session 保留最後 2000 行)」。 */
export const MAX_TRANSCRIPT_LINES = 2000;

/** §6.3:「兩秒內再按一次」。 */
export const CTRL_C_WINDOW_MS = 2000;

/** §3.1 尺寸退化表格的門檻。 */
const MIN_COLUMNS = 60;
const MIN_ROWS = 16;
const COMPACT_MIN_COLUMNS = 80;
const FULL_MIN_COLUMNS = 100;
const FULL_MIN_ROWS = 24;

// ---- 建構 ------------------------------------------------------------------

export function createModel(wsUrl: string, columns: number, rows: number): TuiModel {
  return {
    wsUrl,
    connection: "connecting",
    columns,
    rows,
    sessions: new Map(),
    sessionOrder: [],
    focusedPane: "sessions",
    selectedSessionId: undefined,
    collapsedSessionsExpanded: false,
    pendingPermissions: [],
    permissionModalOpen: false,
    permissionModalCurrent: undefined,
    permissionYesInput: "",
    ctrlCArmedUntil: 0,
    cost: { sessionId: undefined, sessionCostUsd: undefined, todayCostUsd: undefined, dailyCapUsd: undefined, dailyTripped: false },
    quitRequested: false,
    dirty: true, // 第一次一定要畫。
  };
}

function markDirty(model: TuiModel): void {
  model.dirty = true;
}

// ---- 尺寸退化(§3.1)---------------------------------------------------------

/**
 * 純函式,不吃 model——§3.1 的門檻表本身是靜態資料,不需要目前狀態就能算出
 * 結果,獨立出來才能不跑終端機直接單元測試(呼應 model.ts 整體的可測性
 * 目標)。
 *
 * 判斷取捨:表格第一列(完整版面)明講要 `≥ 100 × 24`,但中間兩列
 * (compact/collapsed)只給欄數門檻、沒有另外講列數——這裡的解讀是:**欄數
 * 決定用哪一種寬度排版(full/compact/collapsed 三選一是同一個維度上的三個
 * 級距),列數只決定「夠不夠格畫任何版面」(< 16 一律 too-small,不論多寬)**。
 * 一個 105×18 的視窗因此仍然算 full(欄位夠寬,只是內容區域可以顯示的行數
 * 比示意圖少),而不是退化成 compact——compact 的窄側欄本來就是為了省欄位
 * 寬度,一個橫向很寬的視窗沒有理由因為「矮」而被迫縮減側欄寬度。表格本身
 * 沒有明講這個交叉情況,這是這輪的合理判斷,不是查證到的事實。
 */
export function computeLayoutMode(columns: number, rows: number): LayoutMode {
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return "too-small";
  if (columns >= FULL_MIN_COLUMNS && rows >= FULL_MIN_ROWS) return "full";
  if (columns >= COMPACT_MIN_COLUMNS) return "compact";
  if (columns >= FULL_MIN_COLUMNS) return "full"; // 見上方註解:寬但矮,仍用 full 排版。
  return "collapsed"; // 60–79
}

export function setTerminalSize(model: TuiModel, columns: number, rows: number): void {
  if (model.columns === columns && model.rows === rows) return;
  model.columns = columns;
  model.rows = rows;
  markDirty(model);
}

export function setConnectionStatus(model: TuiModel, status: ConnectionStatus): void {
  if (model.connection === status) return;
  model.connection = status;
  markDirty(model);
}

// ---- session 清單 -----------------------------------------------------------

function ensureSelection(model: TuiModel): void {
  if (model.selectedSessionId && model.sessions.has(model.selectedSessionId)) return;
  model.selectedSessionId = model.sessionOrder[0];
}

function newSessionView(session: Session): SessionView {
  return { session, lines: [], pendingAssistant: undefined, scrollOffset: 0 };
}

/** `session.list` RPC 的結果(初次載入,或收到 "session-list-updated" 推播
 *  之後重新拉取)——**整份覆蓋**,但既有 session 的 transcript/捲動狀態要
 *  保留,不能因為重新拉了一次清單就把使用者正在看的內容清空。 */
export function replaceSessions(model: TuiModel, sessions: Session[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    seen.add(session.id);
    const existing = model.sessions.get(session.id);
    if (existing) {
      existing.session = session;
    } else {
      model.sessions.set(session.id, newSessionView(session));
      model.sessionOrder.push(session.id);
    }
  }
  // 清單裡消失的(被刪除的)session——連同它的 transcript 一併移除。
  for (const id of [...model.sessionOrder]) {
    if (!seen.has(id)) {
      model.sessions.delete(id);
      model.sessionOrder = model.sessionOrder.filter((x) => x !== id);
    }
  }
  ensureSelection(model);
  markDirty(model);
}

/** "session-updated" 推播——單一 session 的欄位變更(狀態、標題、model…)。 */
export function upsertSession(model: TuiModel, session: Session): void {
  const existing = model.sessions.get(session.id);
  if (existing) {
    existing.session = session;
  } else {
    model.sessions.set(session.id, newSessionView(session));
    model.sessionOrder.push(session.id);
    ensureSelection(model);
  }
  markDirty(model);
}

function getOrCreateSessionView(model: TuiModel, sessionId: string): SessionView {
  const existing = model.sessions.get(sessionId);
  if (existing) return existing;
  // 理論上不該發生:"session-event" 是在 "session-updated"/"session-list-
  // updated" 讓我們知道這個 session 存在**之後**才會有的東西。防禦性地生出
  // 一個佔位 Session,避免一筆事件因為到達順序的競態而整個被丟掉——
  // 佔位值之後會被真正的 "session-updated" 推播覆蓋掉(見上面 upsertSession
  // 直接取代 `.session` 整個物件)。
  const placeholder: Session = {
    id: sessionId,
    title: "(尚未同步的 session)",
    agentProfileId: "",
    adapterType: "claude-agent-sdk",
    status: "busy",
    workingDir: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const view = newSessionView(placeholder);
  model.sessions.set(sessionId, view);
  model.sessionOrder.push(sessionId);
  ensureSelection(model);
  return view;
}

// ---- agent 事件 → transcript ------------------------------------------------

function pushLine(view: SessionView, line: TranscriptLine): void {
  view.lines.push(line);
  if (view.lines.length > MAX_TRANSCRIPT_LINES) {
    view.lines.splice(0, view.lines.length - MAX_TRANSCRIPT_LINES);
  }
}

/**
 * `AgentEvent` → transcript 行。刻意重用 `render.ts` 的 `summarizeToolCallOneLine`
 * ——那個函式已經處理過「認得的鍵優先顯示」這個陷阱(§13.3),TUI 不需要
 * 重寫一份;`render.ts` 本身不 import ink/react(純字串格式化),所以這個
 * 依賴不會把 ink/react 拉進這個檔案的 import graph。
 *
 * 不處理的事件型別(對照 apps/cli/src/render.ts 的 `renderAgentEventPretty`
 * 同一份判斷,這裡刻意保持一致):`usage`/`context-usage`/
 * `available-commands` 不進 transcript;`completed` 不留痕跡(session 狀態
 * 圖示的變化已經足夠表達「這一輪結束了」);`terminal-data`——HLD §8「刻意
 * 不做的」明講 PTY session 的原始 ANSI 不在 TUI 的窗格裡渲染,
 * TranscriptPane 對 `adapterType === "pty"` 的 session 整個顯示替代訊息,
 * 這裡收到 terminal-data 也不必處理(反正不會被顯示)。
 */
export function applySessionEvent(model: TuiModel, envelope: SessionEventEnvelope): void {
  const view = getOrCreateSessionView(model, envelope.sessionId);
  const event: AgentEvent = envelope.event;

  switch (event.type) {
    case "message-delta": {
      if (view.pendingAssistant && view.pendingAssistant.messageId !== event.messageId) {
        // 防禦性處理:理論上不該在收到 done 之前換 messageId,但真的發生時
        // 先把舊的定案,不要讓它憑空消失。
        pushLine(view, { kind: "agent", text: view.pendingAssistant.text });
        view.pendingAssistant = undefined;
      }
      const text = (view.pendingAssistant?.text ?? "") + event.delta;
      if (event.done) {
        pushLine(view, { kind: "agent", text });
        view.pendingAssistant = undefined;
      } else {
        view.pendingAssistant = { messageId: event.messageId, text };
      }
      break;
    }
    case "tool-call":
      pushLine(view, { kind: "tool", text: summarizeToolCallOneLine(event.toolName, event.input) });
      break;
    case "tool-result":
      if (event.isError) {
        pushLine(view, { kind: "tool-error", text: `${event.toolName} 執行失敗` });
      }
      break;
    case "permission-request": {
      const already = model.pendingPermissions.some((p) => p.sessionId === envelope.sessionId && p.requestId === event.requestId);
      if (!already) {
        model.pendingPermissions.push({
          sessionId: envelope.sessionId,
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          strong: event.strong === true,
        });
      }
      // T2 才會做逐一處理的彈窗——這裡先讓它在 transcript 裡看得見,不是啞掉
      // 沒反應(見 apps/cli/src/tui/app.tsx 對 `a` 鍵的處理,那裡是真正的
      // T2 施工縫)。
      pushLine(view, { kind: "permission", text: `等待權限:${summarizeToolCallOneLine(event.toolName, event.input)}` });
      break;
    }
    case "user-dialog-request":
      // 同 commands/chat.ts 對這個事件的既有取捨:TUI 這輪也還沒做互動回答
      // AskUserQuestion 的 UI,誠實告知、不要讓人以為卡住,比裝作沒看到好。
      pushLine(view, { kind: "system", text: "agent 提出了一個問題,TUI 尚未支援互動回答(可用 deskmony chat --session <id> 處理)" });
      break;
    case "error":
      pushLine(view, { kind: "system", text: `錯誤:${event.message}` });
      break;
    case "completed":
    case "usage":
    case "context-usage":
    case "available-commands":
    case "terminal-data":
      break;
  }
  markDirty(model);
}

/** "permission-resolved" 推播——不論是別的 client 處理掉的,還是政策引擎
 *  自動判定的(見 cli-tui_hld.md §4.1),都要從佇列移除。 */
export function applyPermissionResolved(model: TuiModel, sessionId: string, requestId: string): void {
  const before = model.pendingPermissions.length;
  model.pendingPermissions = model.pendingPermissions.filter((p) => !(p.sessionId === sessionId && p.requestId === requestId));
  if (model.pendingPermissions.length !== before) markDirty(model);
  // T2:不論這筆是被誰解決的(這個 client 自己送出的決定、別的 client 處理
  // 掉的,還是政策引擎判定的),若彈窗正開著且原本就在看這一筆,都要讓彈窗
  // 自動前進——這是「不能對已解決的請求再送決定」這條紀律的唯一實作點
  // (見檔案下方 `syncPermissionModalWithQueue()` 的完整說明),不需要在
  // a/d/A/yes/Esc 各自的處理函式裡重複判斷一次。
  syncPermissionModalWithQueue(model);
}

/**
 * 用 `session.history`(持久化訊息,見 apps/cli/src/commands/chat.ts 的
 * `replayHistory()` 既有用法)補上一個 session 在 TUI 連上**之前**就已經
 * 發生過的對話——這不是紙上猜測補的,是這輪手動驗證(用 node-pty 對著真的
 * core 跑)時實際發現的落差:`session-event` 是純直播(fire-and-forget 廣播,
 * 見 apps/core/src/gateway/ws-gateway.ts),TUI 連上之前發生的 `message-
 * delta`/`tool-call` 全部確定性遺失——一個在 TUI 開啟前就已經跑了一段對話
 * 的 session,連進來只會看到「(尚無輸出)」,而這正是這個 TUI 存在的理由
 * (§2:「同時盯著多個 agent」)最常見的情境:使用者通常是在 agent 已經跑了
 * 一陣子之後才打開 TUI 想看目前狀況,不是每次都從零看起。
 *
 * 只在這個 session 的 transcript **還是空的**時候補——避免蓋掉已經從
 * live 事件收到的內容(`session.history` 是「補開場」用的,不是每次都要
 * 重新同步的權威來源,同一個 session 只做一次,呼叫端見 tui/app.tsx 用一個
 * `Set<string>` 記錄已經補過的 session id)。system/tool 訊息比照
 * `replayHistory()` 的既有取捨不重播——一大串工具呼叫細節會蓋過真正的
 * 對話脈絡,這裡只還原使用者與 agent 之間的對話本身。
 */
export function seedHistoryIfEmpty(model: TuiModel, sessionId: string, messages: MessageRecord[]): void {
  const view = model.sessions.get(sessionId);
  if (!view || view.lines.length > 0) return;
  for (const m of messages) {
    if (m.role === "user") pushLine(view, { kind: "user", text: m.content });
    else if (m.role === "assistant") pushLine(view, { kind: "agent", text: m.content });
  }
  if (messages.length > 0) markDirty(model);
}

// ---- 成本/斷路器(輪詢,見 app.tsx)-------------------------------------------

export function setCostSnapshot(model: TuiModel, cost: CostSnapshot): void {
  model.cost = cost;
  markDirty(model);
}

// ---- 焦點/選取/捲動(§6.1)---------------------------------------------------

export function cycleFocus(model: TuiModel): void {
  model.focusedPane = model.focusedPane === "sessions" ? "transcript" : "sessions";
  markDirty(model);
}

export function getOrderedSessionViews(model: TuiModel): SessionView[] {
  return model.sessionOrder.map((id) => model.sessions.get(id)).filter((v): v is SessionView => v !== undefined);
}

export function getFocusedSessionView(model: TuiModel): SessionView | undefined {
  if (!model.selectedSessionId) return undefined;
  return model.sessions.get(model.selectedSessionId);
}

/** `↑↓` 在 Sessions 窗格切換選取(§6.1)。`delta` 為 +1/-1。 */
export function moveSessionSelection(model: TuiModel, delta: number): void {
  const order = model.sessionOrder;
  if (order.length === 0) return;
  const currentIndex = model.selectedSessionId ? order.indexOf(model.selectedSessionId) : -1;
  const nextIndex = Math.min(order.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
  const nextId = order[nextIndex];
  if (nextId !== model.selectedSessionId) {
    model.selectedSessionId = nextId;
    markDirty(model);
  }
}

/** `↑↓`/`PageUp`/`PageDown` 在 Transcript 窗格捲動(§6.1)。`delta` 正值往回
 *  捲(看較舊的內容),負值往下捲(往最新的內容靠近),0 那端貼齊底部。 */
export function scrollFocusedTranscript(model: TuiModel, delta: number): void {
  const view = getFocusedSessionView(model);
  if (!view) return;
  const maxScroll = view.lines.length;
  const next = Math.min(maxScroll, Math.max(0, view.scrollOffset + delta));
  if (next !== view.scrollOffset) {
    view.scrollOffset = next;
    markDirty(model);
  }
}

/** §3.1 collapsed 模式的 `[s] 展開` 切換。 */
export function toggleCollapsedSessionsExpanded(model: TuiModel): void {
  model.collapsedSessionsExpanded = !model.collapsedSessionsExpanded;
  markDirty(model);
}

// ---- Ctrl+C 雙擊(§6.3)------------------------------------------------------

/**
 * `now` 由呼叫端傳入(而不是這裡呼叫 `Date.now()`)——讓這個函式維持可以
 * 用假時間單元測試的「純函式」性質,呼應本檔案開頭「不需要跑起一個終端機」
 * 的目標。語意與既有 `apps/cli/src/prompt.ts` 的 `createDoubleCtrlCGuard()`
 * 完全一致(REPL 那邊的雙擊確認),這裡是同一個規則在 TUI 的資料模型裡的
 * 版本——兩處刻意沒有合併成共用模組:那邊操作的是一個獨立的計時器物件,
 * 這裡的「上次按下時間」本來就要跟其他 TUI 狀態一起活在 model 裡,合併
 * 反而要多繞一層。
 *
 * 回傳值只表達「這次按下該做什麼」,實際動作(送 `session.interrupt`、真的
 * 呼叫 `process.exit`)交給呼叫端(app.tsx)——這個檔案不知道、也不該知道
 * WebSocket client 或 process 物件的存在。
 */
export function pressCtrlC(model: TuiModel, now: number): "interrupt" | "quit" {
  if (now < model.ctrlCArmedUntil) {
    model.quitRequested = true;
    markDirty(model);
    return "quit";
  }
  model.ctrlCArmedUntil = now + CTRL_C_WINDOW_MS;
  markDirty(model); // 狀態列要顯示「再按一次離開」提示,算一次值得重繪的變化。
  return "interrupt";
}

/** `q` 鍵——不需要雙擊確認,直接視為離開意圖(HLD 沒有另外規定 `q` 要
 *  二次確認;雙擊 Ctrl+C 那套是專門為了「誤觸代價高」的訊號位元組
 *  (§1.4:Ctrl+C 在 raw mode 就是普通一個位元組)設計的,`q` 沒有那個
 *  問題,誤觸機率也低得多)。 */
export function requestQuit(model: TuiModel): void {
  model.quitRequested = true;
  markDirty(model);
}

// ---- T2:權限彈窗(design §4)-------------------------------------------------

/** 上限純粹是防呆(貼上一大段文字、或按著某個鍵不放)——比對條件只認完整
 *  的 `"yes"`,緩衝區沒有理由需要比這個長,免得畫面被撐壞。 */
const MAX_YES_INPUT_LEN = 40;

/** `a`(design §3「[a] 逐一處理」/§4.1)——只有佇列非空時才開,理由見
 *  app.tsx 對這個鍵的呼叫端註解:AlertBar 從 T1 開始就只在佇列非空時才會
 *  被畫出來,`a` 在佇列空的當下本來就沒有東西可以處理。一律從佇列第一筆
 *  開始看,不記住「上次關閉時看到第幾筆」——每次重新打開都回到最前面,
 *  才不會讓使用者猜不透這次會先看到哪一筆。 */
export function openPermissionModal(model: TuiModel): void {
  const first = model.pendingPermissions[0];
  if (!first) return;
  model.permissionModalOpen = true;
  model.permissionModalCurrent = { sessionId: first.sessionId, requestId: first.requestId };
  model.permissionYesInput = "";
  markDirty(model);
}

/** 純粹關閉彈窗,**不送出任何決定**——一般請求的 `Esc`(design §4.2
 *  「稍後再說」)專用路徑,以及佇列被清空時的收尾(見
 *  `syncPermissionModalWithQueue()`)。這一筆(若還在佇列裡)原封不動留著,
 *  之後可以再按 `a` 重新看到它。 */
export function closePermissionModal(model: TuiModel): void {
  model.permissionModalOpen = false;
  model.permissionModalCurrent = undefined;
  model.permissionYesInput = "";
  markDirty(model);
}

/** 彈窗目前應該顯示的那一筆——找不到(彈窗未開,或目前指的那筆已經不在
 *  佇列裡)一律回傳 `undefined`,呼叫端(app.tsx 的按鍵處理常式)一律先呼叫
 *  這個函式拿到最新狀態才決定要不要送 RPC,不會有機會對著一筆已經被解決
 *  的請求動作(design §4.1 的紀律⑥;完整推導見下面
 *  `syncPermissionModalWithQueue()` 的說明)。 */
export function getCurrentPermission(model: TuiModel): PendingPermission | undefined {
  if (!model.permissionModalOpen || !model.permissionModalCurrent) return undefined;
  const { sessionId, requestId } = model.permissionModalCurrent;
  return model.pendingPermissions.find((p) => p.sessionId === sessionId && p.requestId === requestId);
}

/** 目前顯示的是佇列裡第幾筆(1-based)/佇列總長度——`PermissionModal.tsx`
 *  畫「權限請求 1/2」要用到。刻意留在這個檔案而不是讓渲染層自己
 *  `findIndex`:「目前顯示哪一筆」的認定方式(身分比對,見
 *  `permissionModalCurrent` 欄位的說明)只有這裡知道,重複一份判斷邏輯到
 *  渲染層,兩邊之後改壞其中一份就會不一致。 */
export function getPermissionModalPosition(model: TuiModel): { index: number; total: number } | undefined {
  const current = getCurrentPermission(model);
  if (!current) return undefined;
  const idx = model.pendingPermissions.findIndex((p) => p.sessionId === current.sessionId && p.requestId === current.requestId);
  if (idx === -1) return undefined;
  return { index: idx + 1, total: model.pendingPermissions.length };
}

/** `n`(design §4.2「下一筆」)——**只有一般請求能用**。strong 請求的畫面
 *  刻意不提供這個選項(design §4.3 的彈窗示意圖沒有畫出 `[n]`):hard-deny
 *  命中降級來的請求風險最高,設計上要逼使用者先明確處理掉(輸入 `yes` 或
 *  `Esc`)才能繼續看別的,不能被輕易「先跳過」而在使用者沒意識到的情況下
 *  一直卡在佇列裡。佇列只剩自己一筆時也是 no-op——沒有「下一筆」可換。 */
export function advancePermissionModal(model: TuiModel): void {
  const current = getCurrentPermission(model);
  if (!current || current.strong) return;
  if (model.pendingPermissions.length <= 1) return;
  const idx = model.pendingPermissions.findIndex((p) => p.sessionId === current.sessionId && p.requestId === current.requestId);
  if (idx === -1) return;
  const next = model.pendingPermissions[(idx + 1) % model.pendingPermissions.length];
  if (!next) return;
  model.permissionModalCurrent = { sessionId: next.sessionId, requestId: next.requestId };
  model.permissionYesInput = "";
  markDirty(model);
}

/**
 * `a`/`d`/`A`(design §4.2)——**只適用一般請求**,組出要送給
 * `permission.resolve` 的參數;真正送出 RPC 是呼叫端(app.tsx)的責任,這裡
 * 只讀 model、不知道 WebSocket client 的存在(與 `pressCtrlC()` 同一種取捨,
 * 見該函式註解)。回傳 `undefined` 代表沒有東西可以處理——彈窗其實沒開、
 * 目前這筆已經不在佇列裡(見 `getCurrentPermission()`),或目前這筆其實是
 * strong(那要走 `submitPermissionYesInput()`,這裡故意不接受,避免呼叫端
 * 不小心用錯函式繞過「strong 不能單鍵確認」的規則)。
 *
 * `remember`(對應 `[A]`)只送**最窄的規則**——直接重用
 * `apps/cli/src/render.ts` 的 `buildNarrowestRememberRule()`,與桌面
 * `PermissionModal.tsx` 的預設候選、CLI 的 `prompt.ts` 完全同一份邏輯(design
 * §4.2:「[A] 只寫最窄的規則」,本檔案開頭「Reuse, do not reimplement」的
 * 紀律)。
 */
export function buildPermissionResolution(model: TuiModel, decision: "allow" | "deny", remember: boolean): PermissionResolution | undefined {
  const current = getCurrentPermission(model);
  if (!current || current.strong) return undefined;
  return {
    sessionId: current.sessionId,
    requestId: current.requestId,
    decision,
    rememberRule: remember ? buildNarrowestRememberRule(current.toolName, current.input) : undefined,
  };
}

/** strong 畫面打字輸入 `yes` 的其中一個字元(design §4.3)。**只適用 strong
 *  請求**——一般請求的畫面沒有文字輸入框,呼叫端不應該在一般請求上呼叫
 *  這個函式,這裡防禦性地擋一次。長度上限見 `MAX_YES_INPUT_LEN`。 */
export function appendPermissionYesInput(model: TuiModel, char: string): void {
  const current = getCurrentPermission(model);
  if (!current || !current.strong) return;
  if (model.permissionYesInput.length >= MAX_YES_INPUT_LEN) return;
  model.permissionYesInput += char;
  markDirty(model);
}

/** strong 畫面的 Backspace。用 `Array.from()` 而非直接 `slice(0, -1)`——理由
 *  與 `apps/cli/src/tui/keys.ts` 對 UTF-16 代理對(surrogate pair)的既有
 *  處理一致:萬一使用者手滑用輸入法打進一個佔兩個 UTF-16 code unit 的字元
 *  (中文/emoji 等),`slice(0, -1)` 只會削掉半個字元,留下一個無法顯示的
 *  孤兒 surrogate。 */
export function backspacePermissionYesInput(model: TuiModel): void {
  const current = getCurrentPermission(model);
  if (!current || !current.strong) return;
  if (model.permissionYesInput.length === 0) return;
  const chars = Array.from(model.permissionYesInput);
  chars.pop();
  model.permissionYesInput = chars.join("");
  markDirty(model);
}

/**
 * Enter(僅 strong 畫面,design §4.3)——比對輸入緩衝是否**完整等於**
 * `"yes"`(去除頭尾空白;大小寫不寬容)。符合 → allow;其餘任何輸入(含
 * 空字串,也就是直接按 Enter)→ deny。這個「非 yes 一律 deny、不重試」的
 * 規則與 `apps/cli/src/prompt.ts` 的 `askPermission()` 對 strong 請求的既有
 * 規則刻意完全一致(該函式原文:「其餘任何輸入,含直接 Enter,一律視為
 * 拒絕……打錯字太容易被誤判成使用者其實想打 yes,對這種高風險請求,預設值
 * 必須是拒絕而不是再給一次機會」)——兩個 client 對「什麼算同意」不能有
 * 不同答案。不論結果是 allow 還是 deny 都清空緩衝,同一個理由:不重試。
 *
 * 允許時**不带** `rememberRule`——design §4.3:「不提供永遠允許」;C4 紀律③
 * 本來就會在 core 端強制剝掉 strong 請求的 `rememberRule`,這裡從一開始就
 * 不生成,不是靠 core 兜底。
 */
export function submitPermissionYesInput(model: TuiModel): PermissionResolution | undefined {
  const current = getCurrentPermission(model);
  if (!current || !current.strong) return undefined;
  const typed = model.permissionYesInput.trim();
  model.permissionYesInput = "";
  markDirty(model);
  return { sessionId: current.sessionId, requestId: current.requestId, decision: typed === "yes" ? "allow" : "deny" };
}

/**
 * `Esc`(僅 strong 畫面,design §4.3「取消(維持拒絕)」)——與一般請求的
 * `Esc`(`closePermissionModal()`,純粹關閉、不送出決定)刻意不同:strong
 * 請求的存在本身就是 hard-deny 命中後的降級(見
 * apps/core/src/permissions/policy-engine.ts 的 `decide()`)——一般情況下
 * 這個工具呼叫本來就會被直接拒絕,只是因為「本機 + 有人在場 + 未開
 * autoMode」才給一次人工推翻的機會。使用者按 Esc 表示不推翻,維持的正是
 * 「原本就該發生的拒絕」,所以這裡明確送出 `deny`,不是像一般請求那樣只
 * 關窗口、把決定留給以後。
 *
 * 送出之後**不在這裡關閉彈窗**——core 處理完會廣播 `permission-resolved`
 * (`apps/core/src/gateway/ws-gateway.ts` 的 `broadcast()` 送給所有已認證
 * client,含發起請求的這個 client 自己),`applyPermissionResolved()` 收到
 * 之後呼叫的 `syncPermissionModalWithQueue()` 會讓彈窗自動前進或關閉——
 * 與「不能對已解決的請求再送決定」用同一條機制處理,不需要在這裡另外手動
 * 關窗口製造第二條路徑(那條路徑會在 RPC 還沒送達 core 之前就讓使用者以為
 * 已經處理完,而彈窗其實已經換到別的請求上)。
 */
export function escapeStrongPermission(model: TuiModel): PermissionResolution | undefined {
  const current = getCurrentPermission(model);
  if (!current || !current.strong) return undefined;
  model.permissionYesInput = "";
  markDirty(model);
  return { sessionId: current.sessionId, requestId: current.requestId, decision: "deny" };
}

/**
 * `applyPermissionResolved()` 尾端呼叫——佇列因為任何原因(這個 client 自己
 * 送出的決定、別的 client 處理掉的,或政策引擎判定的,呼叫端不需要分辨是
 * 哪一種)變動之後,檢查彈窗目前顯示的那一筆是否還在佇列裡:
 *
 *   - 還在 → 什麼都不做(可能是佇列裡別筆被解決,與目前畫面無關)。
 *   - 不在了、佇列裡還有別的 → 自動前進到佇列第一筆(design 沒有明講這種
 *     情況該顯示哪一筆,選第一筆是最不需要另外解釋的選擇——與
 *     `openPermissionModal()` 一律從第一筆開始看的邏輯一致)。
 *   - 不在了、佇列已經空了 → 直接關閉彈窗,沒有東西可以再看。
 *
 * 這是 design §4.1 紀律⑥(「不能對已解決的請求再送決定」)唯一的實作點:
 * 只要彈窗顯示的內容永遠跟著佇列真正的狀態走,`a`/`d`/`A`/yes/Esc 各自的
 * 處理函式在動作前呼叫 `getCurrentPermission()` 拿到的就必然是**尚未被
 * 解決**的請求(WS 推播與按鍵處理都在同一個 Node event loop 上跑,兩者
 * 之間不存在「資料其實已經更新但還沒被看到」的競態),不需要每個處理函式
 * 各自重新判斷一次「這筆是不是已經失效了」。
 */
function syncPermissionModalWithQueue(model: TuiModel): void {
  if (!model.permissionModalOpen) return;
  if (getCurrentPermission(model) !== undefined) return;
  const next = model.pendingPermissions[0];
  if (!next) {
    closePermissionModal(model);
    return;
  }
  model.permissionModalCurrent = { sessionId: next.sessionId, requestId: next.requestId };
  model.permissionYesInput = "";
  markDirty(model);
}

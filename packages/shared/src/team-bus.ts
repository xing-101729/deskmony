import { z } from "zod";
import { AgentSoftwareSchema } from "./agent-profile.js";
import { SessionStatusSchema } from "./session.js";
import type { MessagePriority, TeamMessage } from "./team.js";
import type { TaskStatus } from "./task.js";

/**
 * TeamBusPort:MessageBus 對外(給 team-bus MCP 工具薄層使用)的注入介面。
 *
 * 定義在 packages/shared 而不是 apps/core,是因為 packages/adapters 的
 * team-bus MCP 工具實作(packages/adapters/src/team-bus-mcp.ts)需要在
 * `ClaudeAgentSdkAdapter.spawn()` 掛載 MCP server 時拿到一個可以呼叫的
 * "bus" 物件 —— 但依賴方向規則是 packages/* 不得 import apps/*(見
 * README/ARCHITECTURE.md),所以由 apps/core 的 MessageBus 實作這個介面,
 * 建立 session 時透過 `TeamSpawnContext.bus`(packages/adapters/src/types.ts)
 * 把介面實例注入給 adapter,adapter 端只依賴這個型別,不依賴實作。
 */
export interface TeamBusSendOutcome {
  message: TeamMessage;
  /**
   * immediate  — 對方 session 目前 idle(或 interrupt 成功),已立即注入。
   * queued     — 對方 session 存在但目前 busy,已進入 Mailbox 排隊,回合結束後批次注入。
   * no-session — 對方目前沒有活躍 session,留在 Mailbox,等對方 session 建立後補投。
   * broadcast 時代表「至少一位收件者」的最佳投遞結果(有任一 immediate 就算 immediate)。
   */
  delivered: "immediate" | "queued" | "no-session";
  /** priority="interrupt" 但發送者對應的 TeamMember.canInterrupt 為 false,已自動降級為 normal。 */
  downgraded: boolean;
}

/**
 * M3 Round B:改成 zod schema(而非純 TS interface)——`list_teammates` MCP
 * 工具原本只在 core 內部使用(不需要跨進程序列化驗證),這輪新增 gateway
 * 方法 `team.teammates` 把同一份資料曝露給桌面 UI(團隊管理視圖顯示成員目前
 * session 狀態,見 packages/shared/src/gateway.ts),UI 端需要 zod 在 runtime
 * 解析/驗證回應,比照這個檔案其他型別的既有慣例(`gateway.ts` 的
 * `*ResultSchema`)。
 */
export const TeammateInfoSchema = z.object({
  memberId: z.string(),
  name: z.string(),
  role: z.string(),
  software: AgentSoftwareSchema,
  canInterrupt: z.boolean(),
  /** 是否有一個目前活躍的 session(不論 software,只要 session 存在就能被 MessageBus 注入 prompt)。 */
  hasActiveSession: z.boolean(),
  status: SessionStatusSchema.optional(),
});
export type TeammateInfo = z.infer<typeof TeammateInfoSchema>;

/**
 * M4 Round B:`request_review` MCP 工具(ARCHITECTURE.md 4.1 節列出但 M3/M4
 * Round A 都還沒實作的那個)的結果型別 —— 在 `TeamBusSendOutcome`(訊息本身
 * 的投遞結果)之外,額外附上「任務是否被同步推進 review 狀態」的資訊,讓
 * 呼叫端(MCP 工具的回應文字、e2e 斷言)能同時看到兩件事的結果。
 */
export interface RequestReviewOutcome extends TeamBusSendOutcome {
  /** 是否成功把任務同步推進 review 狀態(語意與 tryApplyReportStatus 的 updated 完全相同)。 */
  taskUpdated: boolean;
  taskFromStatus?: TaskStatus;
  taskToStatus?: TaskStatus;
  /** taskUpdated === false 時,說明原因(找不到任務/不是指派人/非法轉換等)。 */
  taskSkippedReason?: string;
}

export interface TeamBusPort {
  sendMessage(input: {
    teamId: string;
    fromMemberId: string;
    to: string;
    content: string;
    priority?: MessagePriority;
  }): Promise<TeamBusSendOutcome>;

  broadcast(input: {
    teamId: string;
    fromMemberId: string;
    content: string;
    priority?: MessagePriority;
  }): Promise<TeamBusSendOutcome>;

  listTeammates(input: { teamId: string; requestingMemberId: string }): Promise<TeammateInfo[]>;

  /**
   * 寫入一筆狀態訊息(team_messages),不觸發投遞。M4 Round A 擴充:可選帶
   * `taskId` —— 若提供,且發送者(`fromMemberId`)確實是該任務的指派人,
   * 實作端(apps/core 的 MessageBus,委派給 TaskService)會嘗試把 `status`
   * 這個自由文字對映到 `TaskStatus`,對映成功且是合法的狀態轉換才會同步更新
   * 任務狀態;對映失敗或轉換不合法,只記錄這則訊息,不改任務狀態、不拋錯誤
   * (report_status 語意上是「盡力而為的狀態同步」,不應該因為任務狀態機的
   * 限制而讓這個工具呼叫本身失敗)。不帶 `taskId` 時行為與 M3 完全相同。
   */
  reportStatus(input: {
    teamId: string;
    fromMemberId: string;
    status: string;
    summary?: string;
    taskId?: string;
  }): Promise<TeamMessage>;

  /**
   * M4 Round B:`request_review` —— ARCHITECTURE.md 4.1 節列出、4.4/5.1 節備註
   * 明講「這輪先不做」的那個工具,這輪補上。語意上等同
   * `report_status(status: "review", taskId)` + `send_message(to: <reviewer>, "請審查...")`
   * 的組合,但意圖明確:呼叫端不需要自己組出審查請求的措辭,也不需要分別呼叫
   * 兩個工具。若帶 `taskId` 且發送者是該任務的指派人,會嘗試把任務推進 review
   * 狀態(規則與 `reportStatus` 完全相同 —— 對映不到/不是指派人/非法轉換都不
   * 報錯,只記錄原因,見 `taskUpdated`/`taskSkippedReason`);不帶 `taskId` 時
   * 純粹送出一則審查請求通知。`to` 為必填 —— 與 `reportStatus`(對象固定是
   * broadcast)不同,`request_review` 語意上一定要有一個明確的審查者。
   */
  requestReview(input: {
    teamId: string;
    fromMemberId: string;
    to: string;
    taskId?: string;
  }): Promise<RequestReviewOutcome>;
}

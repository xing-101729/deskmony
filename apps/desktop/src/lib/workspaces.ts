import type { Session } from "@deskmony/shared";

/**
 * 「工作區(Workspace)」——**純前端的分組視角**,不是新的資料結構。
 *
 * 重要:core 端已經有一個叫 `Workspace` 的概念(任務用的 git worktree,見
 * apps/core/src/workspace/),那是**後端資料模型**;這裡說的工作區是**側欄的
 * 資訊架構**:把 session 依 `session.workingDir`(既有欄位)分組,讓「同一個
 * 專案底下的對話」聚在一起。
 *
 * 為什麼要這樣做:改版前側欄是一條扁平的 session 清單,同時開三個專案(這正是
 * power user 的常態)時,清單裡的「對話 4」「對話 7」完全看不出屬於哪個 repo,
 * 只能點進去看標頭的路徑。分組之後,「我現在在哪個專案」在側欄一眼可見,而且
 * 可以只看目前這個工作區(切換 = 過濾),這就是多工作區體驗。
 *
 * 完全不動任何 API / 資料結構:所有資訊都是從既有的 `Session.workingDir` 推導
 * 出來的。
 */

export interface WorkspaceGroup {
  /** 分組鍵(正規化後的路徑;Windows 不分大小寫) */
  key: string;
  /** 顯示名稱(路徑最後一段,通常就是 repo 目錄名) */
  name: string;
  /** 原始完整路徑(第一個遇到的 session 的 workingDir,用於 tooltip) */
  path: string;
  sessions: Session[];
  /** 這個工作區裡最近一次活動時間(排序用) */
  lastActivity: number;
  /** 有幾條 session 正在忙(busy/waiting)——工作區層級的「還在動」指示 */
  activeCount: number;
  /** 有幾條 session 在等待授權——需要人介入的優先訊號 */
  waitingCount: number;
  /** 有幾條 session 是錯誤狀態 */
  errorCount: number;
}

/** 正規化路徑:統一分隔符、去掉尾端斜線;Windows 路徑大小寫不敏感,一律轉小寫
 *  當比較鍵(顯示時仍用原始字串)。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 取路徑最後一段當工作區名稱;根目錄(例如 `D:/`)則保留原樣。
 *  i18n 專案新增:「(未指定目錄)」的翻譯結果改由呼叫端(SessionList.tsx,
 *  唯一呼叫點)透過 `unnamedLabel` 傳入——這個檔案維持不 import i18next,
 *  純函式不依賴 React context,呼叫端自己用 useTranslation() 的 t() 產生
 *  字串再傳進來(比照 lib/error-i18n.ts 的 translateError() 慣例)。 */
export function workspaceName(path: string, unnamedLabel: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segment = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  return segment || cleaned || unnamedLabel;
}

/**
 * 路徑縮寫:保留頭尾、中間用 `…` 省略。標頭與 tooltip 都需要顯示完整路徑的
 * 「可辨識版本」,但 `D:\some\deep\nested\project\path` 直接塞進 11px 的標頭
 * 會把標題擠掉——尾段(最有辨識度)一定保留。
 */
export function shortenPath(path: string, maxSegments = 3): string {
  const cleaned = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return segments.join("/");
  return `…/${segments.slice(-maxSegments).join("/")}`;
}

export function groupSessionsByWorkspace(sessions: Session[], unnamedLabel: string): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();

  for (const session of sessions) {
    const path = session.workingDir ?? "";
    const key = normalizePath(path);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: workspaceName(path, unnamedLabel),
        path,
        sessions: [],
        lastActivity: 0,
        activeCount: 0,
        waitingCount: 0,
        errorCount: 0,
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.lastActivity = Math.max(group.lastActivity, session.updatedAt ?? 0);
    if (session.status === "busy" || session.status === "waiting") group.activeCount += 1;
    if (session.status === "waiting") group.waitingCount += 1;
    if (session.status === "error") group.errorCount += 1;
  }

  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  // 需要人介入的(等待授權)排最前面,其餘依最近活動排序——power user 一打開
  // 就該看到「哪個專案在等我」。
  return [...groups.values()].sort((a, b) => {
    if ((b.waitingCount > 0 ? 1 : 0) !== (a.waitingCount > 0 ? 1 : 0)) {
      return (b.waitingCount > 0 ? 1 : 0) - (a.waitingCount > 0 ? 1 : 0);
    }
    return b.lastActivity - a.lastActivity;
  });
}

import { useEffect, useRef } from "react";
import type { Session } from "@deskmony/shared";

/**
 * Changes / Files 分頁的自動重新整理(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.2):
 *  - 分頁**變成可見**(掛上、或 `visible` 從 false 變 true)時重新整理一次;
 *  - 目前 session 從 `busy` 變回 `idle`(agent 剛做完一輪,檔案多半變了)時重新整理。
 * `refresh` 用 ref 保存最新版本,呼叫端不必為了它穩定而 `useCallback`。
 */
export function useAutoRefresh(session: Session, visible: boolean, refresh: () => void): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (visible) refreshRef.current();
  }, [visible]);

  const previousStatus = useRef(session.status);
  useEffect(() => {
    if (previousStatus.current === "busy" && session.status === "idle" && visible) refreshRef.current();
    previousStatus.current = session.status;
  }, [session.status, visible]);
}

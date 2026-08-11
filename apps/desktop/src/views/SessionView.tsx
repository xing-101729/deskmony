import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { ChatView } from "./ChatView.js";
import { TerminalView } from "./TerminalView.js";

/**
 * SessionView — 依目前選取 session 對應 adapter 的 capabilities 決定要渲染
 * ChatView(結構化聊天串流)還是 TerminalView(xterm 終端直通),對應
 * ARCHITECTURE.md 3.4 節「能力探測(capabilities)+ 優雅降級」與 3.1 節
 * 「Session 視圖」。
 *
 * 判斷依據:`Session.adapterType`(即建立 session 時的 `AgentProfile.software`)
 * → 查 `capabilitiesBySoftware` 快取(`refreshProfiles`/`createSession`/
 * `createProfile` 都會主動預先查詢並快取,見 stores/session-store.ts)。快取
 * 還沒到位時(理論上只會發生在極短暫的初次連線瞬間)預設先渲染 ChatView,
 * 不阻塞畫面 —— 對聊天類 adapter(絕大多數情況)這本來就是正確答案,對 pty
 * session 則會在 capabilities 抵達後的下一次渲染自動切換過去。
 */
export function SessionView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const capabilitiesBySoftware = useSessionStore((s) => s.capabilitiesBySoftware);
  const fetchCapabilities = useSessionStore((s) => s.fetchCapabilities);

  const session = sessions.find((s) => s.id === currentSessionId);
  const capabilities = session ? capabilitiesBySoftware[session.adapterType] : undefined;

  useEffect(() => {
    if (session && !capabilities) {
      void fetchCapabilities(session.adapterType);
    }
  }, [session, capabilities, fetchCapabilities]);

  if (capabilities?.terminal) {
    return <TerminalView onOpenSidebar={onOpenSidebar} />;
  }
  return <ChatView onOpenSidebar={onOpenSidebar} />;
}

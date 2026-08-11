import { useEffect, useRef, useState } from "react";
import { GatewayAuthError, GatewayNetworkError, probeGatewayConnection } from "../lib/gateway-client.js";
import { defaultGatewayUrl, loadSavedConnection, saveConnection } from "../lib/connection-config.js";
import { Button } from "../ui/Button.js";
import { Field, Input } from "../ui/Field.js";
import { Alert } from "../ui/Feedback.js";
import { Icon } from "../ui/icons.js";

interface ConnectScreenProps {
  onConnected: (url: string, token: string) => void;
}

type Status = "idle" | "connecting" | "error";
type ErrorKind = "auth" | "network";

/**
 * M5 Round B(任務2):瀏覽器連線畫面——`window.deskmony` 不存在時顯示,取代
 * Electron 場景下由 preload 自動提供的 gatewayUrl/authToken。行為與資料流
 * 完全不變,這輪只換了視覺外殼(對齊登入類畫面的「置中卡片」慣例,並補上
 * 產品識別)。
 */
export function ConnectScreen({ onConnected }: ConnectScreenProps): JSX.Element {
  const [url, setUrl] = useState<string>(() => loadSavedConnection()?.url ?? defaultGatewayUrl());
  const [token, setToken] = useState<string>(() => loadSavedConnection()?.token ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const triedAutoConnect = useRef(false);

  const attempt = async (attemptUrl: string, attemptToken: string): Promise<void> => {
    const trimmedUrl = attemptUrl.trim();
    if (!trimmedUrl) {
      setStatus("error");
      setErrorKind("network");
      setErrorMessage("請輸入伺服器位址");
      return;
    }
    setStatus("connecting");
    setErrorKind(null);
    setErrorMessage("");
    try {
      await probeGatewayConnection(trimmedUrl, attemptToken);
      saveConnection(trimmedUrl, attemptToken);
      onConnected(trimmedUrl, attemptToken);
    } catch (err) {
      setStatus("error");
      if (err instanceof GatewayAuthError) {
        setErrorKind("auth");
        setErrorMessage("認證失敗:token 不正確,請確認後重試。");
      } else if (err instanceof GatewayNetworkError) {
        setErrorKind("network");
        setErrorMessage(err.message);
      } else {
        setErrorKind("network");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    if (triedAutoConnect.current) return;
    triedAutoConnect.current = true;
    const saved = loadSavedConnection();
    if (saved) void attempt(saved.url, saved.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connecting = status === "connecting";

  return (
    <div className="flex h-full min-h-[100dvh] w-full items-center justify-center bg-canvas p-4 text-fg">
      <div className="w-full max-w-sm rounded-xl bg-panel p-6 shadow-overlay">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Icon name="sparkle" size={16} />
          </span>
          <div>
            <h1 className="text-md font-semibold tracking-tight text-fg">連線到 Deskmony Core</h1>
            <p className="text-2xs text-fg-faint">Agent Team 管理平台</p>
          </div>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-fg-muted">
          在瀏覽器中使用 Deskmony 需要先連線到一個正在執行的 Deskmony Core 伺服器。
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(url, token);
          }}
          className="space-y-3"
        >
          <Field label="伺服器位址">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://localhost:4317" autoComplete="off" spellCheck={false} fieldSize="md" mono />
          </Field>
          <Field label="認證 Token(伺服器未啟用認證則留空)">
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder="token" fieldSize="md" />
          </Field>

          {status === "error" && <Alert tone={errorKind === "auth" ? "danger" : "warn"}>{errorMessage}</Alert>}

          <Button type="submit" variant="primary" size="md" block loading={connecting}>
            {connecting ? "連線中…" : "連線"}
          </Button>
        </form>

        <p className="mt-4 text-2xs leading-relaxed text-fg-faint">
          Token 僅保存在本分頁的 sessionStorage,關閉分頁即自動清除,不會寫入網址列或瀏覽器紀錄。
          若在共用電腦上使用,請在結束後於主介面按「登出」或直接關閉此分頁。
        </p>
      </div>
    </div>
  );
}

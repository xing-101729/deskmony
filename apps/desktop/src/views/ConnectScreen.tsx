import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GatewayAuthError, GatewayNetworkError, probeGatewayConnection } from "../lib/gateway-client.js";
import { defaultGatewayUrl, loadSavedConnection, saveConnection } from "../lib/connection-config.js";
import { translateError } from "../lib/error-i18n.js";
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
  const { t } = useTranslation(["connect", "common"]);
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
      setErrorMessage(t("connect:urlRequired"));
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
      // i18n 專案新增:三個分支的訊息一律改用 translateError()(見
      // lib/error-i18n.ts)——GatewayAuthError/GatewayNetworkError 都
      // extends DeskmonyError,translateError 會依 err.code 查
      // errors:<code> 翻譯,查不到時退回 err.message。instanceof 分支
      // 本身維持原樣,只是用來決定 errorKind(影響 Alert 的 tone)。
      if (err instanceof GatewayAuthError) {
        setErrorKind("auth");
        setErrorMessage(translateError(err, t));
      } else if (err instanceof GatewayNetworkError) {
        setErrorKind("network");
        setErrorMessage(translateError(err, t));
      } else {
        setErrorKind("network");
        setErrorMessage(translateError(err, t));
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
      <div className="w-full max-w-sm rounded-xl bg-panel p-7 shadow-overlay">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Icon name="sparkle" size={16} />
          </span>
          <div>
            <h1 className="text-md font-semibold tracking-tight text-fg">{t("connect:heading")}</h1>
            <p className="text-2xs text-fg-faint">{t("connect:tagline")}</p>
          </div>
        </div>
        <p className="mb-5 text-xs leading-relaxed text-fg-muted">{t("connect:description")}</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(url, token);
          }}
          className="space-y-4"
        >
          <Field label={t("connect:serverUrlLabel")}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://localhost:4317" autoComplete="off" spellCheck={false} fieldSize="md" mono />
          </Field>
          <Field label={t("connect:tokenLabel")}>
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder="token" fieldSize="md" />
          </Field>

          {status === "error" && <Alert tone={errorKind === "auth" ? "danger" : "warn"}>{errorMessage}</Alert>}

          <Button type="submit" variant="primary" size="md" block loading={connecting}>
            {connecting ? t("connect:connecting") : t("connect:connect")}
          </Button>
        </form>

        <p className="mt-5 text-2xs leading-relaxed text-fg-faint">{t("connect:tokenStorageNote")}</p>
      </div>
    </div>
  );
}

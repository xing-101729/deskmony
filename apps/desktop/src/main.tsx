import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { initI18n } from "./i18n.js";
import { initLocale } from "./ui/locale.js";
import { initTheme } from "./ui/theme.js";
import "./index.css";

// 三個 init 都必須在任何元件呼叫 useTranslation() 之前執行(也就是
// ReactDOM render 之前)——initI18n() 把翻譯資源灌進 i18next 單例,
// initLocale() 比照 initTheme() 的既有慣例,在第一帧渲染前把 <html lang>
// 套上,避免語言/主題在掛載後才「跳」一次。
initI18n();
initLocale();
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // 2026-09-04(稽核修補):最外層的最後防線。各主要視圖另外有自己的
  // ErrorBoundary(見 App.tsx)—— 只包最外層等於只是把白畫面換成錯誤畫面,
  // 真正有價值的隔離在內層。
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

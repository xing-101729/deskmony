import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
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
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

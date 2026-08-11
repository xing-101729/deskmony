import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { initTheme } from "./ui/theme.js";
import "./index.css";

// 在 React 掛載前先把主題套上(讀 localStorage,寫入 <html data-theme>),
// 避免第一帧用預設深色渲染、下一帧才跳成使用者實際偏好的淺色。
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

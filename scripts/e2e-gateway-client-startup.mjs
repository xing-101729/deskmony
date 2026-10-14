#!/usr/bin/env node
/**
 * scripts/e2e-gateway-client-startup.mjs
 *
 * 2026-10-14:`GatewayClient` 首次連線失敗後的補載回歸測試。
 *
 * 桌面殼 `app.whenReady()` 裡 `startCore()` 與 `createWindow()` 同時進行,
 * renderer 第一次連 WS 時 core 常常還沒開始監聽 port。`session-store` 的
 * `connect()` 在 `client.connect()` 後同步排隊的初始載入(session.list、
 * env.detectAgents …)會隨這條失敗的連線被 reject;過去重連成功時因為
 * 「從沒成功連過」而不觸發 `onReconnected`,UI 便一直沒有歷史 session、
 * 也沒有 agent 偵測結果,直到使用者建立新對話觸發推播才出現。
 *
 * 這支用假的 WebSocket factory 驗三件事:
 *   1. 第一次嘗試失敗 → 排隊的呼叫被 reject → 重連成功時觸發 `onReconnected`
 *   2. 第一次嘗試就成功 → 不觸發(初始載入本來就送出去了)
 *   3. 成功過之後斷線再連上 → 觸發(原本的行為不變)
 *
 * 不啟動 core,約 4 秒(兩次 2 秒的重連計時)。
 * 用法:node scripts/e2e-gateway-client-startup.mjs
 * 前置需求:pnpm build 已跑過
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const { GatewayClient } = await import(pathToFileURL(path.resolve("packages/client/dist/index.js")).href);

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

/**
 * 依序產生假連線:`plan[i]` 為 "fail" 時該次連線只觸發 close(模擬 core 尚未
 * 監聽),"ok" 時觸發 open,並對每個 request 回一個成功 response。
 */
function makeFactory(plan) {
  const sockets = [];
  const factory = () => {
    const outcome = plan[sockets.length] ?? "ok";
    const listeners = { open: [], close: [], error: [], message: [] };
    const ws = {
      readyState: 0,
      send(data) {
        const { id, method } = JSON.parse(data);
        setTimeout(() => {
          for (const l of listeners.message) l({ data: JSON.stringify({ kind: "response", id, ok: true, result: { method } }) });
        }, 0);
      },
      close() {
        setTimeout(() => {
          for (const l of listeners.close) l({});
        }, 0);
      },
      addEventListener(type, l) {
        listeners[type].push(l);
      },
      removeEventListener(type, l) {
        listeners[type] = listeners[type].filter((x) => x !== l);
      },
    };
    sockets.push(ws);
    setTimeout(() => {
      if (outcome === "fail") for (const l of listeners.close) l({});
      else for (const l of listeners.open) l({});
    }, 10);
    return ws;
  };
  return { factory, sockets };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("[1] 第一次嘗試失敗後才連上");
{
  const { factory, sockets } = makeFactory(["fail", "ok"]);
  const client = new GatewayClient("ws://fake", undefined, factory);
  let reconnected = 0;
  client.onReconnected(() => reconnected++);
  client.connect();
  const initial = await client.call("session.list", {}).then(
    () => "resolved",
    () => "rejected",
  );
  check(initial === "rejected", "啟動時排隊的初始呼叫隨失敗連線被 reject");
  await wait(2200);
  check(sockets.length === 2, "2 秒後自動重連");
  check(reconnected === 1, "重連成功時觸發 onReconnected(呼叫端得以補載)");
  const after = await client.call("session.list", {});
  check(after?.method === "session.list", "重連後呼叫正常往返");
  client.disconnect();
}

console.log("[2] 第一次嘗試就成功");
{
  const { factory } = makeFactory(["ok"]);
  const client = new GatewayClient("ws://fake", undefined, factory);
  let reconnected = 0;
  client.onReconnected(() => reconnected++);
  client.connect();
  const initial = await client.call("session.list", {});
  check(initial?.method === "session.list", "排隊的初始呼叫在連上後送出");
  check(reconnected === 0, "不觸發 onReconnected");

  console.log("[3] 成功過之後斷線再連上");
  client.ws.close();
  await wait(2200);
  check(reconnected === 1, "觸發 onReconnected");
  client.disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} 項失敗`);
  process.exit(1);
}
console.log("\n全部通過");

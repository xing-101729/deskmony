/**
 * 這個檔案現在只是 re-export——實作已搬到 packages/client(`@deskmony/client`),
 * 見 docs/LAYER-3-hld/cli_hld.md §4.1:CLI 即將成為 core gateway 的第三種
 * client,協定實作只能有一份,不能桌面殼跟 CLI 各自長出一份會漂移的版本。
 * 保留這個檔案、不直接把 import site 改指到 `@deskmony/client`,是刻意讓
 * session-store.ts/ConnectScreen.tsx 這兩個 import path 維持穩定(另一個
 * session 正在動 apps/desktop 底下的程式碼,不屬於這次拆分的變更範圍)。
 */
export { GatewayClient, GatewayAuthError, GatewayNetworkError, probeGatewayConnection } from "@deskmony/client";

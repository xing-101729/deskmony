import { promises as fsp } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * apps/core 靜態網頁 server(M5 Round B 任務1,ARCHITECTURE.md 3.2 節「同一套
 * WS API 未來可直接開放給瀏覽器/手機遠端」)——把 apps/desktop 既有的 Vite
 * build 產物(dist/)透過與 WS Gateway 相同的 port 服務出去,讓瀏覽器不需要
 * 另外架設任何東西就能載入 UI 殼。
 *
 * **安全邊界(務必先讀 README「瀏覽器存取方式與安全界線」章節)**:
 *   - 靜態網頁本身「不需要認證即可下載」——它只是前端 UI 殼(HTML/JS/CSS),
 *     不含任何機敏資料;真正的存取控制在 WS 層(見 ws-gateway.ts 的
 *     timingSafeTokenEqual/認證閘門)。這個檔案完全不知道、也不檢查
 *     DESKMONY_AUTH_TOKEN——刻意如此,職責單一(只負責「這個路徑對應到哪個
 *     檔案、能不能讀」)。
 *   - **絕不能成為讀取任意檔案的管道**:所有路徑解析都必須確保「解析後的
 *     絕對路徑仍在 distDir 之內」,見下方 resolveStaticFile() 的三層防禦。
 *
 * ## 目錄穿越三層防禦(resolveStaticFile)
 *
 * 1. **拒絕反斜線與 NUL 位元組**:URL 路徑的虛擬命名空間只使用正斜線
 *    (`/`)——decode 後若含有 `\` 或 `\0`,直接拒絕,不嘗試解析。這是刻意
 *    的:Windows 上 `path.resolve()`/`path.win32` 系列函式會把反斜線當成
 *    路徑分隔符處理,若允許反斜線混入,`path.posix.normalize()` 的正規化
 *    (見下一步)不會把它當成目錄邊界處理,等於繞過了正規化這一步,是常見的
 *    混合分隔符目錄穿越手法。
 * 2. **在「虛擬絕對根目錄」下正規化**:decode 後的路徑一律當作以 `/` 開頭的
 *    虛擬絕對路徑丟給 `path.posix.normalize()`——因為路徑是絕對的(有前導
 *    `/`),多餘的 `..`(例如 `/../../package.json`)會被正規化收斂成
 *    「無法超出虛擬根目錄」的結果(等同 `/package.json`),不會產生任何
 *    仍含 `..` 區段的輸出。正規化後若仍然找得到單獨一個 `..` 區段
 *    (理論上不該發生,這裡是多一層防呆),一樣直接拒絕。
 * 3. **最終防線:解析後的絕對路徑必須仍在 distDir 之內**——即使前兩步的邏輯
 *    有任何沒設想到的漏洞,`path.resolve(distDir, relative)` 算出的絕對
 *    路徑若不是以 `distDir + path.sep` 開頭(且不等於 distDir 本身),一律
 *    視為拒絕,絕不讀取。這一步不依賴前兩步是否正確,是唯一真正決定「能不能
 *    真的去讀這個檔案」的判斷。
 *
 * 只有副檔名落在白名單(`STATIC_CONTENT_TYPES`)內的請求才會嘗試真的去讀檔案
 * ——其餘一律視為 SPA 前端路由(例如使用者重新整理某個前端內部路徑),回傳
 * `index.html` 內容(SPA fallback),但**這個 fallback 完全不觸碰檔案系統
 * 裡對應這個路徑的檔案**(只固定讀 `distDir/index.html`),因此就算白名單/
 * 正規化邏輯被繞過,「未知副檔名的路徑」這條分支本身也不構成任何洩漏管道。
 */

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

type ResolveResult =
  | { status: "file"; filePath: string; contentType: string }
  | { status: "index" }
  | { status: "reject" };

/** 見檔案頂端註解「目錄穿越三層防禦」。 */
function resolveStaticFile(distDir: string, rawUrlPath: string): ResolveResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrlPath);
  } catch {
    return { status: "reject" }; // 無法 decode(格式錯誤的 %xx 序列)一律拒絕
  }

  // 防禦第 1 層:反斜線 / NUL 位元組。
  if (decoded.includes("\\") || decoded.includes("\0")) {
    return { status: "reject" };
  }

  // 防禦第 2 層:在虛擬絕對根目錄下正規化,多餘的 ".." 會被收斂。
  const virtualAbsolute = decoded.startsWith("/") ? decoded : `/${decoded}`;
  const normalized = path.posix.normalize(virtualAbsolute);
  if (normalized.split("/").includes("..")) {
    return { status: "reject" };
  }

  const relative = normalized.replace(/^\/+/, "");
  if (relative === "") return { status: "index" };

  const ext = path.extname(relative).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[ext];
  if (!contentType) {
    // 未知副檔名(或無副檔名,例如前端路由):SPA fallback,不觸碰檔案系統
    // 裡對應這個路徑的任何檔案。
    return { status: "index" };
  }

  // 防禦第 3 層(最終防線):解析後的絕對路徑必須仍在 distDir 之內。
  const rootResolved = path.resolve(distDir);
  const filePath = path.resolve(distDir, relative);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    return { status: "reject" };
  }

  return { status: "file", filePath, contentType };
}

async function sendIndex(distDir: string, res: ServerResponse): Promise<void> {
  try {
    const data = await fsp.readFile(path.join(distDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "找不到 index.html —— apps/desktop 尚未 build,或 DESKMONY_STATIC_DIR 指向錯誤的目錄。" +
        "請先執行 pnpm build。",
    );
  }
}

/**
 * 建立提供 apps/desktop Vite build 產物(distDir)的 HTTP request handler,
 * 直接交給 `node:http` 的 `createServer()` 用。與 WsGateway 共用同一個
 * `http.Server` 實例(見 ws-gateway.ts 的 `listen()`)——WS 升級請求走
 * `upgrade` 事件,不會進到這裡;這裡只處理一般 HTTP GET 請求。
 */
export function createStaticRequestHandler(
  distDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(distDir, req, res);
  };
}

async function handleRequest(distDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET" });
    res.end("Method Not Allowed");
    return;
  }

  const rawUrl = req.url ?? "/";
  const questionMarkIdx = rawUrl.indexOf("?");
  const pathname = questionMarkIdx === -1 ? rawUrl : rawUrl.slice(0, questionMarkIdx);

  const resolved = resolveStaticFile(distDir, pathname);

  if (resolved.status === "reject") {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  if (resolved.status === "index") {
    await sendIndex(distDir, res);
    return;
  }

  try {
    const data = await fsp.readFile(resolved.filePath);
    res.writeHead(200, { "content-type": resolved.contentType, "content-length": data.length });
    res.end(data);
  } catch {
    // 白名單副檔名但實際讀不到(例如檔案不存在)—— 退回 SPA fallback,而不是
    // 500,與「找不到的路徑回傳 index.html」的既有規則一致。
    await sendIndex(distDir, res);
  }
}

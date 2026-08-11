/**
 * M5 Round B(任務2):瀏覽器連線資訊(伺服器位址 + token)的儲存與預設值。
 *
 * **token 儲存取捨(務必先讀 README「token 儲存取捨」章節的完整說明)**:
 * 存在 `sessionStorage`(分頁關閉即清除),刻意不用 `localStorage`:
 *   - `localStorage` 沒有到期機制,token 會一直留在瀏覽器裡,直到使用者
 *     手動清除瀏覽器資料——在共用電腦上,前一個使用者的 token 會一直有效,
 *     下一個使用這台電腦的人只要打開同一個網址就能直接操控 agent 與檔案
 *     系統,是明顯的風險。`sessionStorage` 綁定「分頁」的生命週期,關閉分頁
 *     (不是整個瀏覽器,是那個分頁)就清除,大幅縮小暴露視窗。
 *   - 更不放進 URL query string:同樣的理由(見 README「認證(token-based)」
 *     章節對桌面殼/WS 傳輸層的既有討論)——URL 容易被瀏覽器歷史紀錄、
 *     反向代理 access log、螢幕分享時的網址列意外外洩。
 *   - 不寫進任何 `console.log`——這裡的每個函式都刻意不印出 token 值本身。
 *
 * 在共用電腦上使用時,務必在使用完畢後按下主介面的「登出」(清除
 * sessionStorage 並回到連線畫面)或直接關閉分頁——只闔上瀏覽器視窗但分頁
 * 仍在背景存活(例如瀏覽器有「還原分頁」功能)不保證會清除 sessionStorage。
 */

const STORAGE_KEY_URL = "deskmony:gatewayUrl";
const STORAGE_KEY_TOKEN = "deskmony:authToken";

export interface SavedConnection {
  url: string;
  token: string;
}

function getSessionStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : undefined;
  } catch {
    // 某些瀏覽器隱私模式下存取 sessionStorage 可能直接丟例外
    return undefined;
  }
}

/** 讀取上次成功連線時儲存的位址/token;沒有(或無法存取 sessionStorage)時回傳 null。 */
export function loadSavedConnection(): SavedConnection | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const url = storage.getItem(STORAGE_KEY_URL);
    if (!url) return null;
    const token = storage.getItem(STORAGE_KEY_TOKEN) ?? "";
    return { url, token };
  } catch {
    return null;
  }
}

/** 連線驗證成功後呼叫,把這組位址/token 存進 sessionStorage,下次同分頁重整可以自動帶入。 */
export function saveConnection(url: string, token: string): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY_URL, url);
    storage.setItem(STORAGE_KEY_TOKEN, token);
  } catch {
    // sessionStorage 寫入失敗(例如容量限制)不影響當下這次連線是否成功,
    // 靜默忽略即可——最多下次重新整理需要重新輸入。
  }
}

/** 「登出」動作:清除已儲存的連線資訊(見 App.tsx 的登出按鈕)。 */
export function clearSavedConnection(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_URL);
    storage.removeItem(STORAGE_KEY_TOKEN);
  } catch {
    // ignore
  }
}

/**
 * 連線畫面預設帶入的伺服器位址:同源 `ws://<location.host>`(或 https 頁面
 * 時對應的 `wss://`)——這是 M5 Round B 任務1(Core 提供靜態網頁)成立後的
 * 典型情境:瀏覽器本來就是從 Core 的 HTTP server 載入這個頁面,WS Gateway
 * 監聽的是同一個 host:port,同源預設能讓大多數使用者不需要手動輸入位址。
 */
export function defaultGatewayUrl(): string {
  if (typeof window === "undefined" || !window.location?.host) return "ws://localhost:4317";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

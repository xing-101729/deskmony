import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, readStoredLocale } from "./lib/locale-storage.js";

/**
 * 用 import.meta.glob 而不是手動一個個 import 每個 namespace 檔——這樣新增
 * namespace 檔案(不同批次各自新增自己負責的 locales/{locale}/xxx.json)完全
 * 不需要回來編輯這個檔案,消除多個批次同時修改同一支載入器程式碼的合併衝突。
 *
 * errors-*.json 是例外:同一個 locale 下會有多個 errors-<area>.json(每個
 * 負責轉換不同 backend 檔案的批次各自擁有一個),這裡把它們深度合併(見下方
 * `deepMergeErrors()`)進單一個 "errors" namespace,前端一律用 t("errors:<code>")
 * 查,不需要知道 code 實際落在哪個實體檔案裡。
 *
 * **為什麼是深度合併、不是 shallow spread**:`ErrorCodes`(packages/shared/src/
 * errors.ts)刻意設計成跨檔案共用同一個 dot-path 第一段(例如 "task.invalidTransition"
 * 落在 errors-common.json,另一個批次的 errors-tasks.json 又在同一個 "task"
 * 底下新增 "task.workingDirMissing" 之類的專屬 code)——若用 shallow spread
 * (`{...a, ...b}`),後載入的檔案會把同名的第一層 key(例如整個 "task" 物件)
 * 整個蓋掉,悄悄砍掉另一個檔案已經定義的葉節點翻譯而不報錯。遞迴合併只在真的
 * 撞到同一個「完整 leaf path」(值是字串)時才用後者覆蓋前者——理論上不應該
 * 發生,各批次的 code 不重複定義同一個 leaf。
 */
const modules = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" }) as Record<
  string,
  Record<string, unknown>
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeErrors(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMergeErrors(existing, value) : value;
  }
  return result;
}

function buildResources(): Record<string, Record<string, unknown>> {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const [path, content] of Object.entries(modules)) {
    const parts = path.split("/");
    const locale = parts[2];
    const fileBase = parts[3].replace(/\.json$/, "");
    resources[locale] ??= {};
    if (fileBase.startsWith("errors-")) {
      resources[locale].errors = deepMergeErrors((resources[locale].errors as Record<string, unknown>) ?? {}, content);
    } else {
      resources[locale][fileBase] = content;
    }
  }
  return resources;
}

const resources = buildResources();

/** main.tsx 在 ReactDOM render 前呼叫,比照 ui/theme.ts 的 initTheme() 慣例。 */
export function initI18n(): void {
  void i18next.use(initReactI18next).init({
    // i18next 的 `Resource` 型別要求葉節點是 `ResourceKey`(`string | { [key: string]:
    // any }`),但 import.meta.glob 讀進來的 JSON 內容在型別上只能標成 `unknown`
    // (執行期一定是純資料物件,型別系統無法從 glob pattern 靜態得知)——這裡用
    // 一次性的 cast 銜接兩者,不影響 `buildResources()` 內部處理邏輯。
    resources: resources as Resource,
    lng: readStoredLocale(),
    fallbackLng: DEFAULT_LOCALE,
    ns: Object.keys(resources[DEFAULT_LOCALE] ?? {}),
    defaultNS: "common",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18next;

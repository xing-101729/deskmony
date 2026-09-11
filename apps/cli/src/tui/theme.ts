import type { SessionStatus } from "@deskmony/shared";
import type { BoxProps } from "ink";

/**
 * 圖示與框線樣式的唯一來源。§1.3 的紀律:「TUI 的結構性元素一律不用
 * emoji」——這裡列的每一個符號都出自 docs/LAYER-3-hld/cli-tui_hld.md §1.2
 * 的實測表格(DSR 量過帳面寬度都是 1 欄),沒有一個是憑印象加的。
 *
 * 這個檔案會 import `ink`(型別而已,`BoxProps`),因此**只能被 tui/ 目錄
 * 底下的檔案 import**——不可以被 model.ts/keys.ts 引用(那兩個檔案的
 * 「不 import ink」是精確到型別 import 都不行,理由是要讓它們可以在完全
 * 沒裝 ink 的情況下也能被單獨編譯/測試;theme.ts 本來就只服務渲染層,沒有
 * 這個限制)。
 */

// ---- 框線樣式 ---------------------------------------------------------------

/**
 * §1.2.1:「只有細框線(┌─┐│└┘)經過目視確認,粗框線/圓角只有帳面寬度,
 * 沒有目視確認過缺字問題」。整個 TUI 的邊框樣式收斂到這一個常數——之後
 * (T2 的權限彈窗、或補完 §10.2 的目視確認之後想換圓角)只需要改這裡,
 * 不必到每個 pane 元件裡各自找 `borderStyle="single"` 改成別的。
 */
export const BORDER_STYLE: NonNullable<BoxProps["borderStyle"]> = "single";

/**
 * T2(design §4.3):escalate-strong 權限請求的彈窗要「明顯不同,且不只靠
 * 顏色」——圓角框線(`╭╮╰╯`)加上紅色框線與 `⚠` 圖示三者一起用,單色終端
 * 也能靠框線形狀分辨出這是不同等級的請求。
 *
 * 這裡要更正一件事:cli-tui_hld.md §4.2 與 §4.3 的 ASCII 示意圖其實**都**
 * 畫成圓角,但 §4.3 的文字說明明講兩者要不同(「圓角 vs 一般的 ┌┐└┘」)——
 * 那句文字才是規格(也是任務說明重複強調的「different border style」),
 * §4.2 的示意圖圓角推斷是沿用文件模板時忘記換字元,不是要求一般請求也走
 * 圓角。因此一般請求沿用整個 TUI 共用的 `BORDER_STYLE`(方角),只有這裡
 * 額外定義的圓角樣式給 strong 用——兩者只在 `panes/PermissionModal.tsx`
 * 這一個檔案裡會同時出現,不影響其餘窗格。
 */
export const STRONG_BORDER_STYLE: NonNullable<BoxProps["borderStyle"]> = "round";

// ---- session 狀態圖示與顏色 --------------------------------------------------

/**
 * §3:「狀態圖示(全部量測過佔 1 欄):● busy · ○ idle · ⚠ waiting · ✗ error ·
 * ◐ 連線中 · · closed」。`SessionStatus`(packages/shared/src/session.ts)
 * 比這張表多兩個終態(`interrupted` 是 S6 crash-recovery 的孤兒 session,
 * HLD 這輪的圖示表沒有另外給它符號)——`interrupted` 借用 `waiting` 的
 * `⚠`,語意上兩者都是「需要人處理、目前卡住」,S6 的完整復原流程
 * (繼續/接手/重跑/放棄)不在這輪範圍內,這裡只確保圖示不缺、不是聲稱
 * 支援復原操作。
 */
export const SESSION_STATUS_ICON: Record<SessionStatus, string> = {
  busy: "●",
  idle: "○",
  waiting: "⚠",
  error: "✗",
  closed: "·",
  interrupted: "⚠",
};

/**
 * T3(§7.3):busy session 的活動指示幀。Braille 字元在 cli-tui_hld.md §1.2
 * 的實測表格裡量過帳面寬度是 1 欄(`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`),與 `SESSION_STATUS_ICON`
 * 其餘符號同寬,所以 busy 那一列換成 spinner 不會讓 Sessions 窗格的欄位跑掉。
 *
 * **幀次由時間推算,不記任何狀態**(見 `spinnerFrame()`)——這是刻意的:
 * 若改成「每次重繪就把 frameIndex++」,幀的推進速度會跟著重繪頻率走,焦點
 * session 在狂送 delta 時 spinner 會轉得比背景快,反而變成一個會誤導人的
 * 訊號(看起來像「這個 agent 比較忙」)。用時間推算則不論誰在重繪、重繪
 * 幾次,同一時刻所有 spinner 都在同一幀。
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** 每幀停留的毫秒數——與 app.tsx 的 `SPINNER_INTERVAL_MS` 同值時,每次
 *  spinner 重繪剛好推進一幀。分成兩個常數是因為職責不同:這裡定義「動畫看
 *  起來多快」,那裡定義「多久醒來重繪一次」,兩者概念上可以不同(例如之後
 *  想讓動畫更慢但重繪節奏不變),不該綁死成同一個數字。 */
export const SPINNER_FRAME_MS = 125;

/**
 * 依「現在時刻」算出 spinner 應該顯示哪一幀。純函式、不吃任何模組層級狀態,
 * 所以同一個渲染輪次裡呼叫幾次都得到同一幀,也不需要在 model 裡存 frameIndex。
 */
export function spinnerFrame(nowMs: number): string {
  const index = Math.floor(nowMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/**
 * §3:「不用顏色當唯一訊號——單色終端與色盲都要能分辨,所以圖示本身就要有
 * 區別」——這裡的顏色因此是**加分**,不是唯一線索;`undefined` 代表用終端
 * 機預設前景色,不特別上色(`idle`/`closed` 是「安靜」的狀態,不需要搶
 * 眼)。顏色字串是 ink `<Text color>` 吃的 chalk 色名,不是 ANSI 逸出碼
 * ——這一點與 `apps/cli/src/render.ts` 的 `paint()`(那裡是直接寫 SGR
 * 碼)刻意不同,原因見 tui/model.ts 檔頭:TUI 的內容一律是純文字,顏色
 * 交給 ink 元件的 prop 決定,不能把 ANSI 位元組埋進 model 的字串裡。
 */
export const SESSION_STATUS_COLOR: Record<SessionStatus, string | undefined> = {
  busy: "green",
  idle: undefined,
  waiting: "yellow",
  error: "red",
  closed: "gray",
  interrupted: "yellow",
};

/** transcript 一行的顏色,依 `TranscriptLine.kind`(見 model.ts)決定。 */
export const TRANSCRIPT_LINE_COLOR: Record<string, string | undefined> = {
  agent: undefined,
  user: "cyan",
  tool: "cyan",
  "tool-error": "red",
  system: "yellow",
  permission: "yellow",
};

/** §3 標題列的連線狀態文字——連線中/已斷線才給圖示提醒,`open`(正常)
 *  刻意安靜、不額外加圖示,呼應「安靜表示正常,大聲表示異常」的一貫原則。 */
export function connectionLabel(status: "connecting" | "open" | "closed"): string {
  switch (status) {
    case "open":
      return "已連線";
    case "connecting":
      return "◐ 連線中";
    case "closed":
      return "✗ 已斷線(將自動重連)";
  }
}

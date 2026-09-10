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

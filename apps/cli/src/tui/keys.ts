import { StringDecoder } from "node:string_decoder";

/**
 * 原始位元組 → 具名按鍵。docs/LAYER-3-hld/cli-tui_hld.md §9 明講這個檔案
 * **不 import ink 或 react**——這是刻意繞過 ink 自己那套鍵盤處理
 * (`ink/build/components/App.js` 的 `useInput`/`useStdin().setRawMode`)的
 * 結果,不是疏漏,理由記在下面。
 *
 * 為什麼不用 ink 的 `useInput()`:讀過 `node_modules/ink/build/components/
 * App.js` 的原始碼(而不是猜)之後確認——
 *   1. ink 只有在**某個元件呼叫** `useInput()`/`useStdin().setRawMode(true)`
 *      時才會碰 `process.stdin`(見 App.js 的 `handleSetRawMode`/
 *      `attachReadableListener`)。這個 TUI 完全不用 `useInput`,所以 ink
 *      永遠不會自己進入 raw mode——raw mode 開關與 stdin 的位元組流,
 *      100% 由這個檔案與 tui/app.tsx 自己管。
 *   2. ink 自己的 input-parser(`ink/build/input-parser.js`)對「裸 Esc
 *      vs. 跳脫序列開頭」也有一個逾時消歧(`pendingInputFlushDelayMilliseconds
 *      = 20`,見 App.js),但**只有 20ms**,不是 HLD §6.2 實測後定案的
 *      30ms;而且一旦透過 `useInput` 拿到的 key 已經是消歧完的結果,這個
 *      檔案就沒有機會再套用 §6.2 要求的邏輯與時間值。與其接受 ink 內建的
 *      20ms、或是在 ink 已經消歧過的結果上再包一層(徒增一次不會做任何
 *      事的轉譯),不如直接讀 raw bytes 自己判斷——這也是這個檔案能被
 *      單元測試(不需要終端機、也不需要 ink)的前提。
 *
 * 這連帶解釋了 tui/app.tsx 為什麼仍然照任務要求傳入 `{ exitOnCtrlC: false }`
 * 給 `render()`:那是防禦性的(見 app.tsx 對這個選項的註解),不是這個檔案
 * 運作的必要條件——按第 1 點,ink 的 Ctrl+C 攔截路徑（`handleInput()` 裡
 * `input === '\x03' && exitOnCtrlC`)只有在 ink 自己的 readable listener
 * 被接上時才會被呼叫到,而那條路徑只在用 `useInput` 時才會被接上。
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "shift-tab"
  | "return"
  | "escape"
  | "backspace"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "ctrl-c"
  | "ctrl-a"
  | "ctrl-d"
  | "char";

export interface ParsedKey {
  name: KeyName;
  /** 只有 `name === "char"` 時有意義:實際印出來的字元,可能是多位元組
   *  UTF-8/UTF-16(例如中文)。 */
  char?: string;
}

/**
 * §1.4 實測表格(僅實作這裡量過的序列,不擴充猜測的變體——例如某些終端機
 * 的 Home/End 也可能送 `\x1b[1~`/`\x1b[4~`,但那組沒有在這個環境量到過,
 * 加了等於是在賭,不是在照量測結果做)。
 *
 * 由長到短排序:目前這組資料彼此互不為前綴子集,排序主要是防禦未來新增
 * 序列時,萬一新序列剛好是舊序列的前綴,仍然照最長匹配優先處理。
 */
const ESCAPE_SEQUENCES: ReadonlyArray<{ seq: string; key: ParsedKey }> = (
  [
    { seq: "\x1b[A", key: { name: "up" } },
    { seq: "\x1b[B", key: { name: "down" } },
    { seq: "\x1b[C", key: { name: "right" } },
    { seq: "\x1b[D", key: { name: "left" } },
    { seq: "\x1b[Z", key: { name: "shift-tab" } },
    { seq: "\x1b[H", key: { name: "home" } },
    { seq: "\x1b[F", key: { name: "end" } },
    { seq: "\x1b[5~", key: { name: "pageup" } },
    { seq: "\x1b[6~", key: { name: "pagedown" } },
  ] satisfies Array<{ seq: string; key: ParsedKey }>
).slice().sort((a, b) => b.seq.length - a.seq.length);

function isPrefixOfKnownSequence(s: string): boolean {
  return ESCAPE_SEQUENCES.some((e) => e.seq.startsWith(s));
}

/** 可注入的計時器介面——預設走真正的 `setTimeout`/`clearTimeout`,單元測試
 *  可以換成假時鐘,不用真的等 30ms 才能斷言逾時分支。 */
export interface KeyDecoderScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: KeyDecoderScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface KeyDecoderOptions {
  /** §6.2:裸 Esc 與跳脫序列開頭位元組完全相同,期間沒有後續位元組就判定
   *  為裸 Esc。預設 30ms(HLD 實測後認定是本機終端的安全值;遠端 ssh 需要
   *  更長,但這個 TUI 設計上只跑在本機終端,見 §6.2 原文)。 */
  escTimeoutMs?: number;
  scheduler?: KeyDecoderScheduler;
}

export interface KeyDecoder {
  /** 餵入從 stdin 讀到的原始位元組。**必須是 `Buffer`**(或測試時圖方便
   *  直接傳已解碼的 `string`)——不可以是呼叫端自己先用 `chunk.toString()`
   *  轉過的字串,那樣就繞過了下面的 `StringDecoder`,§6.4 的多位元組字元
   *  被 chunk 邊界切一半的問題就沒有防到。 */
  feed(chunk: Buffer | string): void;
  /** 清掉還在等待的 Esc 逾時計時器——app.tsx 在離開 TUI 時呼叫,避免那顆
   *  計時器成為 process.exit() 卡住不退出的原因(比照 connect.ts 裡
   *  `closeGateway()` 的說明:任何沒 unref 的計時器都可能讓事件迴圈不肯
   *  自然結束)。 */
  dispose(): void;
}

/**
 * 建立一個有狀態的按鍵解碼器。輸入是任意切法的 raw bytes(§1.4:chunk 邊界
 * 可能切在一個逃逸序列或一個中文字中間),輸出透過 `onKey` callback 逐一
 * 吐出——不是「餵一次吐一批」的同步回傳,因為裸 Esc 的判定天生就需要等到
 * 逾時計時器觸發才吐得出來,無法用同步回傳值表達。
 */
export function createKeyDecoder(onKey: (key: ParsedKey) => void, options: KeyDecoderOptions = {}): KeyDecoder {
  const escTimeoutMs = options.escTimeoutMs ?? 30;
  const scheduler = options.scheduler ?? realScheduler;
  // §6.4:UTF-8 多位元組字元(例如中文 3 bytes)可能被 chunk 邊界切開,
  // `StringDecoder` 會扣住還不完整的尾巴,等下一個 chunk 補齊才吐出來——
  // 不能對每個 chunk 直接 `buf.toString()`。
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let escTimer: unknown;

  function clearEscTimer(): void {
    if (escTimer !== undefined) {
      scheduler.clearTimeout(escTimer);
      escTimer = undefined;
    }
  }

  function armEscTimer(): void {
    clearEscTimer();
    escTimer = scheduler.setTimeout(() => {
      escTimer = undefined;
      if (pending.length > 0 && pending.charCodeAt(0) === 0x1b) {
        pending = pending.slice(1);
        onKey({ name: "escape" });
        drain();
      }
    }, escTimeoutMs);
  }

  /** 從 `pending` 開頭盡量解析出完整的按鍵;解析不動(需要更多位元組,或
   *  在等 Esc 逾時)就停手,等下一次 `feed()` 或計時器觸發再繼續。 */
  function drain(): void {
    for (;;) {
      if (pending.length === 0) return;
      const ch0 = pending.charCodeAt(0);

      if (ch0 === 0x1b) {
        const matched = ESCAPE_SEQUENCES.find((e) => pending.startsWith(e.seq));
        if (matched) {
          clearEscTimer();
          pending = pending.slice(matched.seq.length);
          onKey(matched.key);
          continue;
        }
        if (isPrefixOfKnownSequence(pending)) {
          // 還可能湊成某個已知序列(單獨一個 "\x1b" 天生是任何序列的前綴,
          // 這正是 §6.2 要用逾時處理的那個情況)——等更多位元組或逾時。
          armEscTimer();
          return;
        }
        // 已經確定不可能再湊成任何已知序列——把這個 ESC 當裸 Esc 立刻吐出,
        // 其餘位元組留給下一輪迴圈當全新輸入重新解析(不是等 30ms 才放棄,
        // 因為這裡已經能確定,不需要再等)。
        clearEscTimer();
        pending = pending.slice(1);
        onKey({ name: "escape" });
        continue;
      }

      // 非 ESC 開頭——不會是還沒收完的序列,可以立刻判斷,不需要計時器。
      clearEscTimer();
      if (ch0 === 0x03) {
        pending = pending.slice(1);
        onKey({ name: "ctrl-c" });
        continue;
      }
      if (ch0 === 0x01) {
        pending = pending.slice(1);
        onKey({ name: "ctrl-a" });
        continue;
      }
      if (ch0 === 0x04) {
        pending = pending.slice(1);
        onKey({ name: "ctrl-d" });
        continue;
      }
      if (ch0 === 0x09) {
        pending = pending.slice(1);
        onKey({ name: "tab" });
        continue;
      }
      if (ch0 === 0x0d || ch0 === 0x0a) {
        pending = pending.slice(1);
        onKey({ name: "return" });
        continue;
      }
      if (ch0 === 0x7f || ch0 === 0x08) {
        pending = pending.slice(1);
        onKey({ name: "backspace" });
        continue;
      }

      // 一般可印出字元,含中文等多位元組字元(§1.4:`中` 是 UTF-8 3
      // bytes,但 `StringDecoder` 已經把它組回一個完整的 JS 字串——這裡用
      // `codePointAt`/`fromCodePoint` 而非直接取 `pending[0]`,防禦性地
      // 處理 UTF-16 代理對(surrogate pair,例如某些 emoji/罕見字),避免
      // 把一個字元切一半。
      const codePoint = pending.codePointAt(0) ?? ch0;
      const charStr = String.fromCodePoint(codePoint);
      pending = pending.slice(charStr.length);
      onKey({ name: "char", char: charStr });
    }
  }

  return {
    feed(chunk: Buffer | string): void {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text.length === 0) return;
      pending += text;
      drain();
    },
    dispose(): void {
      clearEscTimer();
      pending = "";
    },
  };
}

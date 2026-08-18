/** @type {import('tailwindcss').Config} */

/*
 * ---------------------------------------------------------------------------
 * Deskmony 設計系統(UI/UX 改版)
 * ---------------------------------------------------------------------------
 *
 * 這份 config **不再直接寫死顏色**,所有色彩一律指向 src/index.css 定義的 CSS
 * 變數(以「RGB 通道值」形式儲存,例如 `--c-canvas: 10 10 11`)。理由:
 *
 *   1. **深色/淺色雙主題**:主題切換只需要換 `<html data-theme>`,不需要在每個
 *      元件上掛 `dark:` variant——原本整個 app 是硬編的深色類名(bg-base-950
 *      之類),要支援淺色等於每一行都得改。
 *   2. **相容既有類名**:`base-950 … base-100` 這一組舊有的階梯**保留**,只是
 *      改由變數供給。舊有用法在整個 codebase 是一致的語意(950 = 最底層背景、
 *      100 = 最亮的正文),淺色主題只要把這個階梯「反轉亮度」就自動成立。
 *   3. **透明度修飾詞**:通道形式(`rgb(var(--x) / <alpha-value>)`)才能支援
 *      `bg-accent/10`、`border-accent/40`、`bg-base-900/40` 這類既有寫法。
 *
 * 字級刻度刻意比 Tailwind 預設**整體縮一階**(sm 14px → 12px、base 16px →
 * 13px):這是專業開發者工具(Linear / Cursor / Raycast / Claude Code)的資訊
 * 密度基準,也是這輪「提高資訊密度」最有效的單一槓桿。
 */

const withAlpha = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // 主題實際由 `:root[data-theme]` 的 CSS 變數決定(見 src/index.css);這裡
  // 保留 class/attribute 兩種 darkMode 判斷,讓少數需要「只在深色下」微調的
  // 地方仍能用 `dark:` variant。
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        /* ---- 既有階梯(語意不變,改由變數供給,淺色主題自動反轉)---- */
        base: {
          950: withAlpha("--c-canvas"),
          900: withAlpha("--c-panel"),
          850: withAlpha("--c-surface"),
          800: withAlpha("--c-surface-2"),
          700: withAlpha("--c-line"),
          600: withAlpha("--c-line-strong"),
          500: withAlpha("--c-fg-faint"),
          400: withAlpha("--c-fg-subtle"),
          300: withAlpha("--c-fg-muted"),
          200: withAlpha("--c-fg-soft"),
          100: withAlpha("--c-fg"),
        },

        /* ---- 語意化別名(新程式碼優先使用這一組,讀起來就知道用途)---- */
        canvas: withAlpha("--c-canvas"), // 內容區背景(最底層)
        panel: withAlpha("--c-panel"), // 側欄 / 頂列 / 對話框外殼
        surface: {
          DEFAULT: withAlpha("--c-surface"), // 卡片 / 輸入框
          2: withAlpha("--c-surface-2"), // 徽章底 / hover 填色
        },
        line: {
          DEFAULT: withAlpha("--c-line"), // 一般分隔線 / 輸入框邊框
          strong: withAlpha("--c-line-strong"), // 需要被看見的邊框(次要按鈕)
          subtle: withAlpha("--c-line-subtle"), // 幾乎看不見的分隔(密集列表)
        },
        fg: {
          DEFAULT: withAlpha("--c-fg"), // 正文 / 標題
          soft: withAlpha("--c-fg-soft"), // 次級標題
          muted: withAlpha("--c-fg-muted"), // 說明文字
          subtle: withAlpha("--c-fg-subtle"), // meta / 標籤
          faint: withAlpha("--c-fg-faint"), // placeholder / 停用
        },

        /* ---- 品牌色 ---- */
        accent: {
          DEFAULT: withAlpha("--c-accent"),
          hover: withAlpha("--c-accent-hover"),
          muted: withAlpha("--c-accent-muted"),
          fg: withAlpha("--c-accent-fg"), // 疊在 accent 上的文字色
        },

        /* ---- 狀態色(單一色 + alpha 修飾詞組出底色/邊框,避免 12 個變數)---- */
        ok: withAlpha("--c-ok"),
        warn: withAlpha("--c-warn"),
        danger: withAlpha("--c-danger"),
        info: withAlpha("--c-info"),

        /* ---- 遮罩 ---- */
        scrim: withAlpha("--c-scrim"),
      },

      fontFamily: {
        // "Inter Variable" 是自帶字型(src/index.css 的 @fontsource-variable/inter
        // import)實際註冊的 font-family 名稱;"Inter" 留作系統剛好裝了靜態版的
        // 保底,其餘為原生系統字型 fallback(CJK 由 Microsoft JhengHei/PingFang TC
        // 等接手,Inter 本身不含中日文字符)。
        sans: [
          "Inter Variable",
          "Inter",
          "-apple-system",
          "Segoe UI Variable Text",
          "Segoe UI",
          "Microsoft JhengHei",
          "PingFang TC",
          "Noto Sans TC",
          "sans-serif",
        ],
        mono: ["Cascadia Code", "JetBrains Mono", "SF Mono", "Consolas", "monospace"],
      },

      /* 開發者工具密度刻度(整體比 Tailwind 預設小一階) */
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.01em" }],
        xs: ["11px", { lineHeight: "16px" }],
        sm: ["12px", { lineHeight: "18px" }],
        base: ["13px", { lineHeight: "20px" }],
        md: ["14px", { lineHeight: "21px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px" }],
        "2xl": ["24px", { lineHeight: "32px" }],
      },

      /* 8px grid:主要使用 1(4)/2(8)/3(12)/4(16)/6(24);7 = 28px 用於固定列高 */
      spacing: {
        7: "28px",
        13: "52px",
        15: "60px",
      },

      /*
       * Linear 風改版:12px 是主要互動面(按鈕、輸入框、清單列、下拉選單)的標準
       * 圓角——原本的 3–8px 階梯整體偏「方」,新階梯把 md 直接對齊 12px,大面積
       * 容器(對話框/彈出選單)再放大一階做出層級,細小元件(徽章、kbd、勾選框
       * 用 DEFAULT/sm)維持較小圓角以免在 18–20px 高的元件上顯得過圓。
       */
      borderRadius: {
        sm: "6px",
        DEFAULT: "8px",
        md: "12px",
        lg: "14px",
        xl: "18px",
      },

      boxShadow: {
        panel: "var(--shadow-panel)",
        overlay: "var(--shadow-overlay)",
        pop: "var(--shadow-pop)",
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
      },

      ringColor: {
        DEFAULT: withAlpha("--c-accent"),
      },

      transitionDuration: {
        DEFAULT: "160ms",
      },

      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.985)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "pop-in": "pop-in 140ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        "slide-down": "slide-down 120ms ease-out",
        breathe: "breathe 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

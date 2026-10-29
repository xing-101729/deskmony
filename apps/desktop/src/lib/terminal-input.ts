/**
 * 把一大段終端輸入(例如貼上)切成不超過 `chunkChars` 個 UTF-16 code unit 的片段。**純函式、沒有任何 import**
 * (`scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入這個 .ts 驗證)。
 *
 * 切點不能落在 surrogate pair 中間:emoji 與罕見漢字在 JS 字串裡是兩個 code unit(high 在前、low 在後),拆到兩段送出,
 * core 端各自以 UTF-8 編碼就會變成兩個無效字元(U+FFFD),貼上的內容壞掉。切點前一個字元若是 high surrogate,
 * 切點往前挪一格(那個 pair 整個留給下一段)。`chunkChars` 小到連一個 pair(2)都放不下時,至少送出一個完整的 pair。
 */
export function splitTerminalInput(data: string, chunkChars: number): string[] {
  const size = Math.max(2, Math.floor(chunkChars));
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + size, data.length);
    if (end < data.length) {
      const last = data.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1; // high surrogate 落在切點前:把它留給下一段,和它的 low 在一起
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

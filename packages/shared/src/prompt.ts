import { z } from "zod";

/**
 * PromptInput:送給 agent 的一次輸入。
 * 對應 ARCHITECTURE.md 4.3 節 AgentAdapter.sendPrompt(handle, prompt: PromptInput)。
 */

/**
 * 檔案路徑附件——這個變體在 async-scribbling-llama.md Phase 6 之前就存在,但
 * 一直是完全沒人用的死程式碼(四個 adapter 的 sendPrompt() 均未讀取
 * `.attachments`)。Phase 6 只新增下面的圖片變體,這個檔案路徑變體維持原樣、
 * 不刪不動——不是這次改動的範圍,也沒有任何呼叫端會產生這個形狀。
 */
export const PromptFileAttachmentSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
});
export type PromptFileAttachment = z.infer<typeof PromptFileAttachmentSchema>;

/**
 * async-scribbling-llama.md Phase 6:使用者從聊天輸入框貼上/夾帶的圖片——
 * base64 內嵌資料(不是檔案路徑),不含 `data:image/png;base64,` 這類 data URL
 * 前綴(那段由前端組 `<img src>` 時才加回去,見 apps/desktop/src/views/chat/
 * ToolImage.tsx 既有的慣例,兩個方向共用同一種「純 base64、無前綴」約定)。
 * 只列出 Anthropic Messages API 的 `Base64ImageSource.media_type` 明確支援的
 * 四種點陣圖格式(見 packages/adapters/src/claude-sdk-adapter.ts 的
 * sendPrompt() 對這個型別的查證)。
 */
export const PromptImageMediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export type PromptImageMediaType = z.infer<typeof PromptImageMediaTypeSchema>;

export const PromptImageAttachmentSchema = z.object({
  type: z.literal("image"),
  mediaType: PromptImageMediaTypeSchema,
  data: z.string(),
});
export type PromptImageAttachment = z.infer<typeof PromptImageAttachmentSchema>;

/**
 * 圖片以外的檔案附件——對應 Anthropic Messages API 的 `DocumentBlockParam`
 * (見 packages/adapters/src/claude-sdk-adapter.ts 的 sendPrompt() 查證)。
 * 該 content block 只認兩種 source:PDF(`Base64PDFSource`)與純文字
 * (`PlainTextSource`),不是「任何檔案都能附加」。`data` 一律是 base64,
 * 與圖片附件同一個「不含 data URL 前綴」約定——即使 mediaType 是
 * text/plain 也一樣先 base64 編碼:`PlainTextSource.data` 本身雖然要明文,
 * 但讓 wire payload/DB 儲存(JSON.stringify 整個陣列)統一走 base64,adapter
 * 端組 content block 時才依 mediaType decode,不用為 text/plain 另開一種
 * 欄位編碼。`name` 是原始檔名——圖片用縮圖不需要檔名,這裡沒有縮圖可看,
 * UI 靠檔名畫檔案卡片,也順便送進 `DocumentBlockParam.title`。
 */
export const PromptDocumentMediaTypeSchema = z.enum(["application/pdf", "text/plain"]);
export type PromptDocumentMediaType = z.infer<typeof PromptDocumentMediaTypeSchema>;

export const PromptDocumentAttachmentSchema = z.object({
  type: z.literal("document"),
  mediaType: PromptDocumentMediaTypeSchema,
  data: z.string(),
  name: z.string(),
});
export type PromptDocumentAttachment = z.infer<typeof PromptDocumentAttachmentSchema>;

export const PromptAttachmentSchema = z.discriminatedUnion("type", [
  PromptFileAttachmentSchema,
  PromptImageAttachmentSchema,
  PromptDocumentAttachmentSchema,
]);
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

export const PromptInputSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(PromptAttachmentSchema).optional(),
});
export type PromptInput = z.infer<typeof PromptInputSchema>;

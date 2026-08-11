import { z } from "zod";

/**
 * PromptInput:送給 agent 的一次輸入。
 * 對應 ARCHITECTURE.md 4.3 節 AgentAdapter.sendPrompt(handle, prompt: PromptInput)。
 */
export const PromptAttachmentSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
});
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

export const PromptInputSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(PromptAttachmentSchema).optional(),
});
export type PromptInput = z.infer<typeof PromptInputSchema>;

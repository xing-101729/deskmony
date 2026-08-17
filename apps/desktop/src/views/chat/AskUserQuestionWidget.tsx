import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DialogAnswer } from "@deskmony/shared";
import { useSessionStore, type ChatItem } from "../../stores/session-store.js";
import { Badge } from "../../ui/Badge.js";
import { Button } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { ToolCallBubble } from "../ChatView.js";

/** 對應 SDK 的 `AskUserQuestionInput.questions[]`(見 async-scribbling-llama.md
 *  Phase 7)。跟 TodoListView.tsx/DiffHunkView.tsx 一樣不 import SDK 型別
 *  ——desktop 這一側從沒依賴過 `@anthropic-ai/claude-agent-sdk`。 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestionQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** 防禦性驗證:形狀不符就回傳 null,呼叫端(ChatView.tsx)據此 fallback 回
 *  通用的 `ToolCallBubble`——同 `parseTodoWriteInput()`/`parseDiffResult()`
 *  既有慣例。`options` 最少 2 個(SDK 保證 2-4 個),`questions` 至少 1 題。 */
export function parseAskUserQuestionInput(input: unknown): AskUserQuestionQuestion[] | null {
  if (typeof input !== "object" || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const parsed: AskUserQuestionQuestion[] = [];
  for (const entry of questions) {
    if (typeof entry !== "object" || entry === null) return null;
    const { question, header, options, multiSelect } = entry as Record<string, unknown>;
    if (typeof question !== "string" || typeof header !== "string") return null;
    if (typeof multiSelect !== "boolean") return null;
    if (!Array.isArray(options) || options.length < 2) return null;

    const parsedOptions: AskUserQuestionOption[] = [];
    for (const opt of options) {
      if (typeof opt !== "object" || opt === null) return null;
      const { label, description, preview } = opt as Record<string, unknown>;
      if (typeof label !== "string" || typeof description !== "string") return null;
      if (preview !== undefined && typeof preview !== "string") return null;
      parsedOptions.push(preview !== undefined ? { label, description, preview } : { label, description });
    }
    parsed.push({ question, header, options: parsedOptions, multiSelect });
  }
  return parsed;
}

/** 對應 SDK 的 `AskUserQuestionOutput.answers`(question text -> 選項 label,
 *  多選以逗號串接,見 sdk-tools.d.ts)——同上方 `parseAskUserQuestionInput()`
 *  的防禦性驗證慣例,形狀不符回傳 null。 */
function parseAskUserQuestionAnswers(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) return null;
  const answers = (value as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  for (const v of Object.values(answers)) {
    if (typeof v !== "string") return null;
  }
  return answers as Record<string, string>;
}

const MULTI_SELECT_JOIN = ", ";

function QuestionHeader({ header, question }: { header: string; question: string }): JSX.Element {
  return (
    <div className="mb-1.5">
      <Badge tone="accent">{header}</Badge>
      <p className="mt-1 text-sm leading-relaxed text-fg">{question}</p>
    </div>
  );
}

/**
 * 待答模式:選項渲成可點按鈕。單選點下即切換本題的選取(單選鈕視覺);
 * `multiSelect` 可切換多個(checkbox 視覺)。**所有題目都至少選了一個選項後
 * 底部的送出按鈕才會啟用**——`resolveUserDialog()` 是整批一次解析同一個
 * `requestId`(見 claude-sdk-adapter.ts 的 `canUseTool` 特例),無法只答一部分
 * 就送出,多題時必須全部選完。「略過」則不受此限制,隨時可送出空答案
 * (比照 SDK 自己 idle 逾時的語意,見 session-store.ts 的 `resolveUserDialog`
 * action 註解)。
 */
function PendingQuestions({
  sessionId,
  requestId,
  questions,
}: {
  sessionId: string;
  requestId: string;
  questions: AskUserQuestionQuestion[];
}): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const resolveUserDialog = useSessionStore((s) => s.resolveUserDialog);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  const toggleOption = (q: AskUserQuestionQuestion, label: string): void => {
    if (submitting) return;
    setSelected((prev) => {
      const current = prev[q.question] ?? [];
      const next = q.multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label];
      return { ...prev, [q.question]: next };
    });
  };

  const allAnswered = questions.every((q) => (selected[q.question]?.length ?? 0) > 0);

  const submit = (result: DialogAnswer): void => {
    if (submitting) return;
    setSubmitting(true);
    resolveUserDialog(sessionId, requestId, result);
  };

  const handleSubmit = (): void => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.question] = (selected[q.question] ?? []).join(MULTI_SELECT_JOIN);
    }
    submit({ behavior: "completed", result: { answers } });
  };

  return (
    <div className="my-1.5 space-y-3 rounded-md border border-accent/30 bg-accent/[0.04] px-3 py-2.5 text-xs">
      {questions.map((q) => (
        <div key={q.question}>
          <QuestionHeader header={q.header} question={q.question} />
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => {
              const isSelected = (selected[q.question] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={submitting}
                  onClick={() => toggleOption(q, opt.label)}
                  className={`focus-ring flex select-chrome items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition disabled:pointer-events-none disabled:opacity-50 ${
                    isSelected
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-line-subtle bg-surface/60 text-fg-soft hover:border-line-strong"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border ${
                      q.multiSelect ? "rounded-[3px]" : "rounded-full"
                    } ${isSelected ? "border-accent bg-accent text-accent-fg" : "border-fg-faint"}`}
                  >
                    {isSelected && <Icon name="check" size={9} strokeWidth={2.5} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{opt.label}</span>
                    <span className="block text-2xs text-fg-faint">{opt.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <Button variant="ghost" size="xs" disabled={submitting} onClick={() => submit({ behavior: "cancelled" })}>
          {t("chat:askUserQuestion.skipLabel")}
        </Button>
        <Button variant="primary" size="sm" disabled={!allAnswered || submitting} onClick={handleSubmit}>
          {t("chat:askUserQuestion.submitLabel")}
        </Button>
      </div>
    </div>
  );
}

/** 已答模式:唯讀顯示每題選了什麼。`answers` 是已經解析過的
 *  `AskUserQuestionOutput.answers`(可能是 null——見下方 `AskUserQuestionWidget`
 *  對 `parseAskUserQuestionAnswers()` 失敗時仍進入這個模式的說明),缺值的題目
 *  顯示中性的「未作答」徽章,而不是留白或整個 fallback。 */
function ResolvedQuestions({
  questions,
  answers,
}: {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string> | null;
}): JSX.Element {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="my-1.5 space-y-2.5 rounded-md border border-line-subtle bg-surface/60 px-3 py-2.5 text-xs">
      {questions.map((q) => {
        const answer = answers?.[q.question];
        return (
          <div key={q.question}>
            <QuestionHeader header={q.header} question={q.question} />
            {answer ? (
              <Badge tone="ok" icon="check">
                {answer}
              </Badge>
            ) : (
              <Badge tone="neutral">{t("chat:askUserQuestion.noAnswerLabel")}</Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * async-scribbling-llama.md Phase 7:`item.toolName === "AskUserQuestion"` 且
 * `parseAskUserQuestionInput(item.input)` 驗證成功時,ChatView.tsx 的
 * `ChatBubble` 分派到這裡渲染(`questions` 已由呼叫端解析好)。三種模式:
 *
 *   - **pending**:`pendingUserDialogs` 有對應 `toolUseID`(= `item.id`,見
 *     `UserDialogRequestEventSchema` 註解:與既有 `tool-call` 事件的
 *     `toolCallId` 是同一個 id)的項目 → 可互動的問答表單。
 *   - **resolved**:不是 pending,且 tool-result 已抵達(`item.output`/
 *     `item.structuredResult` 其中之一有值,不要求 structuredResult 一定要
 *     解析成功——後者依 Phase 4 的保守判斷,一次 turn 裡有多個平行
 *     tool_result 時可能刻意不填,見 claude-sdk-adapter.ts 的 `case "user"`
 *     註解)→ 唯讀顯示已選答案,優先讀 `item.structuredResult` 解析出的
 *     `answers`。
 *   - **兩者皆非**:SDK 已送出 tool-call(所以 `item.input` 才解析得到)但
 *     `canUseTool` 觸發的 `user-dialog-request` 還沒抵達,或 reload 後
 *     `pendingUserDialogs` 這個純記憶體狀態沒有重建——與既有
 *     `pendingPermissions` reload 後不會重建是同一種已存在的限制,不是這次
 *     新引入的缺口 → fallback 回通用的 `ToolCallBubble`。
 */
export function AskUserQuestionWidget({
  item,
  questions,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  questions: AskUserQuestionQuestion[];
}): JSX.Element {
  const pendingUserDialogs = useSessionStore((s) => s.pendingUserDialogs);
  const pending = pendingUserDialogs.find((d) => d.toolUseID === item.id);

  if (pending) {
    return <PendingQuestions sessionId={pending.sessionId} requestId={pending.requestId} questions={questions} />;
  }

  if (item.output !== undefined || item.structuredResult !== undefined) {
    return <ResolvedQuestions questions={questions} answers={parseAskUserQuestionAnswers(item.structuredResult)} />;
  }

  return <ToolCallBubble item={item} />;
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DialogAnswer } from "@deskmony/shared";
import { useSessionStore, type ChatItem, type PendingUserDialog } from "../../stores/session-store.js";
import { Badge } from "../../ui/Badge.js";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Field.js";
import { Icon } from "../../ui/icons.js";
import { ToolCallBubble } from "../ChatView.js";

/**
 * 會被渲染成問答表單的提問工具:claude-agent-sdk 的 `AskUserQuestion`、
 * opencode 的 `question`(2026-09-17 補上——在那之前只認前者,opencode 的提問
 * 只會顯示成一個永遠「執行中」的通用工具氣泡,使用者看不到任何選項)。
 */
const QUESTION_TOOL_NAMES = new Set(["AskUserQuestion", "question"]);

export function isQuestionToolName(toolName: string): boolean {
  return QUESTION_TOOL_NAMES.has(toolName);
}

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
  /** 是否提供自行輸入答案的欄位。只有後端明講 `custom: false` 時才關掉——兩個
   *  後端的工具說明都告訴模型「自行輸入會自動提供,不要自己放 Other 選項」。 */
  custom: boolean;
}

/** 防禦性驗證:形狀不符就回傳 null,呼叫端據此 fallback 回通用的
 *  `ToolCallBubble`——同 `parseTodoWriteInput()`/`parseDiffResult()` 既有慣例。
 *  同時接受 claude-agent-sdk 的原始形狀(`multiSelect`)與 opencode 的原始形狀
 *  (`multiple?`/`custom?`),因為已答模式讀的是工具自己的 input/output。
 *  `options` 不限個數:opencode 沒有下限,模型可能只靠自行輸入來問開放式問題。 */
export function parseAskUserQuestions(questions: unknown): AskUserQuestionQuestion[] | null {
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const parsed: AskUserQuestionQuestion[] = [];
  for (const entry of questions) {
    if (typeof entry !== "object" || entry === null) return null;
    const { question, header, options, multiSelect, multiple, custom } = entry as Record<string, unknown>;
    if (typeof question !== "string" || typeof header !== "string") return null;
    if (!Array.isArray(options)) return null;
    if (multiSelect !== undefined && typeof multiSelect !== "boolean") return null;
    if (multiple !== undefined && typeof multiple !== "boolean") return null;
    if (custom !== undefined && typeof custom !== "boolean") return null;

    const parsedOptions: AskUserQuestionOption[] = [];
    for (const opt of options) {
      if (typeof opt !== "object" || opt === null) return null;
      const { label, description, preview } = opt as Record<string, unknown>;
      if (typeof label !== "string" || typeof description !== "string") return null;
      if (preview !== undefined && typeof preview !== "string") return null;
      parsedOptions.push(preview !== undefined ? { label, description, preview } : { label, description });
    }
    parsed.push({
      question,
      header,
      options: parsedOptions,
      multiSelect: multiSelect ?? multiple ?? false,
      custom: custom !== false,
    });
  }
  return parsed;
}

export function parseAskUserQuestionInput(input: unknown): AskUserQuestionQuestion[] | null {
  if (typeof input !== "object" || input === null) return null;
  return parseAskUserQuestions((input as { questions?: unknown }).questions);
}

/** 對應 SDK 的 `AskUserQuestionOutput.answers`(question text -> 選項 label,
 *  多選以逗號串接,見 sdk-tools.d.ts)——同上方 `parseAskUserQuestions()`
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

/** 已答模式的題目來源:優先讀 `structuredResult.questions`(claude-agent-sdk 的
 *  `AskUserQuestionOutput`、opencode adapter 組的同形狀物件都有,而且是工具跑完
 *  之後的定版),沒有再讀工具 input。 */
function questionsOfToolItem(item: Extract<ChatItem, { kind: "tool" }>): AskUserQuestionQuestion[] | null {
  const fromResult =
    typeof item.structuredResult === "object" && item.structuredResult !== null
      ? parseAskUserQuestions((item.structuredResult as { questions?: unknown }).questions)
      : null;
  return fromResult ?? parseAskUserQuestionInput(item.input);
}

const MULTI_SELECT_JOIN = ", ";

function QuestionHeader({ header, question }: { header: string; question: string }): JSX.Element {
  return (
    <div className="mb-1.5">
      {header && <Badge tone="accent">{header}</Badge>}
      <p className="mt-1 text-sm leading-relaxed text-fg">{question}</p>
    </div>
  );
}

/**
 * 待答模式:選項渲成可點按鈕。單選點下即切換本題的選取(單選鈕視覺);
 * `multiSelect` 可切換多個(checkbox 視覺)。`custom` 的題目下方多一個自行輸入
 * 欄——單選時輸入文字會取消已選的選項(反之亦然,兩者擇一),多選時輸入的文字
 * 附加在已選選項後面。**所有題目都有答案(選了選項或輸入了文字)後底部的送出
 * 按鈕才會啟用**——adapter 是整批一次解析同一個 `requestId`,無法只答一部分就
 * 送出,多題時必須全部答完。「略過」則不受此限制,隨時可送出空答案(比照 SDK
 * 自己 idle 逾時的語意,見 session-store.ts 的 `resolveUserDialog` action 註解)。
 */
function PendingQuestions({
  dialog,
  questions,
}: {
  dialog: PendingUserDialog;
  questions: AskUserQuestionQuestion[];
}): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const resolveUserDialog = useSessionStore((s) => s.resolveUserDialog);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
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
    if (!q.multiSelect) setCustomText((prev) => ({ ...prev, [q.question]: "" }));
  };

  const changeCustomText = (q: AskUserQuestionQuestion, text: string): void => {
    setCustomText((prev) => ({ ...prev, [q.question]: text }));
    if (!q.multiSelect && text.trim()) setSelected((prev) => ({ ...prev, [q.question]: [] }));
  };

  const answerOf = (q: AskUserQuestionQuestion): string[] => {
    const typed = q.custom ? (customText[q.question] ?? "").trim() : "";
    return typed ? [...(selected[q.question] ?? []), typed] : (selected[q.question] ?? []);
  };

  const allAnswered = questions.every((q) => answerOf(q).length > 0);

  const submit = (result: DialogAnswer): void => {
    if (submitting) return;
    setSubmitting(true);
    resolveUserDialog(dialog.sessionId, dialog.requestId, result);
  };

  const handleSubmit = (): void => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.question] = answerOf(q).join(MULTI_SELECT_JOIN);
    }
    submit({ behavior: "completed", result: { answers } });
  };

  return (
    <div className="my-1.5 space-y-3 rounded-md border border-accent/30 bg-accent/[0.04] px-3.5 py-3 text-xs">
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
                  className={`focus-ring flex select-chrome items-start gap-2 rounded-md border px-3 py-2 text-left transition disabled:pointer-events-none disabled:opacity-50 ${
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
            {q.custom && (
              <Input
                fieldSize="md"
                value={customText[q.question] ?? ""}
                disabled={submitting}
                onChange={(e) => changeCustomText(q, e.target.value)}
                onKeyDown={(e) => {
                  // 輸入法選字時的 Enter 是在確認候選字,不是送出。
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={t("chat:askUserQuestion.customPlaceholder")}
                aria-label={t("chat:askUserQuestion.customPlaceholder")}
              />
            )}
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
 *  `AskUserQuestionOutput.answers`(可能是 null——工具失敗或中斷時沒有答案),
 *  缺值的題目顯示中性的「未作答」徽章,而不是留白或整個 fallback。工具以錯誤
 *  收場(例如回合被中斷)時,把錯誤訊息附在最後,不然看不出為什麼沒有答案。 */
function ResolvedQuestions({
  questions,
  answers,
  errorText,
}: {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string> | null;
  errorText?: string;
}): JSX.Element {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="my-1.5 space-y-2.5 rounded-md border border-line-subtle bg-surface/60 px-3.5 py-3 text-xs">
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
      {errorText && <p className="text-2xs text-fg-faint">{errorText}</p>}
    </div>
  );
}

/**
 * async-scribbling-llama.md Phase 7:提問工具(`isQuestionToolName()`)在對話串
 * 裡的渲染。三種模式:
 *
 *   - **pending**:工具還沒有結果,且 `pendingUserDialogs` 有對應 `toolUseID`
 *     (= `item.id`,見 `UserDialogRequestEventSchema` 註解:與既有 `tool-call`
 *     事件的 `toolCallId` 是同一個 id)的項目 → 可互動的問答表單。題目取自
 *     待答請求本身(adapter 已整理成統一形狀),不依賴工具 input——opencode 的
 *     `question.asked` 比帶 input 的 `running` 更早到(實測),表單出現的那一刻
 *     tool-call 通常還沒有 input。
 *   - **resolved**:tool-result 已抵達(`item.status === "done"`)→ 唯讀顯示
 *     已選答案。工具一有結果就不可能再作答,即使 `pendingUserDialogs` 還殘留
 *     一筆(例如回合被中斷)也不再顯示表單。
 *   - **兩者皆非**:還沒收到待答請求,或 reload 後 `pendingUserDialogs` 這個純
 *     記憶體狀態沒有重建——與既有 `pendingPermissions` reload 後不會重建是同一種
 *     已存在的限制 → fallback 回通用的 `ToolCallBubble`。
 */
export function AskUserQuestionWidget({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): JSX.Element {
  const pending = useSessionStore((s) => s.pendingUserDialogs.find((d) => d.toolUseID === item.id));

  if (item.status === "done") {
    const questions = questionsOfToolItem(item);
    if (questions) {
      return (
        <ResolvedQuestions
          questions={questions}
          answers={parseAskUserQuestionAnswers(item.structuredResult)}
          errorText={item.isError && typeof item.output === "string" ? item.output : undefined}
        />
      );
    }
  } else if (pending) {
    const questions = parseAskUserQuestions(pending.questions) ?? parseAskUserQuestionInput(item.input);
    if (questions) return <PendingQuestions dialog={pending} questions={questions} />;
  }

  return <ToolCallBubble item={item} />;
}

/**
 * 對話串裡對不上任何提問工具項目的待答請求,改在對話串底部顯示——例如 opencode
 * 的提問沒有帶 `tool`,或是由不在 `isQuestionToolName()` 清單裡的工具發起
 * (opencode 的 plan 模式離開確認也走同一套提問機制)。沒有這一層,這些請求
 * 會讓 agent 無聲無息地一直等,與 2026-09-16 使用者回報「看不到選項」是同一種
 * 症狀。
 */
export function PendingUserDialogsDock({
  sessionId,
  items,
}: {
  sessionId: string;
  items: readonly ChatItem[];
}): JSX.Element | null {
  const pendingUserDialogs = useSessionStore((s) => s.pendingUserDialogs);
  const unmatched = pendingUserDialogs.filter(
    (d) =>
      d.sessionId === sessionId &&
      !items.some((item) => item.kind === "tool" && item.id === d.toolUseID && isQuestionToolName(item.toolName)),
  );
  if (unmatched.length === 0) return null;

  return (
    <>
      {unmatched.map((dialog) => {
        const questions = parseAskUserQuestions(dialog.questions);
        return questions ? <PendingQuestions key={dialog.requestId} dialog={dialog} questions={questions} /> : null;
      })}
    </>
  );
}

import type { PolicyRule } from "@deskmony/shared";
import { checkHardDeny } from "./hard-deny.js";
import { extractCommandFromInput, extractPathCandidates, isPathUnder, resolveRealpathBestEffort } from "./tool-input.js";

/**
 * policy-engine.ts(S1:PolicyEngine 主體)。
 *
 * 對應 docs/LAYER-4-detail-design/policy-engine_detail.md §2、§4。
 * **default-deny 是整個檔案的鐵則**:任何判斷不出來的情況一律 `escalate`,
 * 絕不 `allow`——見 `decide()` 最底部的 fallback。
 *
 * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):這條鐵則現在有**唯一一個**
 * 明確、opt-in、需要使用者逐次主動確認的例外——`ctx.trueUnrestricted` 為真時
 * `decide()` 一開頭就直接 allow,見該方法最前面的短路與其上方註解。這不是
 * default-deny 精神的放棄,而是使用者在充分了解後果後,對單一 session 明確
 * 授權的例外,且這個例外本身不能靠遠端/本機身份或 autoMode 隱性觸發——只有
 * 顯式呼叫 `session.setTrueUnrestricted({enabled:true})` 且前置條件(已是
 * `"auto-accept-all"`)成立才會出現。
 */

export type PolicyEffect = "allow" | "deny" | "escalate" | "escalate-strong";

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  matchedRule?: number;
}

/**
 * 一次待決策的權限請求。`workingDir` 是這個 session 的 worktree 邊界(見
 * hard-deny.ts 的 `HardDenyCheckInput.workingDir` 註解),`profileId`/`role`
 * 供 `scope` 精確比對(Phase 1 不做繼承,見 core-config.ts 的
 * `PolicyRuleScopeSchema` 註解)——都由呼叫端(session-manager.ts)組裝,
 * PolicyEngine 本身不查詢 profile/DB。
 */
export interface PermissionRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  workingDir: string;
  profileId?: string;
  role?: string;
}

/**
 * 三個欄位是**正交**的(S7 L4 §2.1 的設計修正,2026-07-28 落地——初版誤把
 * `attended` 寫成 `autoMode` 的補數,把 2×2 壓成 1×2,詳見
 * session-manager.ts 的 `buildExecContext()`)。取值來源:
 *   - `attended`:**環境事實**——現在有沒有 client 連線看得到彈窗
 *     (`ClientPresencePort.hasConnectedClient()`)。與 `autoMode` 無關。
 *   - `local`:由 Core 依連線來源判定,**絕不採信 client 自稱**——保守的整體
 *     判定:只要有任何遠端 client 連線中就是 `false`
 *     (`!ClientPresencePort.hasRemoteClient()`)。
 *   - `autoMode`:**政策設定**——session 暫態模式非 `"always-ask"`(S7)。
 * PolicyEngine 本身不查詢任何來源,三個值全由呼叫端(session-manager.ts)組好。
 */
export interface ExecContext {
  attended: boolean;
  local: boolean;
  autoMode: boolean;
  /**
   * S7(auto-mode-and-yolo)L4 §2 新增:`true` 僅當 session 暫態模式為
   * `"auto-accept-all"`(YOLO)。auto 與 YOLO 的**唯一**差別:YOLO 額外跳過
   * config 的 `effect:"deny"` 規則(§2 第 2 步);auto 仍受其約束。
   * **hard-deny(第 1 步)兩者都絕不跳過**——`yolo` 完全不影響第 1 步的判斷。
   * 省略(`undefined`)視為 `false`,與既有呼叫端(S1 單元測試、尚未接 S7 前
   * 的 session-manager)行為完全相同,不需要跟著改。
   */
  yolo?: boolean;
  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):`true` 僅當 session 暫態模式
   * 為 `"auto-accept-all"` **且**額外開啟了「真.無限制」層(見
   * session-manager.ts 的 `SessionPermissionState.trueUnrestricted`)。這是
   * **唯一**能讓 `decide()` 跳過 hard-deny(第 1 步)的欄位——`yolo` 本身
   * 永遠不能,見上方 `yolo` 註解與下方 `decide()` 最開頭的短路。省略視為
   * `false`。
   */
  trueUnrestricted?: boolean;
}

export interface PolicyEngineOptions {
  /** 依序比對,第一個 match 決定結果——陣列順序本身就是優先序(deny 規則
   *  應由「寫入端」unshift 到最前面,PolicyEngine 本身不重新排序,見
   *  core-config.ts 的 `PolicyConfigSchema.rules` 註解)。 */
  rules: PolicyRule[];
  /** hard-deny「非白名單外連」用,見 hard-deny.ts。 */
  allowedHosts: string[];
}

export class PolicyEngine {
  /**
   * S7(auto-mode-and-yolo)L4 §4「in-memory 即時生效」:可變的 rules 陣列
   * ——建構時從 config 複製一份(不持有 `options.rules` 的參照,呼叫端傳入
   * 的陣列不會被這裡的 mutation 影響),之後 `addRule()` 就地追加。UI「永遠
   * 允許」寫入 config 檔的同一時刻,呼叫端(session-manager.ts)也會呼叫
   * `addRule()`,讓規則立刻生效,不必等 core 重啟;重啟後 `PolicyEngine` 會
   * 重新以 config 裡的完整規則陣列建構,與這裡 in-memory 累加的結果一致
   * (config-file-writer.ts 的 `appendPolicyRule()` 與這裡的 unshift/push 規則
   * 完全對稱)。
   */
  private rules: PolicyRule[];

  constructor(private readonly options: PolicyEngineOptions) {
    this.rules = [...options.rules];
  }

  /**
   * HLD §4:「永遠允許」的 in-memory 即時生效——deny 規則 unshift 到最前面
   * (優先於既有 allow 規則,與 config-file-writer.ts 寫入 config.json 的陣列
   * 順序規則一致),allow push 到尾端。呼叫端(session-manager.ts 的
   * `resolvePermission()`)必須在呼叫這個方法的同時,把同一條規則寫進
   * config.json(`appendPolicyRule()`),兩者不可只做一邊——否則重啟後行為
   * 就會與這次 session 內的行為不一致。
   */
  addRule(rule: PolicyRule): void {
    if (rule.effect === "deny") {
      this.rules.unshift(rule);
    } else {
      this.rules.push(rule);
    }
  }

  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):依 `id` 移除一條規則,in-memory
   * 立即生效——呼叫端(session-manager.ts 的 `removePolicyRule()`)必須同時呼叫
   * `apps/core/src/config/config-file-writer.ts` 的 `removePolicyRule()` 把
   * 同一筆刪除動作寫回 config.json,兩者不可只做一邊(比照 `addRule()` 與
   * `appendPolicyRule()` 既有的雙寫紀律)。回傳被刪除的規則本身(不是
   * boolean)——稽核記錄與 RPC 回應都需要完整內容,不只是「有沒有刪到」,見
   * `apps/core/src/enforcement/audit-log.ts` 的 `PolicyRuleChangeDetail`。
   * id 不存在時回傳 `undefined`,不拋例外(呼叫端可能與另一個 client 對同一份
   * 清單並行操作)。
   */
  removeRule(id: string): PolicyRule | undefined {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return undefined;
    const [removed] = this.rules.splice(index, 1);
    return removed;
  }

  /** 2026-08-25 新增:回傳目前規則陣列的淺拷貝(不外洩內部可變陣列的參照)——
   *  供 `policy.listRules` RPC 使用,見該 method 註解。 */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * 優先序(不可調換,見 §2):
   *   1. hard-deny 命中 → **遠端 或 autoMode 優先判斷**(不論是否 attended)
   *      → deny(硬地板,F4:HLD §3「情境相依的 hard-deny」把 auto/YOLO 與
   *      無人值守/遠端歸為同一類「沒有人真的在盯著」的情境,即使剛好
   *      attended=true 也不能讓 autoMode 開著時被降級成需要互動的
   *      escalate-strong——那會讓「開了 auto 就不用管」的使用情境每次都被
   *      硬性類打斷,變相逼人關掉 auto,也違背「auto 開啟時硬性類仍是硬地板」
   *      的 C6 規則);只有「本機 + attended + autoMode 未開啟」才降級為
   *      escalate-strong(唯一能降級的組合)。**YOLO 與一般 auto 在這一步
   *      完全沒有差別**——`ctx.yolo` 不影響這一步的任何判斷(見 S7 L4 §2)。
   *   2/3. config 規則依序比對(deny 已在陣列前端,故合併成同一個迴圈)。
   *      **YOLO 額外跳過這裡的 `effect:"deny"` 規則**(S7 L4 §2:auto 與
   *      YOLO 唯一的差別)——`effect:"allow"` 規則仍正常比對(即使跳過對
   *      結果沒有影響,YOLO 最終都會在第 4 步自動放行,但保留 allow 規則比對
   *      讓 audit 的 `reason` 更精確地反映「命中哪條規則」)。
   *   4. autoMode → allow(中間地帶,hard-deny 已在第 1 步優先處理過)。
   *   5. 皆否 → escalate(default-deny)。
   *
   * ⚠️ 2026-08-25 新增第 0 步(見 docs/DECISIONS.md §G):`ctx.trueUnrestricted`
   * 為真時,在**呼叫 `checkHardDeny()` 之前**就直接回傳 allow——這是整個檔案
   * 唯一能繞過 hard-deny 的路徑,刻意放在函式最開頭而不是塞進下面 hard-deny
   * 判斷的分支裡:grep `trueUnrestricted` 找到的就是這個入口,審查時一眼看到,
   * 不需要先看懂 hard-deny 邏輯才發現這裡有例外。這是使用者 2026-08-25 明確
   * 決定的翻案,不是預設行為——只有 session 已經是 `"auto-accept-all"` 且
   * 額外開啟這個開關時 `ctx.trueUnrestricted` 才會是 `true`(見
   * session-manager.ts 的 `setTrueUnrestricted()` 前置條件檢查),default-deny
   * 對所有其餘情況(包含一般 YOLO)仍是唯一不可違反的鐵則。
   */
  decide(req: PermissionRequest, ctx: ExecContext): PolicyDecision {
    if (ctx.trueUnrestricted) {
      return { effect: "allow", reason: "trueUnrestricted 開啟:繞過一切(含 hard-deny),見 docs/DECISIONS.md §G" };
    }

    const hardDeny = checkHardDeny({
      toolName: req.toolName,
      input: req.input,
      workingDir: req.workingDir,
      allowedHosts: this.options.allowedHosts,
    });
    if (hardDeny.matched) {
      // 遠端、或 autoMode 開啟 → 硬 deny,不看 attended(見上方方法註解)。
      if (!ctx.local || ctx.autoMode) {
        return { effect: "deny", reason: `hard-deny(${hardDeny.category},遠端或 autoMode,硬地板):${hardDeny.reason}` };
      }
      // 只剩「本機 + autoMode 未開啟」的組合——只有同時 attended 才降級成
      // 強確認。本機、未開 auto、但**一個 client 都沒連著**(S7 L4 §2.1 修正
      // 後這是個真實可達的象限:無人值守 + 未開 auto)一律硬 deny——強確認的
      // 前提就是「有人能做這個確認」,沒人在的時候把 hard-deny 掛起等人,等於
      // 讓最危險的那一類操作無限期停在那裡等一個不確定會不會回來的人。
      // ⚠️ 注意這與第 5 步的 escalate 掛起**不矛盾**:掛起的是未分類的中間
      // 地帶(「沒人回應 ≠ 拒絕」),hard-deny 則是本來就該拒絕的硬性類。
      if (ctx.attended) {
        return {
          effect: "escalate-strong",
          reason: `hard-deny(${hardDeny.category})降級為強確認(本機+attended+非 autoMode):${hardDeny.reason}`,
        };
      }
      return { effect: "deny", reason: `hard-deny(${hardDeny.category}):${hardDeny.reason}` };
    }

    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      // YOLO 跳過 config 的 deny-list(S7 L4 §2,auto 與 YOLO 唯一的差別)——
      // 只跳過這一條規則的比對,不影響後面其他規則(含 allow 規則)繼續往下比對。
      if (ctx.yolo && rule.effect === "deny") continue;
      if (this.ruleMatches(rule, req)) {
        return { effect: rule.effect, reason: `命中 config 規則 #${i}(tool="${rule.tool}", effect="${rule.effect}")`, matchedRule: i };
      }
    }

    if (ctx.autoMode) {
      return { effect: "allow", reason: "autoMode 開啟,未分類中間地帶自動放行(hard-deny/config deny 仍優先於此)" };
    }

    return { effect: "escalate", reason: "未分類長尾操作,default-deny" };
  }

  private ruleMatches(rule: PolicyRule, req: PermissionRequest): boolean {
    if (rule.tool !== "*" && rule.tool !== req.toolName) return false;

    if (rule.scope) {
      if (rule.scope.profileId !== undefined && rule.scope.profileId !== req.profileId) return false;
      if (rule.scope.role !== undefined && rule.scope.role !== req.role) return false;
    }

    if (rule.when) {
      if (rule.when.commandEquals !== undefined) {
        const command = extractCommandFromInput(req.input);
        if (command === undefined) return false; // 猜不到指令 → 不 match(不 fail-open)。
        if (command.trim() !== rule.when.commandEquals.trim()) return false;
      }

      if (rule.when.commandMatches !== undefined) {
        const command = extractCommandFromInput(req.input);
        if (command === undefined) return false;
        // 強制 `^...$` 完整匹配——避免 `npm test` 這種 pattern 意外放行
        // `npm test; rm -rf /`(見 core-config.ts 的 `commandMatches` 註解)。
        let anchored: RegExp;
        try {
          anchored = new RegExp(`^(?:${rule.when.commandMatches})$`);
        } catch {
          return false; // 使用者寫的 regex 本身無效——視為不 match,不拋錯中斷決策。
        }
        if (!anchored.test(command.trim())) return false;
      }

      if (rule.when.pathUnder !== undefined) {
        const candidates = extractPathCandidates(req.input);
        if (candidates.length === 0) return false; // 猜不到路徑 → 不 match。
        const boundary = resolveRealpathBestEffort(rule.when.pathUnder, req.workingDir);
        const allUnder = candidates.every((rawPath) => {
          const resolved = resolveRealpathBestEffort(rawPath, req.workingDir);
          return isPathUnder(resolved, boundary);
        });
        if (!allUnder) return false;
      }
    }

    return true;
  }
}

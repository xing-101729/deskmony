#!/usr/bin/env node
/**
 * scripts/e2e-policy-engine.mjs
 *
 * S1(PolicyEngine + Enforcement 底座)的端到端/單元驗證,對應
 * docs/LAYER-4-detail-design/policy-engine_detail.md §8 檢查清單最後一項。
 *
 * 分兩部分:
 *   Part 1(單元測試,不啟動 core process):直接 import 編譯後的
 *     apps/core/dist/permissions/policy-engine.js / hard-deny.js,測試
 *     `decide()` 的優先序、比對規則細節,以及 `ExecContext` 各種組合下的
 *     hard-deny 行為(直接餵 ExecContext,不需要真實 gateway 造出該情境)。
 *   Part 2(即時 e2e,透過真實 WS Gateway + fake ACP agent):驗證整合點
 *     本身接得對——allow/deny 自動放行完全不進 waiting、hard-deny 在
 *     「本機+attended」降級為 escalate-strong(仍走 waiting)、hard-deny 在
 *     autoMode 開啟時直接 deny(不進 waiting)、未分類長尾 escalate、
 *     **無 client 連線(無人值守)時 escalate 掛起且不因逾時被 deny**、
 *     有 client 連線時逾時仍 deny、決策落地 enforcement_audit 表。
 *
 * S7 L4 §2.1(2026-07-28 設計修正)之後,`attended` 由「**是否有 client 連線
 * 中**」推導,不再是 `autoMode` 的補數——Part 2 的 2f/2g 就是這個 2×2 的兩個
 * 「未開 auto」象限,靠真的把 WS 連線關掉/接著來製造,不偽造任何欄位。
 *
 * 2026-08-25 新增(見 docs/DECISIONS.md §G):Part 1 的 1j/1k 驗證
 * `ctx.trueUnrestricted` 在 `decide()` 最開頭的短路(唯一能跳過 hard-deny 的
 * 路徑),1l/1m 驗證 `PolicyEngine.removeRule()`/`getRules()` 這兩個新方法的
 * in-memory 規則管理語意;Part 2 的 2i 驗證啟動時 `backfillPolicyRuleIds()`
 * 幫舊規則(config.json 裡沒有 `id` 的)補 id 並整批寫回檔案這條路徑。
 * `session.setTrueUnrestricted`/`policy.addRule`/`removeRule`/`listRules` 這幾個
 * gateway RPC 本身(含遠端可達性、前置條件、YOLO 過期連帶清除)的即時 e2e 驗證
 * 在 scripts/e2e-auto-mode-yolo.mjs(該檔案的 E-6/E-7/J/D2),不在這裡重複。
 *
 * 2026-10-02(P2:移除 profile,見 docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P2.8,
 * **安全項目**):Part 1 的 1n/1o/1p/1q 與 Part 3 驗證權限規則的「舊 profile 範圍」——
 *   ①帶舊範圍(`scope.profileId`/`scope.role`)的 allow 規則不再放行(升級給人);
 *   ②帶舊範圍的 deny 規則在 auto 模式下對**任何** session 仍然 deny(否則 deny 規則靜默失效,在 auto
 *     模式下那個操作會落入「未分類中間地帶自動放行」,等於 fail-open);
 *   ③`scope.providerId` 只對該 agent 的 session 生效(Part 3 另外用真的 core + fake ACP provider 驗證
 *     `PermissionRequest.providerId` 確實從 session 一路帶進引擎);
 *   另外 core 啟動時對每一條帶舊範圍的規則 console.warn(不靜默),且 `policy.addRule` 不再接受舊範圍。
 *
 * 前置需求:`pnpm build` 已跑過(apps/core/dist、packages/db/dist 存在)。
 *
 * 用法:node scripts/e2e-policy-engine.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WRITE_FILE_PREFIX } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";

// 2026-09-04(稽核修補):在啟動 core 之前確認 dist/ 不比 src/ 舊。
// 這支 e2e 測的是編譯產物,忘記先 pnpm build 的話會安靜地驗證舊程式碼並全綠
// —— 見 scripts/lib/require-fresh-build.mjs 的完整說明。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function log(msg) {
  console.log(msg);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =======================================================================
// Part 1:單元測試(直接 import 編譯後的模組,不啟動 core process)
// =======================================================================
async function unitTests() {
  const policyEngineMod = await import(
    pathToFileURL(path.join(REPO_ROOT, "apps", "core", "dist", "permissions", "policy-engine.js")).href
  );
  const { PolicyEngine } = policyEngineMod;

  const workingDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-unit-ws-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-unit-outside-"));

  const baseReq = (overrides) => ({
    sessionId: "s1",
    requestId: randomUUID(),
    toolName: "Write",
    input: { file_path: path.join(workingDir, "ok.txt"), content: "x" },
    workingDir,
    ...overrides,
  });

  // ---- 1a: 空政策 + 未分類 → escalate(default-deny) ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "SomeUnknownTool", input: {} }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    record(
      "1a 空政策 + 未分類工具 → escalate(default-deny)",
      decision.effect === "escalate",
      `effect=${decision.effect}, reason=${decision.reason}`,
    );
  }

  // ---- 1b:config allow 規則命中 → allow ----
  {
    const engine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandEquals: "pnpm test" }, effect: "allow" }],
      allowedHosts: [],
    });
    const decision = engine.decide(
      baseReq({ toolName: "Bash", input: { command: "pnpm test" } }),
      { attended: true, local: true, autoMode: false },
    );
    record("1b config allow 規則(commandEquals 完整比對)命中 → allow", decision.effect === "allow", `effect=${decision.effect}`);
  }

  // ---- 1c:commandMatches 自動包 ^...$,「npm test」規則不得放行「npm test; rm -rf /」----
  {
    const engine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandMatches: "npm test" }, effect: "allow" }],
      allowedHosts: [],
    });
    const safeDecision = engine.decide(baseReq({ toolName: "Bash", input: { command: "npm test" } }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    const dangerDecision = engine.decide(
      baseReq({ toolName: "Bash", input: { command: "npm test; rm -rf /" } }),
      { attended: true, local: true, autoMode: false },
    );
    record(
      "1c commandMatches 強制 ^...$ 完整匹配:「npm test」放行,但不放行「npm test; rm -rf /」",
      safeDecision.effect === "allow" && dangerDecision.effect !== "allow",
      `safe=${safeDecision.effect}, danger=${dangerDecision.effect}(danger 應為 escalate,不可為 allow)`,
    );
  }

  // ---- 1d:pathUnder 以路徑分隔符為界,`/a/b` 不得比對到 `/a/bc` ----
  {
    const boundaryDir = path.join(workingDir, "a", "b");
    mkdirSync(boundaryDir, { recursive: true });
    const siblingDir = path.join(workingDir, "a", "bc");
    mkdirSync(siblingDir, { recursive: true });

    const engine = new PolicyEngine({
      rules: [{ tool: "Write", when: { pathUnder: boundaryDir }, effect: "allow" }],
      allowedHosts: [],
    });
    const insideDecision = engine.decide(
      baseReq({ toolName: "Write", input: { file_path: path.join(boundaryDir, "f.txt") } }),
      { attended: true, local: true, autoMode: false },
    );
    const siblingDecision = engine.decide(
      baseReq({ toolName: "Write", input: { file_path: path.join(siblingDir, "f.txt") } }),
      { attended: true, local: true, autoMode: false },
    );
    record(
      "1d pathUnder 以路徑分隔符為界:.../a/b 下的檔案 allow,.../a/bc(同前綴但非子目錄)不 allow",
      insideDecision.effect === "allow" && siblingDecision.effect !== "allow",
      `inside=${insideDecision.effect}, sibling=${siblingDecision.effect}(sibling 應為 escalate)`,
    );
  }

  // ---- 1e:規則依序比對,第一個 match 決定(deny 排在前面優先於後面的 allow)----
  {
    const engine = new PolicyEngine({
      rules: [
        { tool: "Write", when: { pathUnder: workingDir }, effect: "deny" },
        { tool: "Write", when: { pathUnder: workingDir }, effect: "allow" },
      ],
      allowedHosts: [],
    });
    const decision = engine.decide(baseReq(), { attended: true, local: true, autoMode: false });
    record(
      "1e 規則陣列順序決定優先序:deny 規則排前面時,即使後面有更寬鬆的 allow 規則也是 deny",
      decision.effect === "deny" && decision.matchedRule === 0,
      `effect=${decision.effect}, matchedRule=${decision.matchedRule}`,
    );
  }

  // ---- 1f:hard-deny(worktree 外寫入)命中時,即使 autoMode=true 也絕不 allow ----
  //         四種 ExecContext 組合一次驗完(單元層級最省事;其中幾種也在 Part 2
  //         以真實連線狀態驗證,見 2c/2d 與 e2e-auto-mode-yolo 的 E-4)。
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const escapeReq = baseReq({ toolName: "Write", input: { file_path: path.join(outsideDir, "escape.txt") } });

    const remoteOrAutoDecision = engine.decide(escapeReq, { attended: true, local: false, autoMode: true });
    const localAutoDecision = engine.decide(escapeReq, { attended: true, local: true, autoMode: true });
    const localAttendedDecision = engine.decide(escapeReq, { attended: true, local: true, autoMode: false });
    const localUnattendedDecision = engine.decide(escapeReq, { attended: false, local: true, autoMode: false });

    const ok =
      remoteOrAutoDecision.effect === "deny" &&
      localAutoDecision.effect === "deny" && // 本機+attended 但 autoMode=true → 仍硬 deny,autoMode 優先於 attended
      localAttendedDecision.effect === "escalate-strong" && // 唯一能降級的組合(本機+attended+非 autoMode)
      localUnattendedDecision.effect === "deny"; // 保守:本機但沒人看 → 硬 deny(實作當下的自行判斷,repo 外無紀錄)

    record(
      "1f hard-deny(worktree 外寫入)命中時,任何 autoMode/遠端組合都絕不 allow;只有「本機+attended」降級為 escalate-strong",
      ok,
      `remote-or-auto=${remoteOrAutoDecision.effect}, local+autoMode=${localAutoDecision.effect}, ` +
        `local+attended=${localAttendedDecision.effect}, local+unattended=${localUnattendedDecision.effect}`,
    );
  }

  // ---- 1g:autoMode 中間地帶自動放行,但不影響 hard-deny/config deny 優先序 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "SomeUnknownTool", input: {} }), {
      attended: false,
      local: true,
      autoMode: true,
    });
    record(
      "1g autoMode=true 時,未分類長尾(非 hard-deny)自動放行",
      decision.effect === "allow",
      `effect=${decision.effect}`,
    );
  }

  // ---- 1h:input 猜不到路徑/指令(判定失敗)→ 不 hard-deny、不 allow,落到 escalate ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "Write", input: { totallyUnknownField: 123 } }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    record(
      "1h 猜不到路徑欄位(判定失敗)→ escalate(不 fail-open 成 allow,也不誤判成 hard-deny)",
      decision.effect === "escalate",
      `effect=${decision.effect}`,
    );
  }

  // ---- 1i:S7 L4 §2.1 修正的核心——`attended` 與 `autoMode` 正交,
  //          「無人值守 + 未開 auto」這個象限必須落到 escalate(而不是被自動
  //          放行)。修正前這個組合根本不可能出現(attended 是 autoMode 的
  //          補數),第 5 步的 escalate + S1 L4 §6 的「不逾時 deny」因此變成
  //          死碼——這條斷言就是在守住那個象限不再被消滅。 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const req = baseReq({ toolName: "SomeUnknownTool", input: {} });
    const unattendedNoAuto = engine.decide(req, { attended: false, local: true, autoMode: false });
    const unattendedWithAuto = engine.decide(req, { attended: false, local: true, autoMode: true });
    const attendedNoAuto = engine.decide(req, { attended: true, local: true, autoMode: false });
    const attendedWithAuto = engine.decide(req, { attended: true, local: true, autoMode: true });

    record(
      "1i attended × autoMode 的 2×2 完整可達(S7 L4 §2.1 修正):未開 auto 時,不論有沒有人在,未分類請求都是 escalate;開了 auto 才自動放行",
      unattendedNoAuto.effect === "escalate" &&
        attendedNoAuto.effect === "escalate" &&
        unattendedWithAuto.effect === "allow" &&
        attendedWithAuto.effect === "allow",
      `unattended+noAuto=${unattendedNoAuto.effect}(必須是 escalate,這是被救回來的象限), ` +
        `attended+noAuto=${attendedNoAuto.effect}, unattended+auto=${unattendedWithAuto.effect}, attended+auto=${attendedWithAuto.effect}`,
    );
  }

  // ---- 1j【2026-08-25 新增,docs/DECISIONS.md §G】:`ctx.trueUnrestricted`
  //         繞過 hard-deny——即使是整個矩陣裡「最嚴」的組合(遠端/`local:false`
  //         + `attended:true` + `autoMode:false`。這個組合原本連 attended 都
  //         救不了:decide() 第 1 步一看到 `!ctx.local` 就直接 deny,見 1f 的
  //         remote-or-auto 案例,連降級成 escalate-strong 的機會都沒有),一樣
  //         被繞過變成 allow——證明第 0 步短路確實排在 checkHardDeny() 呼叫
  //         之前,而不是塞進 hard-deny 分支裡的某個條件判斷。 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const escapeReq = baseReq({ toolName: "Write", input: { file_path: path.join(outsideDir, "true-unrestricted-hard-deny.txt") } });

    const withoutBypass = engine.decide(escapeReq, { attended: true, local: false, autoMode: false });
    const withBypass = engine.decide(escapeReq, { attended: true, local: false, autoMode: false, trueUnrestricted: true });

    record(
      "1j trueUnrestricted=true 繞過 hard-deny——矩陣裡最嚴的組合(遠端+非autoMode,原本連 attended 都救不了、直接 deny)一樣變成 allow",
      withoutBypass.effect === "deny" && withBypass.effect === "allow",
      `withoutBypass(無 trueUnrestricted)=${withoutBypass.effect}, withBypass(trueUnrestricted:true)=${withBypass.effect}`,
    );
  }

  // ---- 1k:`trueUnrestricted` 不是 hard-deny 專屬的特殊處理——完全沒命中
  //         hard-deny/config 規則、原本會落到第 5 步 escalate(default-deny)
  //         的未分類長尾,一樣直接變成 allow,證明短路在 decide() 最開頭就已經
  //         return,不分請求種類。 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const req = baseReq({ toolName: "SomeUnknownTool", input: {} });

    const withoutBypass = engine.decide(req, { attended: true, local: true, autoMode: false });
    const withBypass = engine.decide(req, { attended: true, local: true, autoMode: false, trueUnrestricted: true });

    record(
      "1k trueUnrestricted=true 不只繞過 hard-deny——原本會落到 escalate(default-deny)的未分類長尾也一樣直接 allow,證明短路在函式最開頭、不分請求種類",
      withoutBypass.effect === "escalate" && withBypass.effect === "allow",
      `withoutBypass(無 trueUnrestricted)=${withoutBypass.effect}, withBypass(trueUnrestricted:true)=${withBypass.effect}`,
    );
  }

  // ---- 1l【2026-08-25 新增】:`PolicyEngine.removeRule()`——依 id 移除中間一條
  //         規則,其餘規則保留且相對順序不變;移除不存在的 id 回傳
  //         `undefined`,不拋例外(見該方法註解:呼叫端可能與另一個 client 並行
  //         操作同一份清單)。 ----
  {
    const rules = [
      { id: "rule-a", tool: "Bash", effect: "allow" },
      { id: "rule-b", tool: "Write", effect: "deny" },
      { id: "rule-c", tool: "Read", effect: "allow" },
    ];
    const engine = new PolicyEngine({ rules, allowedHosts: [] });

    const removed = engine.removeRule("rule-b");
    const afterRemove = engine.getRules();
    const orderPreserved = afterRemove.length === 2 && afterRemove[0].id === "rule-a" && afterRemove[1].id === "rule-c";

    let removeNonexistentThrew = false;
    let removedNonexistent;
    try {
      removedNonexistent = engine.removeRule("does-not-exist");
    } catch {
      removeNonexistentThrew = true;
    }

    record(
      "1l PolicyEngine.removeRule():依 id 移除中間一條規則,其餘兩條保留且相對順序不變;移除不存在的 id 回傳 undefined、不拋例外",
      removed?.id === "rule-b" &&
        removed?.tool === "Write" &&
        orderPreserved &&
        !removeNonexistentThrew &&
        removedNonexistent === undefined,
      `removed=${JSON.stringify(removed)}, afterRemove=${JSON.stringify(afterRemove)}, removeNonexistentThrew=${removeNonexistentThrew}, removedNonexistent=${removedNonexistent}`,
    );
  }

  // ---- 1m【2026-08-25 新增】:`PolicyEngine.getRules()` 回傳目前規則陣列的
  //         淺拷貝,不外洩內部可變陣列的參照——mutate 回傳值(push/清空)不得
  //         影響引擎的內部狀態,下次呼叫 getRules() 仍要回報原本的規則。 ----
  {
    const rules = [
      { id: "rule-x", tool: "Bash", effect: "allow" },
      { id: "rule-y", tool: "Write", effect: "deny" },
    ];
    const engine = new PolicyEngine({ rules, allowedHosts: [] });

    const firstCopy = engine.getRules();
    firstCopy.push({ id: "injected", tool: "*", effect: "deny" });
    firstCopy.length = 0; // 更進一步:連清空回傳值都不該影響內部狀態(不是同一個陣列參照)

    const secondCopy = engine.getRules();

    record(
      "1m PolicyEngine.getRules() 回傳淺拷貝——外部 mutate(push/清空)回傳的陣列不影響引擎內部狀態,下次呼叫仍回報原本兩條規則",
      secondCopy.length === 2 && secondCopy[0].id === "rule-x" && secondCopy[1].id === "rule-y",
      `firstCopy(mutate 後)=${JSON.stringify(firstCopy)}, secondCopy=${JSON.stringify(secondCopy)}`,
    );
  }

  // ---- 1n【2026-10-02 P2.8 斷言①】:帶舊 profile 範圍的 **allow** 規則不再放行(原本放行的改成升級給人)。
  //         profileId 範圍與 role 範圍各測一次;對照組:同一條規則去掉舊範圍就會 allow。 ----
  {
    const ctx = { attended: true, local: true, autoMode: false };
    const req = baseReq({ toolName: "Bash", input: { command: "pnpm test" }, providerId: "claude-agent-sdk" });
    const mk = (scope) => new PolicyEngine({ rules: [{ tool: "Bash", when: { commandEquals: "pnpm test" }, effect: "allow", ...(scope ? { scope } : {}) }], allowedHosts: [] });
    const control = mk(undefined).decide(req, ctx);
    const legacyProfile = mk({ profileId: "removed-profile" }).decide(req, ctx);
    const legacyRole = mk({ role: "Coder" }).decide(req, ctx);
    // 就算請求帶著「看起來吻合」的欄位也不行——profile 已不存在,舊範圍沒有任何對應物。
    const legacyAnyway = mk({ profileId: "removed-profile" }).decide({ ...req, profileId: "removed-profile", role: "Coder" }, ctx);
    record(
      "1n 舊 profile 範圍(profileId/role)的 allow 規則一律不匹配 → 升級給人(escalate);同一條規則沒有舊範圍時才是 allow(對照組)",
      control.effect === "allow" &&
        legacyProfile.effect === "escalate" &&
        legacyRole.effect === "escalate" &&
        legacyAnyway.effect === "escalate",
      `control=${control.effect}, legacyProfile=${legacyProfile.effect}, legacyRole=${legacyRole.effect}, legacyAnyway=${legacyAnyway.effect}`,
    );
  }

  // ---- 1o【P2.8 斷言②,關鍵 fail-open 防護】:帶舊 profile 範圍的 **deny** 規則忽略舊範圍、對所有 session
  //         匹配——autoMode 下對**任何** session(任何 providerId、沒有 providerId)都仍然 deny,絕不落入
  //         「未分類中間地帶自動放行」。對照組:同一個請求沒有 deny 規則時,autoMode 會自動放行。 ----
  {
    const autoCtx = { attended: true, local: true, autoMode: true };
    const req = baseReq({ toolName: "Bash", input: { command: "rm -rf build" } });
    const rule = (scope) => ({ tool: "Bash", when: { commandEquals: "rm -rf build" }, effect: "deny", scope });
    const noRule = new PolicyEngine({ rules: [], allowedHosts: [] }).decide(req, autoCtx);
    const byProfile = new PolicyEngine({ rules: [rule({ profileId: "removed-profile" })], allowedHosts: [] });
    const byRole = new PolicyEngine({ rules: [rule({ role: "Coder" })], allowedHosts: [] });
    const sessions = [{ providerId: "claude-agent-sdk" }, { providerId: "codex" }, { providerId: "opencode" }, {}];
    const outcomes = [];
    for (const engine of [byProfile, byRole]) {
      for (const extra of sessions) outcomes.push(engine.decide({ ...req, ...extra }, autoCtx).effect);
    }
    // 無人值守(非 attended)+ autoMode 也一樣。
    const unattended = byProfile.decide({ ...req, providerId: "codex" }, { attended: false, local: true, autoMode: true }).effect;
    record(
      "1o 舊 profile 範圍的 deny 規則在 auto 模式下對任何 session 仍然 deny(忽略舊範圍、全部套用);對照組:沒有這條規則時 auto 模式會自動放行(這正是要防的 fail-open)",
      noRule.effect === "allow" && outcomes.every((e) => e === "deny") && unattended === "deny",
      `noRule(auto)=${noRule.effect}, outcomes=${JSON.stringify(outcomes)}, unattended=${unattended}`,
    );
  }

  // ---- 1p【P2.8 斷言③】:`scope.providerId` 精確比對——只對該 agent 的 session 生效,其他 agent 與沒帶 providerId 的請求都不匹配。 ----
  {
    const ctx = { attended: true, local: true, autoMode: false };
    const req = baseReq({ toolName: "Bash", input: { command: "pnpm test" } });
    const allowEngine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandEquals: "pnpm test" }, effect: "allow", scope: { providerId: "codex" } }],
      allowedHosts: [],
    });
    const forCodex = allowEngine.decide({ ...req, providerId: "codex" }, ctx).effect;
    const forSdk = allowEngine.decide({ ...req, providerId: "claude-agent-sdk" }, ctx).effect;
    const forNone = allowEngine.decide(req, ctx).effect;
    // deny 範圍同理:只擋 codex;auto 模式下其他 agent 仍走自動放行(證明範圍真的在起作用,不是變成全擋)。
    const denyEngine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandEquals: "pnpm test" }, effect: "deny", scope: { providerId: "codex" } }],
      allowedHosts: [],
    });
    const autoCtx = { attended: true, local: true, autoMode: true };
    const denyCodex = denyEngine.decide({ ...req, providerId: "codex" }, autoCtx).effect;
    const denySdk = denyEngine.decide({ ...req, providerId: "claude-agent-sdk" }, autoCtx).effect;
    record(
      "1p scope.providerId 精確比對:allow 只對該 agent 放行(其他 agent/無 providerId 升級);deny 只擋該 agent(其他 agent 在 auto 模式下仍自動放行)",
      forCodex === "allow" && forSdk === "escalate" && forNone === "escalate" && denyCodex === "deny" && denySdk === "allow",
      `allow: codex=${forCodex}, sdk=${forSdk}, none=${forNone}; deny(auto): codex=${denyCodex}, sdk=${denySdk}`,
    );
  }

  // ---- 1q【P2.8】:`warnLegacyScopedRules()` 對每一條帶舊範圍的規則逐條 console.warn(含規則 id 與處理方式),
  //         沒有舊範圍的規則(含 providerId 範圍)不產生警告——不靜默。 ----
  {
    const rules = [
      { id: "r-legacy-deny", tool: "Bash", effect: "deny", scope: { profileId: "p1" } },
      { id: "r-legacy-allow", tool: "Bash", effect: "allow", scope: { role: "Coder" } },
      { id: "r-provider", tool: "Bash", effect: "allow", scope: { providerId: "codex" } },
      { id: "r-plain", tool: "Bash", effect: "allow" },
    ];
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    let legacy;
    try {
      legacy = policyEngineMod.warnLegacyScopedRules(rules);
    } finally {
      console.warn = originalWarn;
    }
    const denyLine = warns.find((w) => w.includes("r-legacy-deny"));
    const allowLine = warns.find((w) => w.includes("r-legacy-allow"));
    record(
      "1q warnLegacyScopedRules():逐條 console.warn 帶舊範圍的規則(含 id 與處理方式:allow=已停用、deny=套用全部),providerId 範圍/無範圍的規則不警告",
      legacy.length === 2 &&
        warns.length === 2 &&
        Boolean(denyLine) &&
        denyLine.includes("所有 session") &&
        Boolean(allowLine) &&
        allowLine.includes("已停用") &&
        !warns.some((w) => w.includes("r-provider") || w.includes("r-plain")),
      `warns=${JSON.stringify(warns)}`,
    );
  }

  rmSync(workingDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}

// =======================================================================
// Part 2:即時 e2e(真實 WS Gateway + fake ACP agent + 真實 SQLite 稽核表)
// =======================================================================

class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.sessionUpdates = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error: ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error ?? "unknown gateway error"));
      }
      return;
    }
    if (msg.kind === "event") {
      if (msg.channel === "session-event") {
        this.events.push(msg.payload);
        for (const w of [...this.waiters]) w(msg.payload);
      } else if (msg.channel === "session-updated") {
        this.sessionUpdates.push(msg.payload);
      } else if (msg.channel === "permission-resolved") {
        this.permissionResolvedEvents = this.permissionResolvedEvents ?? [];
        this.permissionResolvedEvents.push(msg.payload);
      }
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < this.events.length; i++) {
      if (predicate(this.events[i])) return Promise.resolve(this.events[i]);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待事件逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = (ev) => {
        if (predicate(ev)) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(ev);
        }
      };
      this.waiters.push(waiter);
    });
  }
}

function startCore({ port, dataDir, homeDir, workspaceDir, permissionTimeoutMs }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_PERMISSION_TIMEOUT_MS: String(permissionTimeoutMs),
    // 2026-10-02(P2:移除 profile):fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
    ...e2eProvidersEnv(),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
  return proc;
}

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("connect error"));
        });
      });
      ws.close();
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

async function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
  await sleep(500);
}

async function liveE2e() {
  const PORT = 4331;
  const PERMISSION_TIMEOUT_MS = 3000; // 縮短逾時,測試「attended 才逾時」用
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-ws-"));
  const outsideWorktreeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-outside-"));

  const allowedSubDir = path.join(workspaceDir, "allowed-sub");
  const deniedSubDir = path.join(workspaceDir, "denied-sub");
  const unclassifiedSubDir = path.join(workspaceDir, "unclassified-sub");
  mkdirSync(allowedSubDir, { recursive: true });
  mkdirSync(deniedSubDir, { recursive: true });
  mkdirSync(unclassifiedSubDir, { recursive: true });

  // 這輪測試唯一使用到的 policy 規則:deny 規則放在陣列前端(比照「寫入時
  // unshift」的既有慣例),allow 規則放後面——驗證「第一個 match 決定」不會
  // 被陣列順序以外的邏輯干擾。fake-acp-agent 的 Write 工具 toolName 是固定的
  // 人類標題 "Write file"(見 acp-adapter.ts),用 pathUnder 區分 allow/deny。
  const configJson = {
    version: 1,
    policy: {
      rules: [
        { tool: "Write file", when: { pathUnder: deniedSubDir }, effect: "deny" },
        { tool: "Write file", when: { pathUnder: allowedSubDir }, effect: "allow" },
      ],
      allowedHosts: [],
    },
  };
  writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(configJson, null, 2), "utf8");

  let coreProc;
  let client;
  // S7 L4 §2.1 之後,session 的權限模式只決定 `ExecContext.autoMode`,**不再**決定 `attended`——
  // 後者只看「現在有沒有 client 連線中」。所以「always-ask 的 session」與「開著 auto 的 session」
  // 的差別純粹是 autoMode 開/關。2026-10-02(P2:移除 profile):新 session 一律從 always-ask
  // 開始(autoMode = false);要「開著 auto 的 session」就在建立後呼叫 `session.setPermissionMode`
  // (原本是用 profile.permissionLevel = "auto-accept-edits" 當初值)。
  const createdSessions = [];
  const createSessionFor = async (title, { autoMode = false } = {}) => {
    const created = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: workspaceDir, title }, 30_000);
    createdSessions.push(created.session.id);
    if (autoMode) {
      await client.rpc("session.setPermissionMode", { sessionId: created.session.id, mode: "auto-accept-edits" });
    }
    return created.session.id;
  };

  /** 只送出寫檔 prompt,**不**等待 permission-request(2f 用:送出後要先把
   *  WS 連線關掉,讓權限請求在「沒有任何 client 連線」的狀態下抵達 core)。
   *  `delayMs` 由 fake-acp-agent 端消化,見該檔案的 handleWriteFile()。 */
  const sendWritePrompt = async (sessionId, targetPath, { content = "content", delayMs } = {}) => {
    const posixPath = targetPath.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", {
      sessionId,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content, ...(delayMs ? { delayMs } : {}) })}` },
    });
  };

  /** 送出一個會觸發 permission-request 的寫檔 prompt,回傳 { requestId, event }。 */
  const triggerWritePermission = async (sessionId, targetPath, content = "content") => {
    const startIdx = client.events.length;
    const posixPath = targetPath.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content })}` } });
    const ev = await client.waitForEvent(
      (e) => e.sessionId === sessionId && e.event.type === "permission-request",
      15_000,
      startIdx,
    );
    return ev.event;
  };

  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(`ws://localhost:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://localhost:${PORT}`);
    await client.connect();

    // ---- 2a: config allow 規則命中 → 自動放行,完全不進 waiting,source="policy" ----
    {
      const sessionId = await createSessionFor("2a-allow");
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(allowedSubDir, "allow-me.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile, "allow content");

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300); // 讓 permission-resolved / session-updated 推播都送達

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "allow" && r.source === "policy",
      );
      const fileWritten = existsSync(targetFile);

      record(
        "2a config allow 規則:自動放行、完全不進 waiting、permission-resolved.source=\"policy\"、檔案確實寫入",
        !wentWaiting && resolvedPolicy && fileWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileWritten=${fileWritten}`,
      );
    }

    // ---- 2b: config deny 規則命中 → 自動拒絕,完全不進 waiting,不寫檔 ----
    {
      const sessionId = await createSessionFor("2b-deny");
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(deniedSubDir, "deny-me.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile, "deny content");

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300);

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2b config deny 規則:自動拒絕、完全不進 waiting、permission-resolved.source=\"policy\"、檔案未寫入",
        !wentWaiting && resolvedPolicy && fileNotWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2c: hard-deny(worktree 外寫入)+ 本機 + attended → escalate-strong,
    //          仍走 waiting(不是自動 deny,人可以強確認),手動 resolve 清理 ----
    {
      const sessionId = await createSessionFor("2c-harddeny-attended");
      const targetFile = path.join(outsideWorktreeDir, "escape-attended.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const wentWaiting = session?.status === "waiting";

      await client.rpc("permission.resolve", { sessionId, requestId: permEvent.requestId, decision: "deny" });
      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2c hard-deny(worktree 外寫入)+ 本機 + attended → escalate-strong,走 waiting(唯一能人工強確認的組合)",
        wentWaiting && fileNotWritten,
        `wentWaiting=${wentWaiting}(session.status=${session?.status}), fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2d: hard-deny(worktree 外寫入)+ 本機 + autoMode 開啟 → 直接 deny,
    //          不進 waiting。**autoMode 優先於 attended**:即使此刻有 client
    //          連著(attended=true),開了 auto 就不降級成 escalate-strong
    //          (C6:auto 開著時硬性類仍是硬地板,見 policy-engine.ts 第 1 步)。
    //          S7 L4 §2.1 修正前這條測的是「非 attended」,修正後 attended 不
    //          再由權限模式決定,同一個 session 改由 autoMode 這條分支命中。 ----
    {
      const sessionId = await createSessionFor("2d-harddeny-automode", { autoMode: true });
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(outsideWorktreeDir, "escape-automode.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300);

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2d hard-deny(worktree 外寫入)+ 本機 + autoMode 開啟 → 直接 deny(不降級為 escalate-strong),不進 waiting",
        !wentWaiting && resolvedPolicy && fileNotWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2e: 未分類長尾(非 hard-deny、無 config 規則命中)→ escalate,走 waiting ----
    {
      const sessionId = await createSessionFor("2e-escalate-unclassified");
      const targetFile = path.join(unclassifiedSubDir, "unclassified.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const wentWaiting = session?.status === "waiting";

      await client.rpc("permission.resolve", { sessionId, requestId: permEvent.requestId, decision: "deny" });
      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );

      record(
        "2e 未分類長尾(不命中 hard-deny/config 規則)→ escalate,走 waiting",
        wentWaiting,
        `session.status(升級當下)=${session?.status}`,
      );
    }

    // ---- 2f【S7 L4 §2.1 修正後救回來的象限】:**無 client 連線 + 未開 auto**
    //          → 未分類請求走 escalate 掛起等人,且**不因逾時被 deny**
    //          (S1 L4 §6 / S11 §4:「沒人回應 ≠ 拒絕」,不該讓整晚工作白費)。
    //
    //          修正前這個象限根本不存在(attended 是 autoMode 的補數 ⇒
    //          attended=false 必然 autoMode=true ⇒ 未分類請求在 decide() 第 4
    //          步就被自動放行),`PermissionGateway.register(timeoutMs=null)`
    //          那條分支因此是死碼。這裡誠實地把 WS 連線**真的關掉**來製造
    //          「沒人看得到彈窗」——不偽造任何欄位,因為連線狀態就是 attended
    //          的唯一判定來源(見 ws-gateway.ts 的 hasConnectedClient())。
    //
    //          時序:sendPrompt(帶 delayMs)→ 立刻關閉 WS → fake agent 延遲後
    //          才送出權限請求 ⇒ decide() 當下 hasConnectedClient() === false。
    {
      const PROMPT_DELAY_MS = 2500;
      const sessionId = await createSessionFor("2f-unattended-hangs");
      const targetFile = path.join(unclassifiedSubDir, "unattended-hangs.txt");
      await sendWritePrompt(sessionId, targetFile, { delayMs: PROMPT_DELAY_MS });

      // 關閉唯一的 client 連線,並確認 core 端真的處理完 close(留餘裕)。
      client.close();
      await sleep(500);

      // 等到「權限請求已抵達 + 遠超過 attended 的逾時時間」都過去為止。若
      // 修正沒生效(仍設了計時器),這段時間內就會被逾時 deny。
      await sleep(PROMPT_DELAY_MS + PERMISSION_TIMEOUT_MS + 2500);

      // 重新連上,直接看 DB 裡的 session 狀態(逾時 deny 會把它推回 busy →
      // completed/idle,所以「仍是 waiting」就是「沒有被逾時 deny」的鐵證)。
      client = new MiniGatewayClient(`ws://localhost:${PORT}`);
      await client.connect();
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const stillWaiting = session?.status === "waiting";
      const fileNotWritten = !existsSync(targetFile);

      record(
        "【修正後救回的象限】2f 無 client 連線(無人值守)+ 未開 auto:未分類請求走 escalate 掛起,超過逾時時間仍維持 waiting——不因沒人回應而被 deny",
        stillWaiting && fileNotWritten,
        `stillWaiting=${stillWaiting}(session.status=${session?.status},等了 ${PROMPT_DELAY_MS + PERMISSION_TIMEOUT_MS + 3000}ms,逾時設定=${PERMISSION_TIMEOUT_MS}ms), fileNotWritten=${fileNotWritten}`,
      );
      // 這筆 pending 請求刻意不 resolve(它就該一直掛著)——直接刪 session
      // 清理,adapter handle 會一併 dispose。
      await client.rpc("session.delete", { sessionId }).catch(() => {});
    }

    // ---- 2g(2f 的對照組,既有行為不可退步):**有 client 連線 + 未開 auto**
    //          → 逐筆問,逾時 5 分鐘(這裡縮短為 PERMISSION_TIMEOUT_MS)後
    //          deny。與 2f 唯一的差別就是「此刻有沒有人看得到彈窗」。 ----
    {
      const sessionId = await createSessionFor("2g-attended-timeout-deny");
      const targetFile = path.join(unclassifiedSubDir, "attended-timeout.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listDuring = await client.rpc("session.list", {});
      const wentWaiting = listDuring.sessions.find((s) => s.id === sessionId)?.status === "waiting";

      // 刻意不回應,等逾時自動 deny(source="timeout")。
      await sleep(PERMISSION_TIMEOUT_MS + 1500);
      const timedOutDeny = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "timeout",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2g 有 client 連線(attended)+ 未開 auto:未分類請求走 escalate(waiting),逾時未回應 → 自動 deny(source=\"timeout\"),既有行為不變",
        wentWaiting && timedOutDeny && fileNotWritten,
        `wentWaiting=${wentWaiting}, timedOutDeny=${timedOutDeny}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2i【2026-08-25 新增,docs/DECISIONS.md §G】:啟動時的 id backfill
    //          ——這個檔案最上面寫入的 configJson 兩條規則(deny/allow)刻意都
    //          沒有帶 `id`(比照這個欄位新增前就已存在的舊資料)。core 啟動時
    //          `apps/core/src/index.ts` 呼叫 `backfillPolicyRuleIds()` 補上
    //          `randomUUID()` 並整批寫回 config.json(見
    //          apps/core/src/config/config-file-writer.ts)。這裡用已經連上的
    //          live client 驗證兩件事:`policy.listRules` 回傳的規則都已經有
    //          id(in-memory PolicyEngine 那份),以及 config.json 檔案本身也
    //          真的被重寫(不只是 in-memory 補上而已)。刻意放在 try 區塊尾端
    //          (2g 之後)而不是連線後立刻驗證,純粹是行文方便——這個檔案的
    //          Part 2 沒有任何測試會呼叫 addRule/rememberRule 改動規則陣列,
    //          放哪裡驗證結果都一樣。 ----
    {
      const listResult = await client.rpc("policy.listRules", {});
      const rules = listResult.rules ?? [];
      const deniedRule = rules.find((r) => r.when?.pathUnder === deniedSubDir && r.effect === "deny");
      const allowedRule = rules.find((r) => r.when?.pathUnder === allowedSubDir && r.effect === "allow");
      const bothHaveIdsInMemory =
        typeof deniedRule?.id === "string" &&
        deniedRule.id.length > 0 &&
        typeof allowedRule?.id === "string" &&
        allowedRule.id.length > 0;

      const configOnDisk = JSON.parse(readFileSync(path.join(homeDir, "config.json"), "utf8"));
      const rulesOnDisk = configOnDisk.policy?.rules ?? [];
      const diskBackfilled = rulesOnDisk.length === 2 && rulesOnDisk.every((r) => typeof r.id === "string" && r.id.length > 0);

      record(
        "2i 啟動時 id backfill:寫入時沒帶 id 的舊規則,core 啟動後 policy.listRules 回傳的規則都已補上 id,config.json 檔案本身也被重寫(不只是 in-memory 補上)",
        bothHaveIdsInMemory && diskBackfilled,
        `deniedRule.id=${deniedRule?.id}, allowedRule.id=${allowedRule?.id}, rulesOnDisk=${JSON.stringify(rulesOnDisk)}`,
      );
    }

    // 清理所有 session。
    for (const sid of createdSessions) {
      try {
        await client.rpc("session.delete", { sessionId: sid });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("Part 2 即時 e2e 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  // ---- 2h: enforcement_audit 表有落地(core process 已結束,直接開 sqlite 檔讀取)----
  try {
    const dbMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "db", "dist", "client.js")).href);
    const dbPath = path.join(dataDir, "deskmony.db");
    const db = dbMod.createDb(dbPath);
    const rows = db.$client.prepare("SELECT kind, session_id, tool_name, effect, reason FROM enforcement_audit").all();
    db.$client.close();

    const decisionRows = rows.filter((r) => r.kind === "decision");
    const escalationRows = rows.filter((r) => r.kind === "escalation");
    const hasAllowRow = decisionRows.some((r) => r.effect === "allow");
    const hasDenyRow = decisionRows.some((r) => r.effect === "deny");
    const hasEscalateRow = decisionRows.some((r) => r.effect === "escalate" || r.effect === "escalate-strong");

    record(
      "2h enforcement_audit 表落地:decision/escalation 事件都有寫入(含自動放行,append-only)",
      rows.length > 0 && hasAllowRow && hasDenyRow && hasEscalateRow && escalationRows.length > 0,
      `總筆數=${rows.length}, decision=${decisionRows.length}(allow=${hasAllowRow}, deny=${hasDenyRow}, escalate 系=${hasEscalateRow}), escalation=${escalationRows.length}`,
    );
  } catch (err) {
    record("2h enforcement_audit 表落地驗證", false, String(err));
  }

  for (const dir of [dataDir, homeDir, workspaceDir, outsideWorktreeDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// Part 3(2026-10-02 P2.8):舊 profile 範圍規則與 providerId 範圍規則的即時 e2e——真的 core + fake ACP provider。
//
// 獨立一個 core(不與 Part 2 共用):Part 2 的 2i 斷言 config.json 剛好兩條規則,這裡需要額外的規則,
// 也需要捕捉 core 的 stdout 驗證啟動警告。
// =======================================================================
async function legacyScopeLiveE2e() {
  const PORT = 4335;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-legacy-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-legacy-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-legacy-ws-"));
  const legacyAllowDir = path.join(workspaceDir, "legacy-allow");
  const legacyDenyDir = path.join(workspaceDir, "legacy-deny");
  const providerAllowDir = path.join(workspaceDir, "provider-allow");
  const providerOtherDir = path.join(workspaceDir, "provider-other");
  for (const dir of [legacyAllowDir, legacyDenyDir, providerAllowDir, providerOtherDir]) mkdirSync(dir, { recursive: true });

  // 規則的 id 都帶著(沿用,不被 backfill 改寫),方便對照啟動警告。
  const configJson = {
    version: 1,
    policy: {
      rules: [
        { id: "legacy-deny-rule", tool: "Write file", when: { pathUnder: legacyDenyDir }, effect: "deny", scope: { profileId: "removed-profile" } },
        { id: "legacy-allow-rule", tool: "Write file", when: { pathUnder: legacyAllowDir }, effect: "allow", scope: { role: "Coder" } },
        { id: "provider-allow-rule", tool: "Write file", when: { pathUnder: providerAllowDir }, effect: "allow", scope: { providerId: FAKE_ACP } },
        { id: "provider-other-rule", tool: "Write file", when: { pathUnder: providerOtherDir }, effect: "allow", scope: { providerId: "some-other-agent" } },
      ],
      allowedHosts: [],
    },
  };
  writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(configJson, null, 2), "utf8");

  let coreProc;
  let client;
  let coreStdout = "";
  const createdSessions = [];
  const createSession = async (title, { autoMode = false } = {}) => {
    const created = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: workspaceDir, title }, 30_000);
    createdSessions.push(created.session.id);
    if (autoMode) await client.rpc("session.setPermissionMode", { sessionId: created.session.id, mode: "auto-accept-edits" });
    return created.session.id;
  };
  const sendWrite = async (sessionId, targetPath, content = "content") => {
    const startIdx = client.events.length;
    const posixPath = targetPath.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content })}` } });
    return startIdx;
  };
  const waitPermissionRequest = async (sessionId, startIdx) =>
    (await client.waitForEvent((e) => e.sessionId === sessionId && e.event.type === "permission-request", 15_000, startIdx)).event;
  const waitTurnEnd = (sessionId, startIdx) =>
    client.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000, startIdx);

  try {
    // 自己起 core(要捕捉 stdout)。
    const env = {
      ...process.env,
      DESKMONY_CORE_PORT: String(PORT),
      DESKMONY_DATA_DIR: dataDir,
      DESKMONY_HOME: homeDir,
      DESKMONY_WORKSPACE: workspaceDir,
      DESKMONY_PERMISSION_TIMEOUT_MS: "20000",
      ...e2eProvidersEnv(),
    };
    coreProc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    coreProc.stdout.on("data", (chunk) => {
      coreStdout += chunk.toString();
      process.stdout.write(`[core:legacy] ${chunk}`);
    });
    coreProc.stderr.on("data", (chunk) => {
      coreStdout += chunk.toString(); // console.warn 走 stderr
      process.stderr.write(`[core:legacy:err] ${chunk}`);
    });
    await waitForPort(`ws://localhost:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://localhost:${PORT}`);
    await client.connect();

    // ---- 3a:啟動時逐條 console.warn 帶舊範圍的規則(不靜默),沒有舊範圍的規則不警告 ----
    {
      const warnLines = coreStdout.split("\n").filter((l) => l.includes("[policy][legacy-scope]"));
      const denyLine = warnLines.find((l) => l.includes("legacy-deny-rule"));
      const allowLine = warnLines.find((l) => l.includes("legacy-allow-rule"));
      record(
        "3a core 啟動時逐條 console.warn 帶舊 profile 範圍的規則(規則 id + 處理方式);providerId 範圍的規則不警告",
        warnLines.length === 2 &&
          Boolean(denyLine) &&
          denyLine.includes("所有 session") &&
          Boolean(allowLine) &&
          allowLine.includes("已停用") &&
          !warnLines.some((l) => l.includes("provider-allow-rule") || l.includes("provider-other-rule")),
        `warnLines=${JSON.stringify(warnLines)}`,
      );
    }

    // ---- 3b:舊範圍 allow 規則不再放行——attended + always-ask 的 session 寫入該規則「原本會放行」的路徑,
    //          改成升級給人(permission-request 進 waiting),人回 deny 後檔案不存在。 ----
    {
      const sessionId = await createSession("3b-legacy-allow");
      const target = path.join(legacyAllowDir, "legacy-allow.txt");
      const startIdx = await sendWrite(sessionId, target);
      const permEvent = await waitPermissionRequest(sessionId, startIdx);
      await sleep(500);
      const status = (await client.rpc("session.list", {})).sessions.find((x) => x.id === sessionId)?.status;
      await client.rpc("permission.resolve", { sessionId, requestId: permEvent.requestId, decision: "deny" });
      await waitTurnEnd(sessionId, startIdx);
      record(
        "3b 舊 profile 範圍的 allow 規則不再放行:原本會被它放行的寫入改成升級給人(session 進 waiting),人拒絕後檔案未寫入",
        status === "waiting" && !existsSync(target),
        `status=${status}, fileExists=${existsSync(target)}`,
      );
    }

    // ---- 3c:舊範圍 deny 規則在 auto 模式下對任何 session 仍然 deny(關鍵 fail-open 防護):
    //          兩個不同的 auto 模式 session 寫入該規則擋的路徑,都被自動拒絕(source="policy"),不進 waiting。
    //          對照:同一個 auto session 寫入沒有規則的路徑會被「未分類中間地帶」自動放行。 ----
    {
      const sessions = [await createSession("3c-legacy-deny-A", { autoMode: true }), await createSession("3c-legacy-deny-B", { autoMode: true })];
      const outcomes = [];
      for (const [i, sessionId] of sessions.entries()) {
        const target = path.join(legacyDenyDir, `legacy-deny-${i}.txt`);
        const updatesBefore = client.sessionUpdates.length;
        const startIdx = await sendWrite(sessionId, target);
        const permEvent = await waitPermissionRequest(sessionId, startIdx);
        await waitTurnEnd(sessionId, startIdx);
        await sleep(300);
        const wentWaiting = client.sessionUpdates.slice(updatesBefore).some((u) => u.id === sessionId && u.status === "waiting");
        const deniedByPolicy = (client.permissionResolvedEvents ?? []).some(
          (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
        );
        outcomes.push({ wentWaiting, deniedByPolicy, fileWritten: existsSync(target) });
      }
      // 對照組:沒有任何規則涵蓋的路徑 → auto 模式自動放行(證明上面的 deny 是規則造成的,不是 auto 模式本身擋)。
      const controlTarget = path.join(workspaceDir, "control-auto.txt");
      const controlStart = await sendWrite(sessions[0], controlTarget);
      const controlPerm = await waitPermissionRequest(sessions[0], controlStart);
      await waitTurnEnd(sessions[0], controlStart);
      await sleep(300);
      const controlAllowed = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessions[0] && r.requestId === controlPerm.requestId && r.decision === "allow" && r.source === "policy",
      );
      record(
        "3c 舊 profile 範圍的 deny 規則在 auto 模式下對任何 session 仍然 deny(兩個 auto session 都被自動拒絕、不進 waiting、檔案未寫入);對照:沒有規則的路徑在 auto 模式下自動放行",
        outcomes.every((o) => o.deniedByPolicy && !o.wentWaiting && !o.fileWritten) && controlAllowed && existsSync(controlTarget),
        `outcomes=${JSON.stringify(outcomes)}, controlAllowed=${controlAllowed}`,
      );
    }

    // ---- 3d:providerId 範圍的即時驗證——`PermissionRequest.providerId` 真的從 session 一路帶進引擎:
    //          範圍 = 這個 session 的 provider 的 allow 規則 → 自動放行(不進 waiting);
    //          範圍 = 別的 agent 的 allow 規則 → 不匹配 → 升級給人。 ----
    {
      const sessionId = await createSession("3d-provider-scope");
      const okTarget = path.join(providerAllowDir, "provider-allow.txt");
      const updatesBefore = client.sessionUpdates.length;
      const startIdx = await sendWrite(sessionId, okTarget);
      const perm1 = await waitPermissionRequest(sessionId, startIdx);
      await waitTurnEnd(sessionId, startIdx);
      await sleep(300);
      const allowedByScope = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === perm1.requestId && r.decision === "allow" && r.source === "policy",
      );
      const wentWaiting = client.sessionUpdates.slice(updatesBefore).some((u) => u.id === sessionId && u.status === "waiting");

      const otherTarget = path.join(providerOtherDir, "provider-other.txt");
      const startIdx2 = await sendWrite(sessionId, otherTarget);
      const perm2 = await waitPermissionRequest(sessionId, startIdx2);
      await sleep(500);
      const status2 = (await client.rpc("session.list", {})).sessions.find((x) => x.id === sessionId)?.status;
      await client.rpc("permission.resolve", { sessionId, requestId: perm2.requestId, decision: "deny" });
      await waitTurnEnd(sessionId, startIdx2);
      record(
        "3d scope.providerId 即時驗證:範圍=這個 session 的 agent 的 allow 規則 → 自動放行(不進 waiting、檔案寫入);範圍=別的 agent 的 allow 規則 → 不匹配、升級給人",
        allowedByScope && !wentWaiting && existsSync(okTarget) && status2 === "waiting" && !existsSync(otherTarget),
        `allowedByScope=${allowedByScope}, wentWaiting=${wentWaiting}, fileWritten=${existsSync(okTarget)}, otherStatus=${status2}, otherFileExists=${existsSync(otherTarget)}`,
      );
    }

    // ---- 3e:`policy.addRule` 不再接受舊範圍(否則一條 {deny, scope:{profileId}} 會變成「擋所有 session」,與寫它的人本意不符);
    //          providerId 範圍正常接受,且 listRules 看得到。 ----
    {
      const rejected = [];
      for (const scope of [{ profileId: "x" }, { role: "Coder" }]) {
        try {
          await client.rpc("policy.addRule", { tool: "Bash", effect: "deny", scope });
          rejected.push(false);
        } catch (err) {
          rejected.push(true);
        }
      }
      let accepted = false;
      let listed = false;
      try {
        const added = await client.rpc("policy.addRule", { tool: "Bash", effect: "deny", scope: { providerId: FAKE_ACP } });
        accepted = added.rule?.scope?.providerId === FAKE_ACP;
        const list = await client.rpc("policy.listRules", {});
        listed = list.rules.some((r) => r.id === added.rule.id && r.scope?.providerId === FAKE_ACP);
      } catch (err) {
        // accepted 維持 false
      }
      record(
        "3e policy.addRule 拒絕舊 profileId/role 範圍(schema 層就擋),providerId 範圍正常新增且 policy.listRules 看得到",
        rejected.every(Boolean) && accepted && listed,
        `舊範圍被拒=${JSON.stringify(rejected)}, providerId 範圍 accepted=${accepted}, listed=${listed}`,
      );
    }

    for (const sid of createdSessions) {
      try {
        await client.rpc("session.delete", { sessionId: sid });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("Part 3 即時 e2e 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  for (const dir of [dataDir, homeDir, workspaceDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  log("=== Part 1:PolicyEngine 單元測試 ===");
  await unitTests();

  log("\n=== Part 2:即時 e2e(真實 WS Gateway + fake ACP agent) ===");
  await liveE2e();

  log("\n=== Part 3:舊 profile 範圍規則 + providerId 範圍的即時 e2e(P2.8) ===");
  await legacyScopeLiveE2e();

  const failed = results.filter((r) => !r.ok);
  log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-policy-engine] fatal:", err);
  process.exit(1);
});

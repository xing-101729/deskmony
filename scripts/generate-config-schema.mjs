#!/usr/bin/env node
/**
 * scripts/generate-config-schema.mjs(M6 Round A 新增)
 *
 * 由 `packages/shared/src/core-config.ts` 的 `CoreConfigSchema`(zod)產生一份
 * JSON Schema(`docs/deskmony.config.v1.json`),對應 Paseo 發佈
 * `paseo.config.v1.json` 供編輯器自動補全的做法——使用者可以在自己的
 * `<DESKMONY_HOME>/config.json` 頂端加一行 `"$schema": "..."` 指到這份檔案
 * (見 README「JSON schema」章節,包含如何讓編輯器實際解析到它)。
 *
 * 用法:
 *   pnpm build                      # 先 build 一次(需要 packages/shared/dist)
 *   pnpm generate:config-schema      # 產生/更新 docs/deskmony.config.v1.json
 *
 * 這個腳本本身**不參與** `pnpm build`/`pnpm typecheck`/e2e 驗收流程(純文件產
 * 出的手動步驟,比照 Paseo 官方 schema 是另外發佈、不是每次 build 自動產生)
 * ——CI/開發流程改了 `core-config.ts` 之後,記得手動重新執行這個腳本、把
 * 產出的 JSON 一併 commit。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "docs", "deskmony.config.v1.json");

async function main() {
  const modUrl = pathToFileURL(path.join(REPO_ROOT, "packages", "shared", "dist", "core-config.js")).href;
  let CoreConfigSchema;
  try {
    ({ CoreConfigSchema } = await import(modUrl));
  } catch (err) {
    console.error(
      `[generate-config-schema] 找不到 packages/shared/dist/core-config.js,請先執行 \`pnpm build\`(或至少 ` +
        `\`pnpm --filter @deskmony/shared run build\`)。\n原始錯誤: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // `CoreConfigSchema` 本身是「合併後一定有值」的形狀(`workspace.defaultWorkingDir`/
  // `data.dataDir` 必填),但使用者手寫的 `config.json` 應該允許省略任何欄位
  // (見 core-config.ts 的 `CoreConfigFileSchema = CoreConfigSchema.deepPartial()`)
  // ——這裡直接對 `deepPartial()` 之後的 schema 產生 JSON Schema,讓編輯器的
  // 自動補全/驗證行為與 `apps/core` 實際讀取 `config.json` 時使用的驗證規則
  // 完全一致。
  const fileSchema = CoreConfigSchema.deepPartial();
  const jsonSchema = zodToJsonSchema(fileSchema, { $refStrategy: "none" });

  const output = {
    $id: "https://deskmony/schemas/deskmony.config.v1.json",
    title: "Deskmony core config (v1)",
    description:
      "apps/core 的分層設定檔格式(defaults → 這份設定檔 → 環境變數,環境變數永遠優先)。由 packages/shared/src/core-config.ts 的 CoreConfigSchema 用 zod-to-json-schema 產生,見 scripts/generate-config-schema.mjs。",
    ...jsonSchema,
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`[generate-config-schema] 已寫入 ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[generate-config-schema] 產生失敗:", err);
  process.exit(1);
});

import type { AgentProfile } from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { closeGateway, connectGateway } from "../connect.js";
import { renderTable } from "../render.js";

/**
 * Phase 1 只做 `profile list`(HLD §2)——`profile create`/`delete` 刻意不進
 * CLI 的命令表面,這一輪由桌面殼或直接呼叫 gateway 管理即可,見
 * docs/LAYER-3-hld/cli_hld.md §3「不做的事」的精神(把單一路徑做完整,
 * 不是每個 gateway 方法都要有對應的 CLI 子指令)。
 *
 * `profile.list` 回傳**完整** `AgentProfile`(含可能有 API key 的 `env`
 * 欄位)——這是既有系統設計就有的取捨,不是這裡新引入的風險:見
 * packages/shared/src/agent-profile.ts 對 `env` 欄位的說明,profile 資料
 * 被視為「使用者自己在這台機器建立、只給自己讀」,目前不遮罩。CLI 與桌面
 * 殼一樣是「使用者自己的 client」,不對這份既有的安全姿態加碼或減碼——
 * 只是預設的表格檢視刻意不把 `env`/`mcpConfig`/`systemPrompt` 這幾個大
 * 欄位塞進窄欄位的表格(單純是排版考量),`--json` 模式仍然原樣印出完整
 * 物件。
 */
export async function profileListCommand(options: GlobalOptions): Promise<void> {
  const client = await connectGateway({ url: options.url, token: options.token });
  try {
    const { profiles } = (await client.call("profile.list", {})) as { profiles: AgentProfile[] };
    if (options.json) {
      for (const p of profiles) process.stdout.write(`${JSON.stringify(p)}\n`);
      return;
    }
    if (profiles.length === 0) {
      process.stdout.write("目前沒有任何 agent profile。\n");
      return;
    }
    const rows = profiles.map((p) => [p.id, p.name, p.software, p.model ?? "(未指定)", p.role]);
    for (const line of renderTable(["ID", "NAME", "SOFTWARE", "MODEL", "ROLE"], rows)) {
      process.stdout.write(`${line}\n`);
    }
  } finally {
    closeGateway(client);
  }
}

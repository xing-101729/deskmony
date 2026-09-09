import type { GatewayClient } from "@deskmony/client";
import type { AgentDetectionEntry } from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { closeGateway, connectGateway } from "../connect.js";
import { paint } from "../render.js";

/**
 * `deskmony doctor`——環境偵測(`env.detectAgents`)+ 連線自我檢查(HLD
 * §2)。**退出碼恆為 0**——這是它跟其餘所有指令刻意不同的地方:doctor 存
 * 在的目的就是「回報現況」,連不上 gateway 本身正是它要診斷、回報的其中
 * 一種現況,不是它自己執行失敗。因此這裡**不能**沿用其餘指令共用的
 * `connectGateway()` 那種「連不上就丟 `CliExitError(3)` 讓整個指令失敗」
 * 的行為——必須自己 try/catch 吸收掉,把結果當成診斷資料的一部分印出來,
 * 而不是讓例外往上傳。
 */
export async function doctorCommand(options: GlobalOptions): Promise<void> {
  let client: GatewayClient | undefined;
  let connectError: string | undefined;
  try {
    client = await connectGateway({ url: options.url, token: options.token });
  } catch (err) {
    connectError = err instanceof Error ? err.message : String(err);
  }

  let agents: AgentDetectionEntry[] | undefined;
  let detectError: string | undefined;
  if (client) {
    try {
      const result = (await client.call("env.detectAgents", {})) as { agents: AgentDetectionEntry[] };
      agents = result.agents;
    } catch (err) {
      detectError = err instanceof Error ? err.message : String(err);
    } finally {
      closeGateway(client);
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ url: options.url, connected: connectError === undefined, connectError, agents, detectError })}\n`,
    );
    return;
  }

  const lines: string[] = [`gateway 位址:${options.url}`];
  if (connectError === undefined) {
    lines.push(paint("連線狀態:已連線", "green", options.color));
  } else {
    lines.push(paint(`連線狀態:無法連線 -- ${connectError}`, "yellow", options.color));
    lines.push("(連不上時無法偵測 agent 軟體;可執行「deskmony serve」啟動 core 後再試一次)");
  }
  if (agents !== undefined) {
    lines.push("", "偵測到的 agent 軟體:");
    for (const a of agents) {
      const status = a.installed ? paint("已安裝", "green", options.color) : paint("未偵測到", "dim", options.color);
      const version = a.version ? ` v${a.version}` : "";
      lines.push(`  - ${a.displayName}(${a.software})${version}:${status}`);
    }
  } else if (detectError !== undefined) {
    lines.push(`偵測 agent 軟體失敗:${detectError}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  // 刻意不設 process.exitCode——doctor 恆為 0(見上方檔案頂端說明)。
}

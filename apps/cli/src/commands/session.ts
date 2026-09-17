import type { Session } from "@deskmony/shared";
import type { GlobalOptions } from "../args.js";
import { CliExitError, closeGateway, connectGateway } from "../connect.js";
import { renderTable } from "../render.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function sessionListCommand(options: GlobalOptions): Promise<void> {
  const client = await connectGateway({ url: options.url, token: options.token });
  try {
    const { sessions } = (await client.call("session.list", {})) as { sessions: Session[] };
    if (options.json) {
      // 每行一個合法 JSON、直接印 server 回傳的原始物件(已經是
      // SessionSchema 的合法實例)——不做任何轉換或欄位挑選,這是最不會
      // 跟協議漂移的作法(轉換一次,就多一個「CLI 自己的欄位子集」需要
      // 跟著協議演進維護)。
      for (const s of sessions) process.stdout.write(`${JSON.stringify(s)}\n`);
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write("目前沒有任何 session。\n");
      return;
    }
    const rows = sessions.map((s) => [s.id, s.status, s.adapterType, s.title, s.workingDir]);
    for (const line of renderTable(["ID", "STATUS", "ADAPTER", "TITLE", "WORKDIR"], rows)) {
      process.stdout.write(`${line}\n`);
    }
  } finally {
    closeGateway(client);
  }
}

export async function sessionRmCommand(options: GlobalOptions, sessionId: string): Promise<void> {
  const client = await connectGateway({ url: options.url, token: options.token });
  try {
    try {
      await client.call("session.delete", { sessionId });
    } catch (err) {
      throw new CliExitError(1, `刪除 session 失敗:${describeError(err)}`);
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, sessionId })}\n`);
    } else {
      process.stdout.write(`已刪除 session:${sessionId}\n`);
    }
  } finally {
    closeGateway(client);
  }
}

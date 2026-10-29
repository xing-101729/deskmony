import {
  WorkspaceGitDiffResultSchema,
  WorkspaceGitStatusResultSchema,
  WorkspaceListDirResultSchema,
  WorkspaceReadFileResultSchema,
  type WorkspaceGitDiffResult,
  type WorkspaceGitStatusResult,
  type WorkspaceListDirResult,
  type WorkspaceReadFileResult,
} from "@deskmony/shared";
import { client } from "../stores/session-store.js";

/**
 * 右側面板 Changes / Files 分頁用的 `workspace.*` 呼叫(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.2)。
 * 回應一律經 zod 驗證;錯誤是 `DeskmonyError`(帶 `errorCode`,用 `translateError()` 翻譯)。
 * `path` 是相對 session 工作資料夾、以 `/` 分隔的字串,空字串 = 根目錄。
 */

export async function workspaceListDir(sessionId: string, path: string): Promise<WorkspaceListDirResult> {
  return WorkspaceListDirResultSchema.parse(await client.call("workspace.listDir", { sessionId, path }));
}

export async function workspaceReadFile(sessionId: string, path: string): Promise<WorkspaceReadFileResult> {
  return WorkspaceReadFileResultSchema.parse(await client.call("workspace.readFile", { sessionId, path }));
}

export async function workspaceGitStatus(sessionId: string): Promise<WorkspaceGitStatusResult> {
  return WorkspaceGitStatusResultSchema.parse(await client.call("workspace.gitStatus", { sessionId }));
}

export async function workspaceGitDiff(sessionId: string, path: string, oldPath?: string): Promise<WorkspaceGitDiffResult> {
  return WorkspaceGitDiffResultSchema.parse(
    await client.call("workspace.gitDiff", { sessionId, path, ...(oldPath ? { oldPath } : {}) }),
  );
}

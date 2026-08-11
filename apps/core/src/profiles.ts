import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { agentProfiles as agentProfilesTable } from "@deskmony/db";
import type { AgentProfile, CreateAgentProfileInput } from "@deskmony/shared";

/**
 * AgentProfile 儲存(M3 Round A:改為 DB 背書,取代 M1 的純記憶體 Map ——
 * 見 README 已知限制「profile 僅記憶體,core 重啟後消失」)。對外介面維持
 * list()/get()/create() 不變(只是從同步改成 async,呼叫端本來就都在
 * async 函式內,見 apps/core/src/gateway/ws-gateway.ts、
 * apps/core/src/session/session-manager.ts)。
 */
export class ProfileStore {
  constructor(private readonly db: NexusDb) {}

  async list(): Promise<AgentProfile[]> {
    const rows = await this.db.select().from(agentProfilesTable).all();
    return rows.map(rowToProfile);
  }

  async get(id: string): Promise<AgentProfile | undefined> {
    const rows = await this.db
      .select()
      .from(agentProfilesTable)
      .where(eq(agentProfilesTable.id, id))
      .all();
    return rows[0] ? rowToProfile(rows[0]) : undefined;
  }

  async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    const now = Date.now();
    const profile: AgentProfile = {
      id: randomUUID(),
      role: input.role ?? "Coder",
      permissionLevel: input.permissionLevel ?? "always-ask",
      name: input.name,
      software: input.software,
      providerId: input.providerId,
      model: input.model,
      systemPrompt: input.systemPrompt,
      mcpConfig: input.mcpConfig,
      workingDir: input.workingDir,
      env: input.env,
      acpConfig: input.acpConfig,
      ptyConfig: input.ptyConfig,
      opencodeConfig: input.opencodeConfig,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(agentProfilesTable).values(profileToRow(profile)).run();
    return profile;
  }

  /**
   * 冪等 seed:id 已存在時不覆寫(啟動時注入預設 profile 用,見
   * apps/core/src/index.ts)。core 重啟多次也不會重複插入或覆蓋使用者已經
   * 修改過的預設 profile。
   */
  async ensureSeed(profile: AgentProfile): Promise<void> {
    const existing = await this.get(profile.id);
    if (existing) return;
    await this.db.insert(agentProfilesTable).values(profileToRow(profile)).run();
  }
}

export function createDefaultProfile(workingDir: string): AgentProfile {
  const now = Date.now();
  return {
    id: "default-claude-code",
    name: "Claude Code",
    role: "Coder",
    software: "claude-agent-sdk",
    permissionLevel: "always-ask",
    workingDir,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToProfile(row: typeof agentProfilesTable.$inferSelect): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    software: row.software as AgentProfile["software"],
    providerId: row.providerId ?? undefined,
    model: row.model ?? undefined,
    systemPrompt: row.systemPrompt ?? undefined,
    mcpConfig: row.mcpConfig ? (JSON.parse(row.mcpConfig) as Record<string, unknown>) : undefined,
    permissionLevel: row.permissionLevel as AgentProfile["permissionLevel"],
    workingDir: row.workingDir,
    env: row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined,
    acpConfig: row.acpConfig ? JSON.parse(row.acpConfig) : undefined,
    ptyConfig: row.ptyConfig ? JSON.parse(row.ptyConfig) : undefined,
    opencodeConfig: row.opencodeConfig ? JSON.parse(row.opencodeConfig) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function profileToRow(profile: AgentProfile): typeof agentProfilesTable.$inferInsert {
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    software: profile.software,
    providerId: profile.providerId ?? null,
    model: profile.model ?? null,
    systemPrompt: profile.systemPrompt ?? null,
    mcpConfig: profile.mcpConfig ? JSON.stringify(profile.mcpConfig) : null,
    permissionLevel: profile.permissionLevel,
    workingDir: profile.workingDir,
    env: profile.env ? JSON.stringify(profile.env) : null,
    acpConfig: profile.acpConfig ? JSON.stringify(profile.acpConfig) : null,
    ptyConfig: profile.ptyConfig ? JSON.stringify(profile.ptyConfig) : null,
    opencodeConfig: profile.opencodeConfig ? JSON.stringify(profile.opencodeConfig) : null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

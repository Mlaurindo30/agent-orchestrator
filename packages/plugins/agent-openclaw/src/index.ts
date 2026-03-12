import {
  DEFAULT_READY_THRESHOLD_MS,
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "openclaw",
  slot: "agent" as const,
  description: "Agent plugin: OpenClaw sessions as AI coding agent",
  version: "1.0.0",
};

// =============================================================================
// OpenClaw Agent Plugin
// =============================================================================

const OPENCLAW_CLI = "openclaw";
const SESSION_STORE = join(homedir(), ".openclaw", "state", "sessions.json");

async function findOpenClawSessionsStore(): Promise<string | null> {
  // Try default location first
  const defaultPath = SESSION_STORE;
  try {
    await stat(defaultPath);
    return defaultPath;
  } catch {
    // Try env var
    const envPath = process.env.OPENCLAW_STATE_DIR;
    if (envPath) {
      const storePath = join(envPath, "sessions.json");
      try {
        await stat(storePath);
        return storePath;
      } catch {}
    }
  }
  return null;
}

async function getSessionInfoFromStore(sessionId: string): Promise<AgentSessionInfo | null> {
  const storePath = await findOpenClawSessionsStore();
  if (!storePath) return null;

  try {
    const content = await readFile(storePath, "utf-8");
    const sessions = JSON.parse(content);
    const session = sessions[sessionId];
    if (!session) return null;

    return {
      summary: session.summary || session.title || `Session ${sessionId}`,
      agentSessionId: sessionId,
      cost: session.cost || { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  } catch {
    return null;
  }
}

async function isSessionRunning(sessionId: string): Promise<boolean> {
  const info = await getSessionInfoFromStore(sessionId);
  return info !== null;
}

// =============================================================================
// Agent Implementation
// =============================================================================

export function create(config?: Record<string, unknown>): Agent {
  return {
    name: "openclaw",
    processName: "openclaw",
    promptDelivery: "post-launch",

    getLaunchCommand(projectConfig: AgentLaunchConfig): string {
      const task = projectConfig.prompt || "";
      const workspacePath = projectConfig.projectConfig?.path || process.cwd();
      const agentId = projectConfig.projectConfig?.sessionPrefix || "default";
      
      // Escape the task for shell
      const escapedTask = task.replace(/"/g, '\\"').replace(/\n/g, ' ');
      
      // OpenClaw CLI command to spawn a session with subagent runtime
      return `${OPENCLAW_CLI} sessions spawn --agent ${agentId} --task "${escapedTask}" --cwd "${workspacePath}" --runtime subagent`;
    },

    getEnvironment(projectConfig: AgentLaunchConfig): Record<string, string> {
      return {
        OPENCLAW_SESSION: projectConfig.sessionId || "",
        OPENCLAW_STATE_DIR: join(homedir(), ".openclaw", "state"),
      };
    },

    detectActivity(terminalOutput: string): ActivityState {
      // Parse terminal output to detect activity
      // OpenClaw outputs are typically structured
      if (terminalOutput.includes("error") || terminalOutput.includes("Error")) {
        return "blocked";
      }
      if (terminalOutput.includes("completed") || terminalOutput.includes("done")) {
        return "ready";
      }
      if (terminalOutput.includes("working") || terminalOutput.includes("processing")) {
        return "active";
      }
      if (terminalOutput.includes("waiting") || terminalOutput.includes("input")) {
        return "waiting_input";
      }
      // Default to active if there's output
      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number
    ): Promise<ActivityDetection | null> {
      const sessionId = session.id;
      const running = await isSessionRunning(sessionId);
      
      if (!running) {
        return { state: "exited", timestamp: new Date() };
      }

      return { state: "active", timestamp: new Date() };
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      // Check if the OpenClaw session is still active
      // RuntimeHandle has sessionId in its metadata
      const sessionId = (handle as any).sessionId || (handle as any).session?.id;
      if (!sessionId) return false;
      return isSessionRunning(sessionId);
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      return getSessionInfoFromStore(session.id);
    },
  };
}

export default { manifest, create } as PluginModule;
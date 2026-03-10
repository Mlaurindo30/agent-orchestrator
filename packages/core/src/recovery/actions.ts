import type { OrchestratorConfig, PluginRegistry, Runtime, Workspace, Session } from "../types.js";
import { updateMetadata, deleteMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import { parsePrFromUrl } from "../utils/pr.js";
import { validateStatus } from "../utils/validation.js";
import type { RecoveryAssessment, RecoveryResult, RecoveryContext } from "./types.js";

export async function recoverSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "recover",
    };
  }

  try {
    const now = new Date().toISOString();
    const recoveryCount = rawMetadata["recoveryCount"]
      ? parseInt(rawMetadata["recoveryCount"], 10) + 1
      : 1;
    const preservedStatus = validateStatus(rawMetadata["status"]);

    const project = config.projects[projectId];
    const sessionsDir = getSessionsDir(config.configPath, project.path);

    if (recoveryCount > context.recoveryConfig.maxRecoveryAttempts) {
      updateMetadata(sessionsDir, sessionId, {
        status: "stuck",
        escalatedAt: now,
        escalationReason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
        recoveryCount: String(recoveryCount),
      });

      return {
        success: true,
        sessionId,
        action: "escalate",
        requiresManualIntervention: true,
      };
    }

    updateMetadata(sessionsDir, sessionId, {
      status: preservedStatus,
      recoveredAt: now,
      recoveryCount: String(recoveryCount),
    });

    const session: Session = {
      id: sessionId,
      projectId,
      status: preservedStatus,
      activity: null,
      branch: rawMetadata["branch"] || null,
      issueId: rawMetadata["issue"] || null,
      pr: rawMetadata["pr"]
        ? (() => {
            const parsed = parsePrFromUrl(rawMetadata["pr"]);
            return {
              number: parsed?.number ?? 0,
              url: rawMetadata["pr"],
              title: "",
              owner: parsed?.owner ?? "",
              repo: parsed?.repo ?? "",
              branch: rawMetadata["branch"] || "",
              baseBranch: "",
              isDraft: false,
            };
          })()
        : null,
      workspacePath: rawMetadata["worktree"] || null,
      runtimeHandle: assessment.runtimeHandle,
      agentInfo: null,
      createdAt: rawMetadata["createdAt"] ? new Date(rawMetadata["createdAt"]) : new Date(),
      lastActivityAt: new Date(),
      restoredAt: new Date(now),
      metadata: rawMetadata,
    };

    return {
      success: true,
      sessionId,
      action: "recover",
      session,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "recover",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata, runtimeAlive, workspaceExists } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  }

  try {
    const project = config.projects[projectId];
    const runtimeName = project.runtime ?? config.defaults.runtime;
    const workspaceName = project.workspace ?? config.defaults.workspace;
    const runtime = registry.get<Runtime>("runtime", runtimeName);
    const workspace = registry.get<Workspace>("workspace", workspaceName);

    if (runtimeAlive && assessment.runtimeHandle && runtime) {
      try {
        await runtime.destroy(assessment.runtimeHandle);
      } catch {
        // ignore cleanup errors
      }
    }

    const workspacePath = rawMetadata["worktree"];
    if (workspacePath && workspaceExists && workspace) {
      try {
        await workspace.destroy(workspacePath);
      } catch {
        // ignore cleanup errors
      }
    }

    const sessionsDir = getSessionsDir(config.configPath, project.path);

    updateMetadata(sessionsDir, sessionId, {
      status: "terminated",
      terminatedAt: new Date().toISOString(),
      terminationReason: "cleanup",
    });

    deleteMetadata(sessionsDir, sessionId, true);

    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "cleanup",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function escalateSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  _registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, reason } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
    };
  }

  try {
    const project = config.projects[projectId];
    const sessionsDir = getSessionsDir(config.configPath, project.path);

    updateMetadata(sessionsDir, sessionId, {
      status: "stuck",
      escalatedAt: new Date().toISOString(),
      escalationReason: reason,
    });

    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "escalate",
      error: error instanceof Error ? error.message : String(error),
      requiresManualIntervention: true,
    };
  }
}

export async function executeAction(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  switch (assessment.action) {
    case "recover":
      return recoverSession(assessment, config, registry, context);
    case "cleanup":
      return cleanupSession(assessment, config, registry, context);
    case "escalate":
      return escalateSession(assessment, config, registry, context);
    case "skip":
    default:
      return {
        success: true,
        sessionId: assessment.sessionId,
        action: "skip",
      };
  }
}

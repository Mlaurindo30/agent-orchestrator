import {
  DEFAULT_READY_THRESHOLD_MS,
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { writeFile, mkdir, readFile, readdir, rename, stat, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

function normalizePermissionMode(mode: string | undefined): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (mode === "permissionless" || mode === "default" || mode === "auto-edit" || mode === "suggest") {
    return mode as "permissionless" | "default" | "auto-edit" | "suggest";
  }
  return undefined;
}

/** Shared bin directory for ao shell wrappers */
const AO_BIN_DIR = join(homedir(), ".ao", "bin");
const DEFAULT_PATH = "/usr/bin:/bin";
const PREFERRED_GH_BIN_DIR = "/usr/local/bin";
const PREFERRED_GH_PATH = `${PREFERRED_GH_BIN_DIR}/gh`;

function buildAgentPath(basePath: string | undefined): string {
  const inherited = (basePath ?? DEFAULT_PATH).split(":").filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    ordered.push(entry);
    seen.add(entry);
  };

  add(AO_BIN_DIR);
  add(PREFERRED_GH_BIN_DIR);

  for (const entry of inherited) add(entry);

  return ordered.join(":");
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Google Gemini CLI",
  version: "0.1.0",
};

// =============================================================================
// Shell Wrappers
// =============================================================================

const AO_METADATA_HELPER = `#!/usr/bin/env bash
# ao-metadata-helper — shared by gh/git wrappers
# Provides: update_ao_metadata <key> <value>

update_ao_metadata() {
  local key="\$1" value="\$2"
  local ao_dir="\${AO_DATA_DIR:-}"
  local ao_session="\${AO_SESSION:-}"

  [[ -z "\$ao_dir" || -z "\$ao_session" ]] && return 0

  case "\$ao_session" in
    */* | *..*) return 0 ;;
  esac

  case "\$ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 0 ;;
  esac

  local metadata_file="\$ao_dir/\$ao_session"

  local real_dir real_ao_dir
  real_ao_dir="\$(cd "\$ao_dir" 2>/dev/null && pwd -P)" || return 0
  real_dir="\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P)" || return 0
  [[ "\$real_dir" == "\$real_ao_dir"* ]] || return 0

  [[ -f "\$metadata_file" ]] || return 0

  local temp_file="\${metadata_file}.tmp.\$\$"
  local clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"
  local escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"

  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi

  mv "\$temp_file" "\$metadata_file"
}
`;

const GH_WRAPPER = `#!/usr/bin/env bash
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh=""

if [[ -n "\${GH_PATH:-}" && -x "\$GH_PATH" ]]; then
  gh_dir="\$(cd "\$(dirname "\$GH_PATH")" 2>/dev/null && pwd)"
  if [[ "\$gh_dir" != "\$ao_bin_dir" ]]; then
    real_gh="\$GH_PATH"
  fi
fi

if [[ -z "\$real_gh" ]]; then
  real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
fi

if [[ -z "\$real_gh" ]]; then
  echo "ao-wrapper: gh not found in PATH" >&2
  exit 127
fi

source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT
    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}
    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_ao_metadata pr "\$pr_url"
            update_ao_metadata status pr_open
          fi
          ;;
        pr/merge)
          update_ao_metadata status merged
          ;;
      esac
    fi
    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

const GIT_WRAPPER = `#!/usr/bin/env bash
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "ao-wrapper: git not found in PATH" >&2
  exit 127
fi

source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

"\$real_git" "\$@"
exit_code=\$?

if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b)
      update_ao_metadata branch "\$3"
      ;;
    switch/-c)
      update_ao_metadata branch "\$3"
      ;;
  esac
fi

exit \$exit_code
`;

// =============================================================================
// Workspace Setup
// =============================================================================

const AO_AGENTS_MD_SECTION = `
## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
\`\`\`bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
\`\`\`
`;

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

async function setupGeminiWorkspace(workspacePath: string): Promise<void> {
  await mkdir(AO_BIN_DIR, { recursive: true });

  await atomicWriteFile(
    join(AO_BIN_DIR, "ao-metadata-helper.sh"),
    AO_METADATA_HELPER,
    0o755,
  );

  const markerPath = join(AO_BIN_DIR, ".ao-version");
  const currentVersion = "0.1.0";
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === currentVersion) needsUpdate = false;
  } catch {
    // File doesn't exist
  }

  if (needsUpdate) {
    await atomicWriteFile(join(AO_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(AO_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existing = "";
  try {
    existing = await readFile(agentsMdPath, "utf-8");
  } catch {
    // File doesn't exist
  }

  if (!existing.includes("Agent Orchestrator (ao) Session")) {
    const content = existing
      ? existing.trimEnd() + "\n" + AO_AGENTS_MD_SECTION
      : AO_AGENTS_MD_SECTION.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Gemini Session Handling
// =============================================================================

/** Gemini session directory: ~/.gemini/sessions/ or ~/.config/gemini/ */
const GEMINI_SESSIONS_DIR = join(homedir(), ".gemini", "sessions");
const GEMINI_CONFIG_DIR = join(homedir(), ".gemini");

interface GeminiSessionData {
  model: string | null;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
}

const MAX_SESSION_SCAN_DEPTH = 4;

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl") || entry.endsWith(".json")) {
      results.push(fullPath);
    } else {
      try {
        const s = await lstat(fullPath);
        if (s.isDirectory()) {
          const nested = await collectJsonlFiles(fullPath, depth + 1);
          results.push(...nested);
        }
      } catch {
        // Skip
      }
    }
  }
  return results;
}

async function findGeminiSessionFile(workspacePath: string): Promise<string | null> {
  const jsonlFiles = await collectJsonlFiles(GEMINI_SESSIONS_DIR);
  if (jsonlFiles.length === 0) return null;

  let bestMatch: { path: string; mtime: number } | null = null;

  for (const filePath of jsonlFiles) {
    try {
      const s = await stat(filePath);
      if (!bestMatch || s.mtimeMs > bestMatch.mtime) {
        bestMatch = { path: filePath, mtime: s.mtimeMs };
      }
    } catch {
      // Skip
    }
  }

  return bestMatch?.path ?? null;
}

async function streamGeminiSessionData(filePath: string): Promise<GeminiSessionData | null> {
  try {
    const data: GeminiSessionData = { model: null, sessionId: null, inputTokens: 0, outputTokens: 0 };
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const entry = parsed as Record<string, unknown>;

        if (entry.model && typeof entry.model === "string") {
          data.model = entry.model;
        }
        if (entry.sessionId && typeof entry.sessionId === "string") {
          data.sessionId = entry.sessionId;
        }
        if (entry.input_tokens && typeof entry.input_tokens === "number") {
          data.inputTokens += entry.input_tokens;
        }
        if (entry.output_tokens && typeof entry.output_tokens === "number") {
          data.outputTokens += entry.output_tokens;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return data;
  } catch {
    return null;
  }
}

// =============================================================================
// Binary Resolution
// =============================================================================

export async function resolveGeminiBinary(): Promise<string> {
  // 1. Try `which gemini`
  try {
    const { stdout } = await execFileAsync("which", ["gemini"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Not found
  }

  // 2. Check common locations
  const home = homedir();
  const candidates = [
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
    join(home, ".npm-global", "bin", "gemini"),
    join(home, ".local", "bin", "gemini"),
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not found
    }
  }

  // 3. Fallback
  return "gemini";
}

// =============================================================================
// Agent Implementation
// =============================================================================

/** Append model flags for Gemini */
function appendModelFlags(parts: string[], model: string | undefined): void {
  if (!model) return;
  // Gemini CLI uses -m for model shorthand or --model
  parts.push("-m", shellEscape(model));
}

/** Gemini CLI supports sandbox mode */
function appendSandboxFlags(parts: string[], permissions: string | undefined): void {
  const mode = normalizePermissionMode(permissions);
  if (mode === "permissionless") {
    // Gemini CLI doesn't have a direct permissionless mode
    // but supports --sandbox for safety
    parts.push("--sandbox");
  }
}

const SESSION_FILE_CACHE_TTL_MS = 30_000;
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

async function findGeminiSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }
  const result = await findGeminiSessionFile(workspacePath);
  sessionFileCache.set(workspacePath, { path: result, expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS });
  return result;
}

function createGeminiAgent(): Agent {
  let resolvedBinary: string | null = null;
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "gemini",
    processName: "gemini",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "gemini";
      const parts: string[] = [shellEscape(binary)];

      appendModelFlags(parts, config.model);
      appendSandboxFlags(parts, config.permissions);

      if (config.systemPromptFile) {
        // Gemini CLI reads context from GEMINI.md or --context flag
        parts.push("--context", shellEscape(config.systemPromptFile));
      } else if (config.systemPrompt) {
        // Pass as prompt with -p flag
        parts.push("-p", shellEscape(config.systemPrompt));
      }

      if (config.prompt) {
        parts.push("-p", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend ~/.ao/bin to PATH
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      // Gemini uses GEMINI_API_KEY or OAuth
      // If API key is set, it will be used; otherwise OAuth flow
      // env["GEMINI_API_KEY"] is inherited from process.env

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // Gemini prompt detection
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";
      if (/^[>$#]\s+/.test(lastLine)) return "idle";

      const tail = lines.slice(-5).join("\n");
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
      if (/continue\?/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      const sessionFile = await findGeminiSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      try {
        const s = await stat(sessionFile);
        const timestamp = s.mtime;
        const ageMs = Date.now() - s.mtimeMs;

        if (ageMs <= threshold) {
          return { state: "active", timestamp };
        }

        return { state: "idle", timestamp };
      } catch {
        return null;
      }
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut.trim().split("\n").map((t) => t.trim()).filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], { timeout: 30_000 });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)gemini(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findGeminiSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await streamGeminiSessionData(sessionFile);
      if (!data) return null;

      const agentSessionId = basename(sessionFile, ".jsonl").replace(/\.json$/, "");

      const cost: CostEstimate | undefined =
        data.inputTokens === 0 && data.outputTokens === 0
          ? undefined
          : {
              inputTokens: data.inputTokens,
              outputTokens: data.outputTokens,
              // Gemini pricing varies by model; use approximate
              estimatedCostUsd:
                (data.inputTokens / 1_000_000) * 1.25 + (data.outputTokens / 1_000_000) * 5.0,
            };

      return {
        summary: data.model ? `Gemini session (${data.model})` : "Gemini session",
        summaryIsFallback: true,
        agentSessionId,
        cost,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findGeminiSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await streamGeminiSessionData(sessionFile);
      if (!data?.sessionId) return null;

      const binary = resolvedBinary ?? "gemini";
      const parts: string[] = [shellEscape(binary)];

      appendModelFlags(parts, (project.agentConfig?.model ?? data.model) as string | undefined);
      appendSandboxFlags(parts, project.agentConfig?.permissions);

      // Gemini CLI resume via session ID
      parts.push("--resume", shellEscape(data.sessionId));

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupGeminiWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveGeminiBinary();
        }
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
      if (!session.workspacePath) return;
      await setupGeminiWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createGeminiAgent();
}

/** @internal Clear the session file cache. */
export function _resetSessionFileCache(): void {
  sessionFileCache.clear();
}

export default { manifest, create } satisfies PluginModule<Agent>;
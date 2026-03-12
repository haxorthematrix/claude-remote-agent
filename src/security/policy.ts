import { PolicyConfig, ConfirmationLevel } from "../types/index.js";

/**
 * Check if permissions should be skipped based on Claude CLI flags.
 *
 * When Claude CLI is run with --dangerously-skip-permissions, this should
 * propagate to the remote agent so confirmation prompts are skipped.
 *
 * Supported environment variables:
 * - CLAUDE_SKIP_PERMISSIONS=1 (set by Claude CLI)
 * - CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1 (explicit flag)
 * - CRA_SKIP_CONFIRMATIONS=1 (agent-specific override)
 */
export function shouldSkipPermissions(): boolean {
  return (
    process.env.CLAUDE_SKIP_PERMISSIONS === "1" ||
    process.env.CLAUDE_SKIP_PERMISSIONS === "true" ||
    process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "1" ||
    process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true" ||
    process.env.CRA_SKIP_CONFIRMATIONS === "1" ||
    process.env.CRA_SKIP_CONFIRMATIONS === "true"
  );
}

/**
 * Log a warning when skip permissions mode is active
 */
export function logSkipPermissionsWarning(): void {
  if (shouldSkipPermissions()) {
    console.error(
      "[claude-remote-agent] WARNING: Running with skip-permissions mode. " +
      "All confirmation prompts are bypassed. Commands will execute without confirmation."
    );
  }
}

// Commands considered "destructive"
const DESTRUCTIVE_COMMANDS = [
  "rm",
  "rmdir",
  "kill",
  "killall",
  "pkill",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "systemctl stop",
  "systemctl restart",
  "systemctl disable",
  "service stop",
  "service restart",
  "docker rm",
  "docker stop",
  "docker kill",
  "kubectl delete",
  "drop database",
  "drop table",
  "truncate",
];

// Commands considered "write" operations
const WRITE_COMMANDS = [
  ...DESTRUCTIVE_COMMANDS,
  "mv",
  "cp",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "install",
  "apt-get install",
  "apt install",
  "yum install",
  "dnf install",
  "pacman -S",
  "npm install",
  "pip install",
  "systemctl start",
  "systemctl enable",
  "service start",
  "docker run",
  "docker create",
  "kubectl apply",
  "kubectl create",
  "insert into",
  "update",
  "delete from",
  "git push",
  "git commit",
  "git merge",
];

export interface PolicyCheckResult {
  allowed: boolean;
  requires_confirmation: boolean;
  reason?: string;
  blocked_by?: string;
}

export class PolicyEngine {
  private skipPermissions: boolean;

  constructor() {
    this.skipPermissions = shouldSkipPermissions();
  }

  /**
   * Check if we're in skip-permissions mode
   */
  isSkipPermissionsMode(): boolean {
    return this.skipPermissions;
  }

  /**
   * Refresh skip permissions state (call if env vars change)
   */
  refreshSkipPermissions(): void {
    this.skipPermissions = shouldSkipPermissions();
  }

  /**
   * Check if a command is allowed and whether it requires confirmation
   */
  checkCommand(command: string, policy: PolicyConfig): PolicyCheckResult {
    const normalizedCommand = command.trim().toLowerCase();

    // IMPORTANT: Even in skip-permissions mode, we still enforce:
    // - Blocked commands/patterns (security safeguards)
    // - Allowlists (if configured)
    // - Read-only mode
    // We only skip the confirmation requirement.

    // Check blocked patterns first
    for (const pattern of policy.blocked_patterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(command)) {
        return {
          allowed: false,
          requires_confirmation: false,
          reason: "Command matches blocked pattern",
          blocked_by: pattern,
        };
      }
    }

    // Check blocked commands
    for (const blocked of policy.blocked_commands) {
      if (this.matchesPattern(normalizedCommand, blocked.toLowerCase())) {
        return {
          allowed: false,
          requires_confirmation: false,
          reason: "Command is explicitly blocked",
          blocked_by: blocked,
        };
      }
    }

    // Check allowlist if not wildcard
    if (policy.allowed_commands !== "*" && policy.allowed_commands.length > 0) {
      const isAllowed = policy.allowed_commands.some((allowed) =>
        this.matchesPattern(normalizedCommand, allowed.toLowerCase())
      );

      if (!isAllowed) {
        return {
          allowed: false,
          requires_confirmation: false,
          reason: "Command not in allowlist",
        };
      }
    }

    // Check read-only mode
    if (policy.read_only && this.isWriteCommand(command)) {
      return {
        allowed: false,
        requires_confirmation: false,
        reason: "Host is in read-only mode",
      };
    }

    // Determine if confirmation is required
    // If skip-permissions mode is active, never require confirmation
    let requiresConfirmation = false;
    if (!this.skipPermissions) {
      requiresConfirmation = this.needsConfirmation(
        command,
        policy.confirmation_required
      );
    }

    return {
      allowed: true,
      requires_confirmation: requiresConfirmation,
    };
  }

  /**
   * Check if a command matches a pattern (supports glob-style wildcards)
   */
  private matchesPattern(command: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special chars except *
      .replace(/\*/g, ".*"); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`, "i");
    return regex.test(command);
  }

  /**
   * Check if a command is a write operation
   */
  private isWriteCommand(command: string): boolean {
    const normalizedCommand = command.trim().toLowerCase();
    return WRITE_COMMANDS.some(
      (writeCmd) =>
        normalizedCommand.startsWith(writeCmd) ||
        normalizedCommand.includes(` ${writeCmd}`)
    );
  }

  /**
   * Check if a command is destructive
   */
  private isDestructiveCommand(command: string): boolean {
    const normalizedCommand = command.trim().toLowerCase();
    return DESTRUCTIVE_COMMANDS.some(
      (destructiveCmd) =>
        normalizedCommand.startsWith(destructiveCmd) ||
        normalizedCommand.includes(` ${destructiveCmd}`)
    );
  }

  /**
   * Determine if confirmation is needed based on policy level
   */
  private needsConfirmation(
    command: string,
    level: ConfirmationLevel
  ): boolean {
    switch (level) {
      case "never":
        return false;
      case "always":
        return true;
      case "destructive_only":
        return this.isDestructiveCommand(command);
      case "write_only":
        return this.isWriteCommand(command);
      default:
        return true; // Default to requiring confirmation
    }
  }

  /**
   * Get a human-readable description of a policy
   */
  describePolicySummary(policy: PolicyConfig): string {
    if (policy.read_only) {
      return "read-only";
    }

    switch (policy.confirmation_required) {
      case "never":
        return "relaxed";
      case "destructive_only":
        return "moderate";
      case "write_only":
        return "careful";
      case "always":
        return "strict";
      default:
        return "unknown";
    }
  }
}

// Singleton instance
export const policyEngine = new PolicyEngine();

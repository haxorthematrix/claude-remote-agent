import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { GlobalConfig } from "../types/index.js";
import { OutputSanitizer, SanitizerConfig } from "./sanitizer.js";

export interface AuditLogEntry {
  timestamp: string;
  session_id?: string;
  tool: string;
  host?: string;
  user?: string;
  action: string;
  details?: Record<string, unknown>;
  exit_code?: number;
  duration_ms?: number;
  success: boolean;
  error?: string;
  output_hash?: string;
}

export class AuditLogger {
  private enabled: boolean;
  private logPath: string;
  private logCommands: boolean;
  private logOutput: boolean;
  private maxOutputLogged: number;
  private sessionId: string;
  private initialized: boolean = false;
  private sanitizer: OutputSanitizer;

  constructor(config?: GlobalConfig["audit"], sanitizerConfig?: Partial<SanitizerConfig>) {
    const auditConfig = config || {
      enabled: true,
      log_path: "~/.config/claude-remote-agent/audit.log",
      log_commands: true,
      log_output: true,
      max_output_logged: 10000,
    };

    this.enabled = auditConfig.enabled;
    this.logPath = this.expandPath(auditConfig.log_path);
    this.logCommands = auditConfig.log_commands;
    this.logOutput = auditConfig.log_output;
    this.maxOutputLogged = auditConfig.max_output_logged;
    this.sessionId = this.generateSessionId();
    this.sanitizer = new OutputSanitizer(sanitizerConfig);
  }

  /**
   * Initialize the audit logger (create log directory if needed)
   */
  initialize(): void {
    if (this.initialized || !this.enabled) {
      return;
    }

    try {
      const logDir = path.dirname(this.logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      this.initialized = true;
    } catch (error) {
      console.error(`[audit] Failed to initialize audit log: ${error}`);
      this.enabled = false;
    }
  }

  /**
   * Log a command execution
   */
  logCommand(params: {
    host: string;
    user: string;
    command: string;
    exit_code: number;
    duration_ms: number;
    stdout?: string;
    stderr?: string;
    confirmed_by?: "user" | "policy" | "skip-permissions";
  }): void {
    if (!this.enabled || !this.logCommands) {
      return;
    }

    // Sanitize the command (may contain passwords in arguments)
    const sanitizedCommand = this.sanitizer.sanitize(params.command);

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      tool: "remote_execute",
      host: params.host,
      user: params.user,
      action: sanitizedCommand.output,
      exit_code: params.exit_code,
      duration_ms: params.duration_ms,
      success: params.exit_code === 0,
      details: {
        confirmed_by: params.confirmed_by || "policy",
      },
    };

    // Track if any secrets were redacted
    if (sanitizedCommand.redaction_count > 0) {
      entry.details = {
        ...entry.details,
        secrets_redacted: sanitizedCommand.redaction_count,
        secret_types: sanitizedCommand.detected_types,
      };
    }

    // Add output hash if logging output
    if (this.logOutput && (params.stdout || params.stderr)) {
      const output = (params.stdout || "") + (params.stderr || "");
      entry.output_hash = this.hashOutput(output);

      // Sanitize and truncate output for details
      if (output.length > 0) {
        const sanitizedOutput = this.sanitizer.sanitize(
          output.substring(0, Math.min(500, this.maxOutputLogged))
        );
        entry.details = {
          ...entry.details,
          output_preview: sanitizedOutput.output,
          output_length: output.length,
        };

        // Track output secrets separately
        if (sanitizedOutput.redaction_count > 0) {
          entry.details = {
            ...entry.details,
            output_secrets_redacted: sanitizedOutput.redaction_count,
          };
        }
      }
    }

    this.writeEntry(entry);
  }

  /**
   * Log a file operation
   */
  logFileOperation(params: {
    tool: string;
    host: string;
    user: string;
    path: string;
    operation: "read" | "write" | "edit" | "upload" | "download";
    success: boolean;
    error?: string;
    details?: Record<string, unknown>;
  }): void {
    if (!this.enabled) {
      return;
    }

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      tool: params.tool,
      host: params.host,
      user: params.user,
      action: `${params.operation}: ${params.path}`,
      success: params.success,
      error: params.error,
      details: params.details,
    };

    this.writeEntry(entry);
  }

  /**
   * Log a session operation
   */
  logSession(params: {
    action: "start" | "execute" | "end";
    session_id: string;
    host: string;
    user: string;
    command?: string;
    exit_code?: number;
    duration_ms?: number;
    success: boolean;
    error?: string;
  }): void {
    if (!this.enabled) {
      return;
    }

    // Sanitize the command if present
    let action = params.command || params.action;
    let secretsRedacted = 0;
    if (params.command) {
      const sanitized = this.sanitizer.sanitize(params.command);
      action = sanitized.output;
      secretsRedacted = sanitized.redaction_count;
    }

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: params.session_id,
      tool: `remote_session_${params.action}`,
      host: params.host,
      user: params.user,
      action,
      exit_code: params.exit_code,
      duration_ms: params.duration_ms,
      success: params.success,
      error: params.error,
    };

    if (secretsRedacted > 0) {
      entry.details = { secrets_redacted: secretsRedacted };
    }

    this.writeEntry(entry);
  }

  /**
   * Log an installation operation
   */
  logInstallation(params: {
    host: string;
    user: string;
    success: boolean;
    steps: string[];
    error?: string;
    os_type?: string;
  }): void {
    if (!this.enabled) {
      return;
    }

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      tool: "remote_install_agent",
      host: params.host,
      user: params.user,
      action: "install_agent",
      success: params.success,
      error: params.error,
      details: {
        steps_completed: params.steps,
        os_type: params.os_type,
      },
    };

    this.writeEntry(entry);
  }

  /**
   * Log a generic tool operation
   */
  logToolCall(params: {
    tool: string;
    host?: string;
    action: string;
    success: boolean;
    error?: string;
    details?: Record<string, unknown>;
  }): void {
    if (!this.enabled) {
      return;
    }

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      tool: params.tool,
      host: params.host,
      action: params.action,
      success: params.success,
      error: params.error,
      details: params.details,
    };

    this.writeEntry(entry);
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the log file path
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Check if audit logging is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get the output sanitizer
   */
  getSanitizer(): OutputSanitizer {
    return this.sanitizer;
  }

  /**
   * Read recent audit entries
   */
  readRecentEntries(count: number = 100): AuditLogEntry[] {
    if (!this.enabled || !fs.existsSync(this.logPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const recentLines = lines.slice(-count);

      return recentLines.map((line) => {
        try {
          return JSON.parse(line) as AuditLogEntry;
        } catch {
          return null;
        }
      }).filter((entry): entry is AuditLogEntry => entry !== null);
    } catch (error) {
      console.error(`[audit] Failed to read audit log: ${error}`);
      return [];
    }
  }

  /**
   * Write an entry to the audit log
   */
  private writeEntry(entry: AuditLogEntry): void {
    this.initialize();

    if (!this.enabled) {
      return;
    }

    try {
      const line = JSON.stringify(entry) + "\n";
      fs.appendFileSync(this.logPath, line, { encoding: "utf-8" });
    } catch (error) {
      console.error(`[audit] Failed to write audit entry: ${error}`);
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString("hex");
    return `session-${timestamp}-${random}`;
  }

  /**
   * Hash output for audit trail
   */
  private hashOutput(output: string): string {
    return crypto.createHash("sha256").update(output).digest("hex").substring(0, 16);
  }

  /**
   * Expand ~ and environment variables in path
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith("~")) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
  }
}

// Singleton instance (will be initialized with config)
let auditLogger: AuditLogger | null = null;

/**
 * Get or create the audit logger instance
 */
export function getAuditLogger(
  config?: GlobalConfig["audit"],
  sanitizerConfig?: Partial<SanitizerConfig>
): AuditLogger {
  if (!auditLogger) {
    auditLogger = new AuditLogger(config, sanitizerConfig);
  }
  return auditLogger;
}

/**
 * Initialize the audit logger with config
 */
export function initAuditLogger(
  config: GlobalConfig["audit"],
  sanitizerConfig?: Partial<SanitizerConfig>
): AuditLogger {
  auditLogger = new AuditLogger(config, sanitizerConfig);
  auditLogger.initialize();
  return auditLogger;
}

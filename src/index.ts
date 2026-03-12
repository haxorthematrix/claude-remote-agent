import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { getConfigLoader, ConfigLoader } from "./config/loader.js";
import { SSHConnection } from "./ssh/connection.js";
import { policyEngine, logSkipPermissionsWarning } from "./security/policy.js";
import { initAuditLogger, getAuditLogger, AuditLogger } from "./security/audit.js";
import {
  parseSSHConfig,
  getSSHAlias,
  setSSHAlias,
  removeSSHAlias,
  validateAlias,
  SSHAlias,
} from "./ssh/aliases.js";
import {
  detectOS,
  detectPackageManager,
  checkNodeInstalled,
  installOnRemote,
  getQuickInstallCommand,
} from "./installer/remote-install.js";
import {
  RemoteExecuteParams,
  RemoteFileReadParams,
  RemoteFileWriteParams,
} from "./types/index.js";

// Connection pool
const connectionPool: Map<string, SSHConnection> = new Map();

// Session state (for interactive sessions)
interface Session {
  id: string;
  host: string;
  connection: SSHConnection;
  workingDir: string;
  env: Record<string, string>;
  createdAt: Date;
}

const sessions: Map<string, Session> = new Map();

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "remote_execute",
    description:
      "Execute a command on a remote host via SSH. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration or group name",
        },
        command: {
          type: "string",
          description: "Command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 300)",
        },
        working_dir: {
          type: "string",
          description: "Working directory for command",
        },
        env: {
          type: "object",
          description: "Additional environment variables",
          additionalProperties: { type: "string" },
        },
      },
      required: ["host", "command"],
    },
  },
  {
    name: "remote_file_read",
    description: "Read a file from a remote host",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        offset: {
          type: "number",
          description: "Start line (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Number of lines to read",
        },
      },
      required: ["host", "path"],
    },
  },
  {
    name: "remote_file_write",
    description: "Write content to a file on a remote host",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        content: {
          type: "string",
          description: "Content to write",
        },
        mode: {
          type: "string",
          description: "File permissions (e.g., '0644')",
        },
        backup: {
          type: "boolean",
          description: "Create backup before overwriting",
        },
      },
      required: ["host", "path", "content"],
    },
  },
  {
    name: "remote_file_edit",
    description:
      "Edit a file on a remote host using find/replace. Similar to the local Edit tool but for remote files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        old_string: {
          type: "string",
          description: "The text to find and replace",
        },
        new_string: {
          type: "string",
          description: "The text to replace it with",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default: false, replaces first only)",
        },
      },
      required: ["host", "path", "old_string", "new_string"],
    },
  },
  {
    name: "remote_upload",
    description:
      "Upload a local file to a remote host via SFTP. Transfers a file from the local machine to the remote server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        local_path: {
          type: "string",
          description: "Path to the local file to upload",
        },
        remote_path: {
          type: "string",
          description: "Destination path on the remote host",
        },
        mode: {
          type: "string",
          description: "File permissions (e.g., '0644')",
        },
      },
      required: ["host", "local_path", "remote_path"],
    },
  },
  {
    name: "remote_download",
    description:
      "Download a file from a remote host to the local machine via SFTP.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        remote_path: {
          type: "string",
          description: "Path to the file on the remote host",
        },
        local_path: {
          type: "string",
          description: "Destination path on the local machine",
        },
      },
      required: ["host", "remote_path", "local_path"],
    },
  },
  {
    name: "remote_list_hosts",
    description: "List all configured remote hosts with their status and policies",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "remote_session_start",
    description:
      "Start an interactive session on a remote host. Use this for multi-command workflows that need to maintain state (like working directory).",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration",
        },
        working_dir: {
          type: "string",
          description: "Initial working directory",
        },
        env: {
          type: "object",
          description: "Environment variables for the session",
          additionalProperties: { type: "string" },
        },
      },
      required: ["host"],
    },
  },
  {
    name: "remote_session_execute",
    description: "Execute a command in an existing session",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from remote_session_start",
        },
        command: {
          type: "string",
          description: "Command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds",
        },
      },
      required: ["session_id", "command"],
    },
  },
  {
    name: "remote_session_end",
    description: "End an interactive session",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to end",
        },
      },
      required: ["session_id"],
    },
  },
  // SSH Alias Management Tools
  {
    name: "ssh_alias_list",
    description:
      "List all SSH aliases configured in ~/.ssh/config. Shows hostname, port, user, and identity file for each alias.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ssh_alias_add",
    description:
      "Add or update an SSH alias in ~/.ssh/config. This creates a shortcut name for connecting to a remote host.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Alias name (e.g., 'my-server', 'prod-db')",
        },
        hostname: {
          type: "string",
          description: "IP address or hostname of the remote server",
        },
        port: {
          type: "number",
          description: "SSH port (default: 22)",
        },
        user: {
          type: "string",
          description: "Username for SSH connection",
        },
        identity_file: {
          type: "string",
          description: "Path to SSH private key (e.g., ~/.ssh/id_ed25519)",
        },
        proxy_jump: {
          type: "string",
          description: "Bastion/jump host alias to connect through",
        },
      },
      required: ["name", "hostname"],
    },
  },
  {
    name: "ssh_alias_remove",
    description: "Remove an SSH alias from ~/.ssh/config",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Alias name to remove",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "ssh_alias_get",
    description: "Get details of a specific SSH alias",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Alias name to look up",
        },
      },
      required: ["name"],
    },
  },
  // Installation Tools
  {
    name: "remote_install_agent",
    description:
      "Install the Claude Remote Agent on a remote Linux system. Automatically detects OS and package manager, installs Node.js if needed, and sets up the agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration or SSH alias",
        },
        install_node: {
          type: "boolean",
          description: "Install Node.js if not present (default: true)",
        },
        node_version: {
          type: "string",
          description: "Node.js major version to install (default: '20')",
        },
        install_dir: {
          type: "string",
          description: "Installation directory (default: /opt/claude-remote-agent)",
        },
        create_service: {
          type: "boolean",
          description: "Create systemd service (default: false)",
        },
      },
      required: ["host"],
    },
  },
  {
    name: "remote_detect_system",
    description:
      "Detect OS, package manager, and Node.js status on a remote system. Useful before installation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Host name from configuration or SSH alias",
        },
      },
      required: ["host"],
    },
  },
  {
    name: "remote_add_host",
    description:
      "Add a new remote host to the Claude Remote Agent configuration. Creates both SSH alias and agent host config.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Host name/alias (e.g., 'my-server')",
        },
        hostname: {
          type: "string",
          description: "IP address or hostname",
        },
        port: {
          type: "number",
          description: "SSH port (default: 22)",
        },
        user: {
          type: "string",
          description: "SSH username",
        },
        identity_file: {
          type: "string",
          description: "Path to SSH private key",
        },
        policy: {
          type: "string",
          enum: ["relaxed", "moderate", "strict", "read-only"],
          description: "Security policy level (default: moderate)",
        },
        labels: {
          type: "object",
          description: "Labels for organizing hosts (e.g., {environment: 'prod'})",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name", "hostname", "user"],
    },
  },
  {
    name: "get_install_command",
    description:
      "Get a one-liner curl command that can be run via basic SSH to install the agent on a remote system.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_version: {
          type: "string",
          description: "Node.js version (default: '20')",
        },
      },
      required: [],
    },
  },
  {
    name: "remote_permissions_status",
    description:
      "Check the current permissions status. Shows if skip-permissions mode is active (from Claude CLI --dangerously-skip-permissions flag).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "audit_log_query",
    description:
      "Query the audit log to see recent remote operations. Useful for reviewing what commands have been executed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        count: {
          type: "number",
          description: "Number of recent entries to retrieve (default: 20, max: 100)",
        },
        host: {
          type: "string",
          description: "Filter by host name",
        },
        tool: {
          type: "string",
          description: "Filter by tool name (e.g., 'remote_execute', 'remote_file_write')",
        },
        success_only: {
          type: "boolean",
          description: "Only show successful operations",
        },
      },
      required: [],
    },
  },
];

export async function createServer(configDir?: string): Promise<Server> {
  // Check for skip-permissions mode and log warning
  logSkipPermissionsWarning();

  // Load configuration
  const configLoader = getConfigLoader(configDir);
  await configLoader.load();

  // Initialize audit logger
  const globalConfig = configLoader.getGlobalConfig();
  const auditLogger = initAuditLogger(globalConfig.audit);
  if (auditLogger.isEnabled()) {
    console.error(`[claude-remote-agent] Audit logging enabled: ${auditLogger.getLogPath()}`);
  }

  const server = new Server(
    {
      name: "claude-remote-agent",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const toolArgs = args || {};

      switch (name) {
        case "remote_execute":
          return await handleRemoteExecute(configLoader, toolArgs as unknown as RemoteExecuteParams);

        case "remote_file_read":
          return await handleRemoteFileRead(configLoader, toolArgs as unknown as RemoteFileReadParams);

        case "remote_file_write":
          return await handleRemoteFileWrite(configLoader, toolArgs as unknown as RemoteFileWriteParams);

        case "remote_file_edit":
          return await handleRemoteFileEdit(configLoader, toolArgs as unknown as {
            host: string;
            path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          });

        case "remote_upload":
          return await handleRemoteUpload(configLoader, toolArgs as unknown as {
            host: string;
            local_path: string;
            remote_path: string;
            mode?: string;
          });

        case "remote_download":
          return await handleRemoteDownload(configLoader, toolArgs as unknown as {
            host: string;
            remote_path: string;
            local_path: string;
          });

        case "remote_list_hosts":
          return await handleListHosts(configLoader);

        case "remote_session_start":
          return await handleSessionStart(configLoader, toolArgs as unknown as { host: string; working_dir?: string; env?: Record<string, string> });

        case "remote_session_execute":
          return await handleSessionExecute(configLoader, toolArgs as unknown as { session_id: string; command: string; timeout?: number });

        case "remote_session_end":
          return await handleSessionEnd(configLoader, toolArgs as unknown as { session_id: string });

        // SSH Alias Management
        case "ssh_alias_list":
          return handleSSHAliasList();

        case "ssh_alias_add":
          return handleSSHAliasAdd(toolArgs as unknown as {
            name: string;
            hostname: string;
            port?: number;
            user?: string;
            identity_file?: string;
            proxy_jump?: string;
          });

        case "ssh_alias_remove":
          return handleSSHAliasRemove(toolArgs as unknown as { name: string });

        case "ssh_alias_get":
          return handleSSHAliasGet(toolArgs as unknown as { name: string });

        // Installation Tools
        case "remote_install_agent":
          return await handleRemoteInstallAgent(configLoader, toolArgs as unknown as {
            host: string;
            install_node?: boolean;
            node_version?: string;
            install_dir?: string;
            create_service?: boolean;
          });

        case "remote_detect_system":
          return await handleRemoteDetectSystem(configLoader, toolArgs as unknown as { host: string });

        case "remote_add_host":
          return await handleRemoteAddHost(configLoader, toolArgs as unknown as {
            name: string;
            hostname: string;
            port?: number;
            user: string;
            identity_file?: string;
            policy?: string;
            labels?: Record<string, string>;
          });

        case "get_install_command":
          return handleGetInstallCommand(toolArgs as unknown as { node_version?: string });

        case "remote_permissions_status":
          return handlePermissionsStatus();

        case "audit_log_query":
          return handleAuditLogQuery(toolArgs as unknown as {
            count?: number;
            host?: string;
            tool?: string;
            success_only?: boolean;
          });

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Tool handlers

async function handleRemoteExecute(
  configLoader: ConfigLoader,
  params: RemoteExecuteParams
) {
  const { host, command, timeout, working_dir, env } = params;
  const auditLogger = getAuditLogger();

  // Resolve hosts (could be a group)
  const hostNames = configLoader.resolveHosts(host);
  const results: Array<{
    host: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    duration_ms: number;
  }> = [];

  for (const hostName of hostNames) {
    const hostConfig = configLoader.getHost(hostName);
    if (!hostConfig) {
      throw new Error(`Unknown host: ${hostName}`);
    }

    // Check policy
    const policy = configLoader.getEffectivePolicy(hostName);
    const policyCheck = policyEngine.checkCommand(command, policy);

    if (!policyCheck.allowed) {
      auditLogger.logCommand({
        host: hostName,
        user: hostConfig.user,
        command,
        exit_code: -1,
        duration_ms: 0,
        confirmed_by: "policy",
      });
      throw new Error(
        `Command blocked on ${hostName}: ${policyCheck.reason}` +
          (policyCheck.blocked_by ? ` (rule: ${policyCheck.blocked_by})` : "")
      );
    }

    // Get or create connection
    let connection = connectionPool.get(hostName);
    if (!connection) {
      connection = new SSHConnection(hostName, hostConfig);
      connectionPool.set(hostName, connection);
    }

    // Execute command
    const result = await connection.exec(command, {
      timeout: timeout ? timeout * 1000 : undefined,
      working_dir,
      env,
    });

    // Audit log the command execution
    auditLogger.logCommand({
      host: hostName,
      user: hostConfig.user,
      command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      stdout: result.stdout,
      stderr: result.stderr,
      confirmed_by: policyEngine.isSkipPermissionsMode() ? "skip-permissions" : "policy",
    });

    results.push({
      host: hostName,
      ...result,
    });
  }

  // Format output
  if (results.length === 1) {
    const r = results[0];
    let output = `Host: ${r.host}\nExit code: ${r.exit_code}\nDuration: ${r.duration_ms}ms\n`;
    if (r.stdout) output += `\nSTDOUT:\n${r.stdout}`;
    if (r.stderr) output += `\nSTDERR:\n${r.stderr}`;
    return { content: [{ type: "text", text: output }] };
  } else {
    const output = results
      .map((r) => {
        let text = `=== ${r.host} ===\nExit code: ${r.exit_code}\n`;
        if (r.stdout) text += `STDOUT:\n${r.stdout}\n`;
        if (r.stderr) text += `STDERR:\n${r.stderr}\n`;
        return text;
      })
      .join("\n");
    return { content: [{ type: "text", text: output }] };
  }
}

async function handleRemoteFileRead(
  configLoader: ConfigLoader,
  params: RemoteFileReadParams
) {
  const { host, path: filePath, offset, limit } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  let connection = connectionPool.get(host);
  if (!connection) {
    connection = new SSHConnection(host, hostConfig);
    connectionPool.set(host, connection);
  }

  let content: string;
  try {
    content = await connection.readFile(filePath);
    auditLogger.logFileOperation({
      tool: "remote_file_read",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "read",
      success: true,
      details: { offset, limit, size: content.length },
    });
  } catch (error) {
    auditLogger.logFileOperation({
      tool: "remote_file_read",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "read",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // Apply offset and limit
  let lines = content.split("\n");
  if (offset) {
    lines = lines.slice(offset - 1);
  }
  if (limit) {
    lines = lines.slice(0, limit);
  }

  // Add line numbers
  const startLine = offset || 1;
  const numberedContent = lines
    .map((line, i) => `${String(startLine + i).padStart(6)}  ${line}`)
    .join("\n");

  return {
    content: [{ type: "text", text: numberedContent }],
  };
}

async function handleRemoteFileWrite(
  configLoader: ConfigLoader,
  params: RemoteFileWriteParams
) {
  const { host, path: filePath, content, mode, backup } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  // Check policy for write operations
  const policy = configLoader.getEffectivePolicy(host);
  if (policy.read_only) {
    auditLogger.logFileOperation({
      tool: "remote_file_write",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "write",
      success: false,
      error: "Host is in read-only mode",
    });
    throw new Error(`Host ${host} is in read-only mode`);
  }

  let connection = connectionPool.get(host);
  if (!connection) {
    connection = new SSHConnection(host, hostConfig);
    connectionPool.set(host, connection);
  }

  // Create backup if requested
  if (backup) {
    try {
      const existing = await connection.readFile(filePath);
      await connection.writeFile(`${filePath}.bak`, existing);
    } catch {
      // File might not exist, that's okay
    }
  }

  try {
    const modeNum = mode ? parseInt(mode, 8) : undefined;
    await connection.writeFile(filePath, content, { mode: modeNum });
    auditLogger.logFileOperation({
      tool: "remote_file_write",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "write",
      success: true,
      details: { size: content.length, mode, backup },
    });
  } catch (error) {
    auditLogger.logFileOperation({
      tool: "remote_file_write",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "write",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return {
    content: [{ type: "text", text: `File written successfully: ${filePath}` }],
  };
}

async function handleRemoteFileEdit(
  configLoader: ConfigLoader,
  params: {
    host: string;
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }
) {
  const { host, path: filePath, old_string, new_string, replace_all } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  // Check policy for write operations
  const policy = configLoader.getEffectivePolicy(host);
  if (policy.read_only) {
    auditLogger.logFileOperation({
      tool: "remote_file_edit",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "edit",
      success: false,
      error: "Host is in read-only mode",
    });
    throw new Error(`Host ${host} is in read-only mode`);
  }

  let connection = connectionPool.get(host);
  if (!connection) {
    connection = new SSHConnection(host, hostConfig);
    connectionPool.set(host, connection);
  }

  // Read current content
  const content = await connection.readFile(filePath);

  // Check if old_string exists
  if (!content.includes(old_string)) {
    auditLogger.logFileOperation({
      tool: "remote_file_edit",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "edit",
      success: false,
      error: "Text not found in file",
    });
    throw new Error(
      `Could not find the specified text in ${filePath}. ` +
      `Make sure the old_string matches exactly (including whitespace).`
    );
  }

  // Check for uniqueness if not replacing all
  const occurrences = content.split(old_string).length - 1;
  if (!replace_all && occurrences > 1) {
    auditLogger.logFileOperation({
      tool: "remote_file_edit",
      host,
      user: hostConfig.user,
      path: filePath,
      operation: "edit",
      success: false,
      error: `Multiple occurrences found (${occurrences})`,
    });
    throw new Error(
      `Found ${occurrences} occurrences of the specified text. ` +
      `Either use replace_all: true, or provide more context to make the match unique.`
    );
  }

  // Perform replacement
  let newContent: string;
  if (replace_all) {
    newContent = content.split(old_string).join(new_string);
  } else {
    newContent = content.replace(old_string, new_string);
  }

  // Write back
  await connection.writeFile(filePath, newContent);

  const replacements = replace_all ? occurrences : 1;
  auditLogger.logFileOperation({
    tool: "remote_file_edit",
    host,
    user: hostConfig.user,
    path: filePath,
    operation: "edit",
    success: true,
    details: { replacements, replace_all },
  });

  return {
    content: [
      {
        type: "text",
        text: `File edited successfully: ${filePath}\n` +
          `Replaced ${replacements} occurrence(s).`,
      },
    ],
  };
}

async function handleRemoteUpload(
  configLoader: ConfigLoader,
  params: {
    host: string;
    local_path: string;
    remote_path: string;
    mode?: string;
  }
) {
  const { host, local_path, remote_path, mode } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  // Check policy for write operations
  const policy = configLoader.getEffectivePolicy(host);
  if (policy.read_only) {
    auditLogger.logFileOperation({
      tool: "remote_upload",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "upload",
      success: false,
      error: "Host is in read-only mode",
    });
    throw new Error(`Host ${host} is in read-only mode`);
  }

  let connection = connectionPool.get(host);
  if (!connection) {
    connection = new SSHConnection(host, hostConfig);
    connectionPool.set(host, connection);
  }

  // Get file size for confirmation
  const fs = await import("fs");
  const expandedPath = local_path.replace(/^~/, process.env.HOME || "");
  const stats = fs.statSync(expandedPath);
  const sizeKB = (stats.size / 1024).toFixed(2);

  try {
    const modeNum = mode ? parseInt(mode, 8) : undefined;
    await connection.uploadFile(local_path, remote_path, { mode: modeNum });
    auditLogger.logFileOperation({
      tool: "remote_upload",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "upload",
      success: true,
      details: { local_path, size: stats.size, mode },
    });
  } catch (error) {
    auditLogger.logFileOperation({
      tool: "remote_upload",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "upload",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return {
    content: [
      {
        type: "text",
        text: `File uploaded successfully!\n` +
          `  Local: ${local_path}\n` +
          `  Remote: ${host}:${remote_path}\n` +
          `  Size: ${sizeKB} KB`,
      },
    ],
  };
}

async function handleRemoteDownload(
  configLoader: ConfigLoader,
  params: {
    host: string;
    remote_path: string;
    local_path: string;
  }
) {
  const { host, remote_path, local_path } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  let connection = connectionPool.get(host);
  if (!connection) {
    connection = new SSHConnection(host, hostConfig);
    connectionPool.set(host, connection);
  }

  // Get remote file stats first
  const remoteStats = await connection.stat(remote_path);
  if (remoteStats.isDirectory) {
    auditLogger.logFileOperation({
      tool: "remote_download",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "download",
      success: false,
      error: "Path is a directory",
    });
    throw new Error(`${remote_path} is a directory. Only files can be downloaded.`);
  }

  try {
    await connection.downloadFile(remote_path, local_path);
    auditLogger.logFileOperation({
      tool: "remote_download",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "download",
      success: true,
      details: { local_path, size: remoteStats.size },
    });
  } catch (error) {
    auditLogger.logFileOperation({
      tool: "remote_download",
      host,
      user: hostConfig.user,
      path: remote_path,
      operation: "download",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const sizeKB = (remoteStats.size / 1024).toFixed(2);

  return {
    content: [
      {
        type: "text",
        text: `File downloaded successfully!\n` +
          `  Remote: ${host}:${remote_path}\n` +
          `  Local: ${local_path}\n` +
          `  Size: ${sizeKB} KB`,
      },
    ],
  };
}

async function handleListHosts(configLoader: ConfigLoader) {
  const hosts = configLoader.listHosts();

  const lines = hosts.map((h) => {
    const policy = configLoader.getEffectivePolicy(h.name);
    const policySummary = policyEngine.describePolicySummary(policy);
    const connection = connectionPool.get(h.name);
    const connected = connection?.isConnected() ?? false;

    const labels = Object.entries(h.config.labels || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

    return `${h.name}:
  Host: ${h.config.hostname}:${h.config.port}
  User: ${h.config.user}
  Status: ${connected ? "connected" : "disconnected"}
  Policy: ${policySummary}
  Labels: ${labels || "(none)"}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n\n") }],
  };
}

async function handleSessionStart(
  configLoader: ConfigLoader,
  params: { host: string; working_dir?: string; env?: Record<string, string> }
) {
  const { host, working_dir, env } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  const connection = new SSHConnection(host, hostConfig);
  await connection.connect();

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  sessions.set(sessionId, {
    id: sessionId,
    host,
    connection,
    workingDir: working_dir || "~",
    env: env || {},
    createdAt: new Date(),
  });

  auditLogger.logSession({
    action: "start",
    session_id: sessionId,
    host,
    user: hostConfig.user,
    success: true,
  });

  return {
    content: [
      {
        type: "text",
        text: `Session started: ${sessionId}\nHost: ${host}\nWorking directory: ${working_dir || "~"}`,
      },
    ],
  };
}

async function handleSessionExecute(
  configLoader: ConfigLoader,
  params: { session_id: string; command: string; timeout?: number }
) {
  const { session_id, command, timeout } = params;
  const auditLogger = getAuditLogger();

  const session = sessions.get(session_id);
  if (!session) {
    throw new Error(`Unknown session: ${session_id}`);
  }

  const hostConfig = configLoader.getHost(session.host);

  // Check policy
  const policy = configLoader.getEffectivePolicy(session.host);
  const policyCheck = policyEngine.checkCommand(command, policy);

  if (!policyCheck.allowed) {
    auditLogger.logSession({
      action: "execute",
      session_id,
      host: session.host,
      user: hostConfig?.user || "unknown",
      command,
      exit_code: -1,
      success: false,
      error: policyCheck.reason,
    });
    throw new Error(`Command blocked: ${policyCheck.reason}`);
  }

  const result = await session.connection.exec(command, {
    timeout: timeout ? timeout * 1000 : undefined,
    working_dir: session.workingDir,
    env: session.env,
  });

  auditLogger.logSession({
    action: "execute",
    session_id,
    host: session.host,
    user: hostConfig?.user || "unknown",
    command,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    success: result.exit_code === 0,
  });

  let output = `Exit code: ${result.exit_code}\nDuration: ${result.duration_ms}ms`;
  if (result.stdout) output += `\n\nSTDOUT:\n${result.stdout}`;
  if (result.stderr) output += `\n\nSTDERR:\n${result.stderr}`;

  return { content: [{ type: "text", text: output }] };
}

async function handleSessionEnd(
  configLoader: ConfigLoader,
  params: { session_id: string }
) {
  const { session_id } = params;
  const auditLogger = getAuditLogger();

  const session = sessions.get(session_id);
  if (!session) {
    throw new Error(`Unknown session: ${session_id}`);
  }

  const hostConfig = configLoader.getHost(session.host);

  session.connection.disconnect();
  sessions.delete(session_id);

  auditLogger.logSession({
    action: "end",
    session_id,
    host: session.host,
    user: hostConfig?.user || "unknown",
    success: true,
  });

  return {
    content: [{ type: "text", text: `Session ended: ${session_id}` }],
  };
}

// SSH Alias Management Handlers

function handleSSHAliasList() {
  const aliases = parseSSHConfig();

  if (aliases.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No SSH aliases configured in ~/.ssh/config\n\nUse ssh_alias_add to create one.",
        },
      ],
    };
  }

  const lines = aliases.map((a) => {
    let info = `${a.name}:\n  Hostname: ${a.hostname || "(not set)"}`;
    if (a.port) info += `\n  Port: ${a.port}`;
    if (a.user) info += `\n  User: ${a.user}`;
    if (a.identityFile) info += `\n  IdentityFile: ${a.identityFile}`;
    if (a.proxyJump) info += `\n  ProxyJump: ${a.proxyJump}`;
    return info;
  });

  return {
    content: [{ type: "text", text: `SSH Aliases (${aliases.length}):\n\n${lines.join("\n\n")}` }],
  };
}

function handleSSHAliasAdd(params: {
  name: string;
  hostname: string;
  port?: number;
  user?: string;
  identity_file?: string;
  proxy_jump?: string;
}) {
  const alias: SSHAlias = {
    name: params.name,
    hostname: params.hostname,
    port: params.port,
    user: params.user,
    identityFile: params.identity_file,
    proxyJump: params.proxy_jump,
  };

  // Validate
  const errors = validateAlias(alias);
  if (errors.length > 0) {
    return {
      content: [{ type: "text", text: `Validation errors:\n${errors.join("\n")}` }],
      isError: true,
    };
  }

  // Check if updating existing
  const existing = getSSHAlias(params.name);
  const action = existing ? "Updated" : "Added";

  setSSHAlias(alias);

  let summary = `${action} SSH alias '${params.name}':\n`;
  summary += `  Hostname: ${params.hostname}\n`;
  if (params.port) summary += `  Port: ${params.port}\n`;
  if (params.user) summary += `  User: ${params.user}\n`;
  if (params.identity_file) summary += `  IdentityFile: ${params.identity_file}\n`;
  if (params.proxy_jump) summary += `  ProxyJump: ${params.proxy_jump}\n`;
  summary += `\nYou can now use: ssh ${params.name}`;

  return {
    content: [{ type: "text", text: summary }],
  };
}

function handleSSHAliasRemove(params: { name: string }) {
  const removed = removeSSHAlias(params.name);

  if (!removed) {
    return {
      content: [{ type: "text", text: `SSH alias '${params.name}' not found` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Removed SSH alias '${params.name}'` }],
  };
}

function handleSSHAliasGet(params: { name: string }) {
  const alias = getSSHAlias(params.name);

  if (!alias) {
    return {
      content: [{ type: "text", text: `SSH alias '${params.name}' not found` }],
      isError: true,
    };
  }

  let info = `SSH Alias: ${alias.name}\n`;
  info += `  Hostname: ${alias.hostname}\n`;
  if (alias.port) info += `  Port: ${alias.port}\n`;
  if (alias.user) info += `  User: ${alias.user}\n`;
  if (alias.identityFile) info += `  IdentityFile: ${alias.identityFile}\n`;
  if (alias.proxyJump) info += `  ProxyJump: ${alias.proxyJump}\n`;

  return {
    content: [{ type: "text", text: info }],
  };
}

// Installation Handlers

async function handleRemoteInstallAgent(
  configLoader: ConfigLoader,
  params: {
    host: string;
    install_node?: boolean;
    node_version?: string;
    install_dir?: string;
    create_service?: boolean;
  }
) {
  const { host, install_node, node_version, install_dir, create_service } = params;
  const auditLogger = getAuditLogger();

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}. Add it first with remote_add_host or ssh_alias_add.`);
  }

  const connection = new SSHConnection(host, hostConfig);

  const progressLog: string[] = [];
  const result = await installOnRemote(
    connection,
    {
      installNode: install_node ?? true,
      nodeVersion: node_version || "20",
      installDir: install_dir || "/opt/claude-remote-agent",
      createService: create_service ?? false,
    },
    (step, output) => {
      progressLog.push(`[${new Date().toISOString()}] ${step}`);
      if (output) {
        progressLog.push(output.substring(0, 500)); // Truncate long outputs
      }
    }
  );

  connection.disconnect();

  // Log installation to audit
  auditLogger.logInstallation({
    host,
    user: hostConfig.user,
    success: result.success,
    steps: result.steps,
    error: result.success ? undefined : result.message,
    os_type: result.osType,
  });

  let output = result.success
    ? `Installation successful on ${host}!\n\n`
    : `Installation failed on ${host}\n\n`;

  output += `Steps completed:\n${result.steps.map((s) => `  - ${s}`).join("\n")}\n\n`;

  if (!result.success) {
    output += `Error: ${result.message}\n`;
  }

  return {
    content: [{ type: "text", text: output }],
    isError: !result.success,
  };
}

async function handleRemoteDetectSystem(
  configLoader: ConfigLoader,
  params: { host: string }
) {
  const { host } = params;

  const hostConfig = configLoader.getHost(host);
  if (!hostConfig) {
    throw new Error(`Unknown host: ${host}`);
  }

  const connection = new SSHConnection(host, hostConfig);
  await connection.connect();

  const os = await detectOS(connection);
  const pkgManager = await detectPackageManager(connection);
  const nodeStatus = await checkNodeInstalled(connection);

  connection.disconnect();

  let output = `System detection for ${host}:\n\n`;
  output += `OS: ${os.distro} ${os.version}\n`;
  output += `Architecture: ${os.arch}\n`;
  output += `Package Manager: ${pkgManager}\n`;
  output += `Node.js: ${nodeStatus.installed ? `v${nodeStatus.version}` : "Not installed"}\n`;

  if (!nodeStatus.installed) {
    output += `\nNode.js will be installed automatically when running remote_install_agent.`;
  }

  return {
    content: [{ type: "text", text: output }],
  };
}

async function handleRemoteAddHost(
  configLoader: ConfigLoader,
  params: {
    name: string;
    hostname: string;
    port?: number;
    user: string;
    identity_file?: string;
    policy?: string;
    labels?: Record<string, string>;
  }
) {
  const { name, hostname, port, user, identity_file, policy, labels } = params;

  // 1. Add SSH alias
  const alias: SSHAlias = {
    name,
    hostname,
    port: port || 22,
    user,
    identityFile: identity_file,
  };

  const errors = validateAlias(alias);
  if (errors.length > 0) {
    return {
      content: [{ type: "text", text: `Validation errors:\n${errors.join("\n")}` }],
      isError: true,
    };
  }

  setSSHAlias(alias);

  // 2. Add to hosts.yaml
  // For now, we'll generate the YAML snippet for the user to add
  // In a full implementation, we'd write directly to hosts.yaml

  const policyLevel = policy || "moderate";
  const policyConfig: Record<string, unknown> = {};

  switch (policyLevel) {
    case "relaxed":
      policyConfig.confirmation_required = "never";
      break;
    case "moderate":
      policyConfig.confirmation_required = "destructive_only";
      break;
    case "strict":
      policyConfig.confirmation_required = "always";
      break;
    case "read-only":
      policyConfig.confirmation_required = "always";
      policyConfig.read_only = true;
      break;
  }

  const hostYaml = `
  ${name}:
    hostname: ${hostname}
    port: ${port || 22}
    user: ${user}
    auth:
      type: key
      key_path: ${identity_file || "~/.ssh/id_ed25519"}
    policy:
      confirmation_required: ${policyConfig.confirmation_required}${policyConfig.read_only ? "\n      read_only: true" : ""}
    labels:${labels ? Object.entries(labels).map(([k, v]) => `\n      ${k}: ${v}`).join("") : "\n      {}"}
`;

  let output = `Host '${name}' configured!\n\n`;
  output += `1. SSH alias added to ~/.ssh/config\n`;
  output += `   You can now run: ssh ${name}\n\n`;
  output += `2. Add this to ~/.config/claude-remote-agent/hosts.yaml:\n`;
  output += `\`\`\`yaml${hostYaml}\`\`\`\n\n`;
  output += `3. Test connection: claude-remote-agent test ${name}\n`;
  output += `4. Install agent: Use remote_install_agent tool`;

  return {
    content: [{ type: "text", text: output }],
  };
}

function handleGetInstallCommand(params: { node_version?: string }) {
  const command = getQuickInstallCommand(params.node_version || "20");

  const output = `One-liner installation command:

\`\`\`bash
${command}
\`\`\`

You can run this via basic SSH:
\`\`\`bash
ssh user@host '${command}'
\`\`\`

This will:
1. Download the installation script
2. Install Node.js if needed
3. Clone and build claude-remote-agent
4. Create /usr/local/bin/claude-remote-agent symlink
5. Initialize default configuration`;

  return {
    content: [{ type: "text", text: output }],
  };
}

function handlePermissionsStatus() {
  const skipMode = policyEngine.isSkipPermissionsMode();

  let output = `Permissions Status\n${"=".repeat(40)}\n\n`;

  if (skipMode) {
    output += `Mode: SKIP PERMISSIONS (--dangerously-skip-permissions)\n\n`;
    output += `WARNING: Confirmation prompts are DISABLED.\n`;
    output += `All commands will execute immediately without confirmation.\n\n`;
    output += `Security safeguards still active:\n`;
    output += `  - Blocked commands/patterns are still enforced\n`;
    output += `  - Allowlists are still enforced\n`;
    output += `  - Read-only mode is still enforced\n`;
  } else {
    output += `Mode: NORMAL\n\n`;
    output += `Confirmation prompts are enabled based on per-host policy:\n`;
    output += `  - "never": No confirmation required\n`;
    output += `  - "destructive_only": Confirm rm, kill, restart, etc.\n`;
    output += `  - "write_only": Confirm any write operations\n`;
    output += `  - "always": Confirm every command\n`;
  }

  output += `\nEnvironment variables checked:\n`;
  output += `  CLAUDE_SKIP_PERMISSIONS: ${process.env.CLAUDE_SKIP_PERMISSIONS || "(not set)"}\n`;
  output += `  CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: ${process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS || "(not set)"}\n`;
  output += `  CRA_SKIP_CONFIRMATIONS: ${process.env.CRA_SKIP_CONFIRMATIONS || "(not set)"}\n`;

  return {
    content: [{ type: "text", text: output }],
  };
}

function handleAuditLogQuery(params: {
  count?: number;
  host?: string;
  tool?: string;
  success_only?: boolean;
}) {
  const auditLogger = getAuditLogger();

  if (!auditLogger.isEnabled()) {
    return {
      content: [
        {
          type: "text",
          text: "Audit logging is disabled. Enable it in config.yaml:\n\n" +
            "global:\n  audit:\n    enabled: true",
        },
      ],
    };
  }

  const count = Math.min(params.count || 20, 100);
  let entries = auditLogger.readRecentEntries(count * 2); // Get extra for filtering

  // Apply filters
  if (params.host) {
    entries = entries.filter((e) => e.host === params.host);
  }
  if (params.tool) {
    entries = entries.filter((e) => e.tool === params.tool);
  }
  if (params.success_only) {
    entries = entries.filter((e) => e.success);
  }

  // Limit to requested count
  entries = entries.slice(-count);

  if (entries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No audit log entries found matching the criteria.\n" +
            `Log file: ${auditLogger.getLogPath()}`,
        },
      ],
    };
  }

  // Format output
  const lines = entries.map((entry) => {
    const status = entry.success ? "✓" : "✗";
    const time = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
    let line = `[${time}] ${status} ${entry.tool}`;
    if (entry.host) line += ` @ ${entry.host}`;
    line += `\n  Action: ${entry.action}`;
    if (entry.exit_code !== undefined) line += `\n  Exit: ${entry.exit_code}`;
    if (entry.duration_ms !== undefined) line += ` (${entry.duration_ms}ms)`;
    if (entry.error) line += `\n  Error: ${entry.error}`;
    return line;
  });

  let output = `Audit Log (${entries.length} entries)\n`;
  output += `Session: ${auditLogger.getSessionId()}\n`;
  output += `Log file: ${auditLogger.getLogPath()}\n`;
  output += "─".repeat(50) + "\n\n";
  output += lines.join("\n\n");

  return {
    content: [{ type: "text", text: output }],
  };
}

// Cleanup on exit
process.on("exit", () => {
  for (const connection of connectionPool.values()) {
    connection.disconnect();
  }
  for (const session of sessions.values()) {
    session.connection.disconnect();
  }
});

// Start server if run directly
export async function main() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

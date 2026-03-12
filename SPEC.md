# Claude Remote Agent Specification

## Overview

The Claude Remote Agent (CRA) enables Claude CLI to interact with remote Linux systems in real-time via SSH. It acts as an MCP (Model Context Protocol) server that provides tools for remote command execution, file operations, and session management.

## Architecture

```
┌─────────────────┐     MCP Protocol      ┌──────────────────────┐
│   Claude CLI    │◄────────────────────►│  Claude Remote Agent │
│                 │                       │     (MCP Server)     │
└─────────────────┘                       └──────────┬───────────┘
                                                     │
                                          SSH Connections (persistent)
                                                     │
                              ┌──────────────────────┼──────────────────────┐
                              ▼                      ▼                      ▼
                        ┌──────────┐           ┌──────────┐           ┌──────────┐
                        │ Host A   │           │ Host B   │           │ Host C   │
                        │ (prod)   │           │ (staging)│           │ (dev)    │
                        └──────────┘           └──────────┘           └──────────┘
```

## Components

### 1. MCP Server (`claude-remote-agent`)

The core daemon that:
- Registers as an MCP server with Claude CLI
- Manages SSH connections to remote hosts
- Enforces per-host security policies
- Provides tools for remote operations

### 2. Configuration Manager

Handles:
- Host definitions and credentials
- Per-host security policies
- Global settings

### 3. SSH Session Manager

Manages:
- Persistent SSH connections (connection pooling)
- Session multiplexing
- Reconnection handling
- Timeout management

### 4. Security Policy Engine

Enforces:
- Command allowlists/blocklists
- Confirmation requirements
- Audit logging
- Rate limiting

---

## Configuration

### Global Configuration

Location: `~/.config/claude-remote-agent/config.yaml`

```yaml
# Global settings
global:
  # Default timeout for commands (seconds)
  default_timeout: 300

  # Connection pool settings
  connection_pool:
    max_connections_per_host: 5
    idle_timeout: 600
    keepalive_interval: 30

  # Audit logging
  audit:
    enabled: true
    log_path: ~/.config/claude-remote-agent/audit.log
    log_commands: true
    log_output: true
    max_output_logged: 10000  # chars

  # Default security policy (can be overridden per-host)
  default_policy:
    confirmation_required: true
    allowed_commands: []      # Empty = all allowed (subject to blocklist)
    blocked_commands:
      - "rm -rf /"
      - ":(){ :|:& };:"
      - "mkfs.*"
      - "dd if=.* of=/dev/.*"
    blocked_patterns:
      - ".*>/dev/sd[a-z]"
      - "chmod -R 777 /"
```

### Host Configuration

Location: `~/.config/claude-remote-agent/hosts.yaml`

```yaml
hosts:
  # Development server - relaxed security
  dev-server:
    hostname: dev.example.com
    port: 22
    user: developer
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519

    policy:
      confirmation_required: false
      allowed_commands: "*"  # All commands allowed
      blocked_commands: []   # Override global blocklist

    labels:
      environment: development
      team: backend

  # Staging server - moderate security
  staging:
    hostname: staging.example.com
    port: 22
    user: deploy
    auth:
      type: key
      key_path: ~/.ssh/deploy_key

    policy:
      confirmation_required: true
      confirm_destructive_only: true  # Only confirm rm, kill, etc.
      allowed_commands: "*"
      blocked_commands:
        - "reboot"
        - "shutdown"

    labels:
      environment: staging

  # Production server - strict security
  prod-web-1:
    hostname: prod-web-1.example.com
    port: 22
    user: ops
    auth:
      type: key
      key_path: ~/.ssh/prod_key

    policy:
      confirmation_required: always  # Every command requires confirmation
      allowed_commands:
        - "systemctl status *"
        - "journalctl *"
        - "tail *"
        - "cat /var/log/*"
        - "df *"
        - "free *"
        - "top -bn1"
        - "ps aux"
        - "netstat *"
        - "ss *"
      blocked_commands:
        - "*"  # Block everything not in allowlist
      read_only: true  # Hint to Claude that this is read-only

    labels:
      environment: production
      role: webserver

  # Jump host / bastion
  bastion:
    hostname: bastion.example.com
    port: 22
    user: admin
    auth:
      type: key
      key_path: ~/.ssh/bastion_key

    # Can be used as a proxy for other hosts
    proxy_for:
      - internal-db
      - internal-app

  # Host accessible via bastion
  internal-db:
    hostname: 10.0.1.50
    port: 22
    user: dbadmin
    auth:
      type: key
      key_path: ~/.ssh/internal_key
    proxy_jump: bastion

    policy:
      confirmation_required: always
      allowed_commands:
        - "psql -c 'SELECT *'"  # Read-only queries only
        - "pg_dump *"

# Host groups for batch operations
groups:
  all-web:
    - prod-web-1
    - prod-web-2
    - staging

  databases:
    - internal-db
    - staging-db
```

---

## MCP Tools Provided

### 1. `remote_execute`

Execute a command on a remote host.

```typescript
interface RemoteExecuteParams {
  host: string;              // Host name from config or group name
  command: string;           // Command to execute
  timeout?: number;          // Override default timeout (seconds)
  working_dir?: string;      // Working directory for command
  env?: Record<string, string>; // Additional environment variables
  stdin?: string;            // Input to provide to command
}

interface RemoteExecuteResult {
  host: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  confirmation_skipped?: boolean;  // If user pre-approved
}
```

### 2. `remote_file_read`

Read a file from a remote host.

```typescript
interface RemoteFileReadParams {
  host: string;
  path: string;
  offset?: number;    // Start line (1-indexed)
  limit?: number;     // Number of lines
  encoding?: string;  // Default: utf-8
}
```

### 3. `remote_file_write`

Write content to a file on a remote host.

```typescript
interface RemoteFileWriteParams {
  host: string;
  path: string;
  content: string;
  mode?: string;      // File permissions (e.g., "0644")
  backup?: boolean;   // Create .bak before overwriting
}
```

### 4. `remote_file_edit`

Edit a file using find/replace (similar to local Edit tool).

```typescript
interface RemoteFileEditParams {
  host: string;
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

### 5. `remote_upload`

Upload a local file to remote host.

```typescript
interface RemoteUploadParams {
  host: string;
  local_path: string;
  remote_path: string;
  mode?: string;
}
```

### 6. `remote_download`

Download a file from remote host to local.

```typescript
interface RemoteDownloadParams {
  host: string;
  remote_path: string;
  local_path: string;
}
```

### 7. `remote_list_hosts`

List configured hosts with their status.

```typescript
interface RemoteListHostsResult {
  hosts: Array<{
    name: string;
    hostname: string;
    connected: boolean;
    policy_summary: string;  // e.g., "strict", "moderate", "relaxed"
    labels: Record<string, string>;
  }>;
}
```

### 8. `remote_session_start`

Start an interactive-style session (for multi-command workflows).

```typescript
interface RemoteSessionStartParams {
  host: string;
  working_dir?: string;
  env?: Record<string, string>;
}

interface RemoteSessionStartResult {
  session_id: string;
  host: string;
}
```

### 9. `remote_session_execute`

Execute command in existing session (maintains state like cwd, env).

```typescript
interface RemoteSessionExecuteParams {
  session_id: string;
  command: string;
  timeout?: number;
}
```

### 10. `remote_session_end`

End an interactive session.

```typescript
interface RemoteSessionEndParams {
  session_id: string;
}
```

---

## SSH Alias Management Tools

These tools manage the local `~/.ssh/config` file, allowing Claude to set up SSH shortcuts.

### 11. `ssh_alias_list`

List all SSH aliases configured in ~/.ssh/config.

```typescript
// No parameters required
interface SSHAliasListResult {
  aliases: Array<{
    name: string;
    hostname: string;
    port?: number;
    user?: string;
    identityFile?: string;
    proxyJump?: string;
  }>;
}
```

### 12. `ssh_alias_add`

Add or update an SSH alias.

```typescript
interface SSHAliasAddParams {
  name: string;           // Alias name (e.g., 'my-server')
  hostname: string;       // IP address or hostname
  port?: number;          // SSH port (default: 22)
  user?: string;          // Username
  identity_file?: string; // Path to SSH key
  proxy_jump?: string;    // Bastion host alias
}
```

### 13. `ssh_alias_remove`

Remove an SSH alias from ~/.ssh/config.

```typescript
interface SSHAliasRemoveParams {
  name: string;  // Alias name to remove
}
```

### 14. `ssh_alias_get`

Get details of a specific SSH alias.

```typescript
interface SSHAliasGetParams {
  name: string;  // Alias name to look up
}
```

---

## Installation & Bootstrap Tools

These tools enable Claude to install the remote agent on new systems using its existing SSH capabilities.

### 15. `remote_install_agent`

Install the Claude Remote Agent on a remote Linux system.

```typescript
interface RemoteInstallAgentParams {
  host: string;            // Host from config or SSH alias
  install_node?: boolean;  // Install Node.js if needed (default: true)
  node_version?: string;   // Node.js version (default: "20")
  install_dir?: string;    // Installation path (default: /opt/claude-remote-agent)
  create_service?: boolean; // Create systemd service (default: false)
}

interface RemoteInstallAgentResult {
  success: boolean;
  message: string;
  steps: string[];  // Steps completed
}
```

### 16. `remote_detect_system`

Detect OS, package manager, and Node.js status on a remote system.

```typescript
interface RemoteDetectSystemParams {
  host: string;
}

interface RemoteDetectSystemResult {
  distro: string;      // e.g., "ubuntu", "debian", "centos"
  version: string;     // e.g., "22.04"
  arch: string;        // e.g., "x86_64", "aarch64"
  package_manager: string;  // e.g., "apt", "yum", "dnf"
  node_installed: boolean;
  node_version?: string;
}
```

### 17. `remote_add_host`

Add a new host to both SSH config and agent configuration.

```typescript
interface RemoteAddHostParams {
  name: string;              // Host name/alias
  hostname: string;          // IP or hostname
  port?: number;             // SSH port (default: 22)
  user: string;              // SSH username
  identity_file?: string;    // SSH key path
  policy?: "relaxed" | "moderate" | "strict" | "read-only";
  labels?: Record<string, string>;
}
```

### 18. `get_install_command`

Get a one-liner command for installing via basic SSH.

```typescript
interface GetInstallCommandParams {
  node_version?: string;  // Default: "20"
}

// Returns a curl command that can be piped to bash
```

### 19. `remote_permissions_status`

Check current permissions mode (normal vs skip-permissions).

```typescript
// No parameters required
// Returns information about:
// - Current mode (normal or skip-permissions)
// - Which environment variables are set
// - What safeguards remain active
```

---

## Security Model

### Confirmation Levels

| Level | Behavior |
|-------|----------|
| `never` | No confirmation required (for trusted dev environments) |
| `destructive_only` | Confirm only for rm, kill, stop, restart, etc. |
| `write_only` | Confirm any write/modify operations |
| `always` | Confirm every command |

### Command Matching

Commands are matched against policies using:
1. **Exact match**: `systemctl restart nginx`
2. **Glob patterns**: `systemctl * nginx`, `cat /var/log/*`
3. **Regex patterns**: `/^systemctl (status|show)/`

### Pre-approved Commands

Users can pre-approve categories during Claude sessions:

```
Claude: I need to run `apt-get update && apt-get install curl` on dev-server.
        Should I proceed?

User: Yes, and approve all apt-get commands on dev-server for this session.

Claude: [Executes command, future apt-get commands won't prompt]
```

### Skip Permissions Mode (--dangerously-skip-permissions)

When Claude CLI is run with `--dangerously-skip-permissions`, this state propagates to the remote agent. All confirmation prompts are bypassed, allowing commands to execute immediately.

**Environment Variables Checked:**

| Variable | Description |
|----------|-------------|
| `CLAUDE_SKIP_PERMISSIONS` | Set by Claude CLI when using `--dangerously-skip-permissions` |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | Explicit skip flag |
| `CRA_SKIP_CONFIRMATIONS` | Agent-specific override |

**What's Still Enforced in Skip Mode:**
- Blocked commands and patterns (security blocklist)
- Allowlists (if configured for a host)
- Read-only mode restrictions

**What's Disabled:**
- Confirmation prompts (all commands execute immediately)

**Example:**

```bash
# Run Claude CLI with skip-permissions
claude --dangerously-skip-permissions

# Inside Claude session, remote commands execute without prompts:
User: Install nginx on all web servers

Claude: [Uses remote_execute on each host - no confirmation needed]
Done! nginx installed on prod-web-1, prod-web-2, and staging.
```

**Warning:** A warning is logged to stderr when the agent starts in skip-permissions mode:
```
[claude-remote-agent] WARNING: Running with skip-permissions mode.
All confirmation prompts are bypassed. Commands will execute without confirmation.
```

Use the `remote_permissions_status` tool to check current mode.

### Audit Trail

All remote operations are logged:

```json
{
  "timestamp": "2024-01-15T10:30:45Z",
  "session_id": "abc123",
  "host": "prod-web-1",
  "user": "ops",
  "command": "systemctl status nginx",
  "exit_code": 0,
  "duration_ms": 245,
  "confirmed_by": "user",
  "output_hash": "sha256:abc123..."
}
```

---

## Implementation Details

### Technology Stack

- **Language**: TypeScript/Node.js or Rust
- **SSH Library**:
  - Node.js: `ssh2`
  - Rust: `russh` or `thrussh`
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Config Parsing**: `yaml`

### Project Structure

```
claude-remote-agent/
├── src/
│   ├── index.ts              # Entry point, MCP server setup
│   ├── cli.ts                # CLI commands
│   ├── config/
│   │   ├── loader.ts         # Configuration loading
│   │   ├── schema.ts         # Config validation schemas
│   │   └── watcher.ts        # Hot-reload config changes
│   ├── ssh/
│   │   ├── connection.ts     # SSH connection management
│   │   ├── aliases.ts        # ~/.ssh/config management
│   │   ├── pool.ts           # Connection pooling
│   │   ├── session.ts        # Interactive session handling
│   │   └── sftp.ts           # File transfer operations
│   ├── installer/
│   │   └── remote-install.ts # Remote agent installation
│   ├── security/
│   │   ├── policy.ts         # Policy evaluation
│   │   ├── matcher.ts        # Command pattern matching
│   │   └── audit.ts          # Audit logging
│   └── types/
│       └── index.ts          # TypeScript type definitions
├── config/
│   ├── config.example.yaml
│   └── hosts.example.yaml
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── README.md
```

### Installation & Setup

```bash
# Install globally
npm install -g claude-remote-agent

# Or build from source
git clone https://github.com/your-org/claude-remote-agent
cd claude-remote-agent
npm install
npm run build
npm link

# Initialize configuration
claude-remote-agent init

# Add to Claude CLI MCP configuration
claude mcp add remote-agent -- claude-remote-agent serve
```

### Claude CLI Integration

Add to `~/.config/claude/settings.json`:

```json
{
  "mcpServers": {
    "remote-agent": {
      "command": "claude-remote-agent",
      "args": ["serve"],
      "env": {
        "CRA_CONFIG_PATH": "/path/to/custom/config.yaml"
      }
    }
  }
}
```

---

## Example Usage Scenarios

### Scenario 1: Install Package on Remote

```
User: Install curl on dev-server

Claude: I'll install curl on dev-server for you.

[Uses remote_execute with host="dev-server", command="sudo apt-get update && sudo apt-get install -y curl"]

Curl has been installed successfully on dev-server:
- Package: curl 7.88.1-10+deb12u5
- Exit code: 0
```

### Scenario 2: Check Logs Across Multiple Servers

```
User: Check for errors in nginx logs on all web servers

Claude: I'll check nginx error logs across your web servers.

[Uses remote_execute on each host in "all-web" group]

Here's a summary of nginx errors:
- prod-web-1: 3 errors in last hour (connection timeouts)
- prod-web-2: 0 errors
- staging: 12 errors (404s from test traffic)
```

### Scenario 3: Production with Confirmation

```
User: Restart nginx on prod-web-1

Claude: I need to run `sudo systemctl restart nginx` on prod-web-1.
        This is a production server with strict security policy.

        Should I proceed? [Yes/No]

User: Yes

Claude: [Executes command]

Nginx has been restarted on prod-web-1:
- Previous uptime: 45 days
- Service status: active (running)
- No errors in startup
```

### Scenario 4: Multi-step Deployment

```
User: Deploy the latest code to staging

Claude: I'll deploy to staging. This will involve multiple steps.

[Creates todo list, uses remote_session_start for stateful operations]

1. ✓ Connected to staging server
2. ✓ Pulled latest code: git pull origin main (3 files changed)
3. ✓ Installed dependencies: npm install (added 2 packages)
4. ✓ Built application: npm run build (completed in 45s)
5. ✓ Restarted service: systemctl restart app
6. ✓ Health check passed: HTTP 200 on /health

Deployment complete! Application is running version 2.4.1.
```

### Scenario 5: Add a New Server

```
User: Add my new server 192.168.1.100 as "web-server-3", user is deploy

Claude: I'll set up web-server-3 for you.

[Uses ssh_alias_add to create SSH alias]
[Uses remote_add_host to generate agent config]

Done! I've configured web-server-3:

1. SSH alias created - you can now run: ssh web-server-3
2. Agent config generated for ~/.config/claude-remote-agent/hosts.yaml

Would you like me to:
- Test the SSH connection?
- Install the remote agent on this server?
```

### Scenario 6: Bootstrap Agent on New Server

```
User: Set up the Claude agent on my new Ubuntu server at 10.0.0.50

Claude: I'll set up the Claude Remote Agent on your new server. First, let me
        create an SSH alias and detect the system.

[Uses ssh_alias_add: name="new-server", hostname="10.0.0.50"]
[Uses remote_detect_system]

System detected:
- OS: Ubuntu 22.04
- Architecture: x86_64
- Package Manager: apt
- Node.js: Not installed

I'll now install the agent. This will:
1. Install Node.js 20
2. Clone and build claude-remote-agent
3. Initialize configuration

[Uses remote_install_agent]

Installation complete! The agent is ready on new-server.

Next steps:
- Run commands: "Check disk space on new-server"
- Configure security policy in hosts.yaml
```

### Scenario 7: Manage SSH Aliases

```
User: Show me all my SSH aliases

Claude: [Uses ssh_alias_list]

SSH Aliases (4):

  dev-server:
    Hostname: 192.168.1.10
    User: developer
    IdentityFile: ~/.ssh/id_ed25519

  staging:
    Hostname: staging.example.com
    Port: 2222
    User: deploy

  prod-bastion:
    Hostname: bastion.example.com
    User: admin

  prod-db:
    Hostname: 10.0.1.50
    ProxyJump: prod-bastion
    User: dbadmin
```

---

## Error Handling

### Connection Failures

```typescript
interface ConnectionError {
  type: "connection_failed" | "auth_failed" | "timeout" | "host_unreachable";
  host: string;
  message: string;
  retry_possible: boolean;
}
```

### Policy Violations

```typescript
interface PolicyViolation {
  type: "command_blocked" | "confirmation_denied" | "read_only_violation";
  host: string;
  command: string;
  policy_rule: string;
  suggestion?: string;  // Alternative allowed command
}
```

---

## Future Enhancements

### Phase 2
- [ ] Windows Remote Management (WinRM) support
- [ ] Docker container execution (without SSH)
- [ ] Kubernetes pod execution
- [ ] AWS SSM Session Manager integration

### Phase 3
- [ ] Ansible playbook execution
- [ ] Terraform integration
- [ ] Multi-host orchestration workflows
- [ ] Scheduled/recurring commands

### Phase 4
- [ ] Web UI for configuration management
- [ ] Centralized audit dashboard
- [ ] Team/role-based access control
- [ ] Secrets management integration (Vault, AWS Secrets Manager)

---

## Security Considerations

1. **Credential Storage**: SSH keys should be encrypted at rest; consider integration with system keychain or secrets manager.

2. **Network Security**: All SSH connections use standard SSH encryption. Consider requiring specific ciphers/MACs for high-security hosts.

3. **Privilege Escalation**: sudo commands should be explicitly configured and logged. Consider requiring MFA for privileged operations.

4. **Session Isolation**: Each Claude session should have isolated connection contexts to prevent cross-session leakage.

5. **Output Sanitization**: Sensitive data in command output (passwords, tokens) should be detected and redacted in logs.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## License

MIT License - see [LICENSE](./LICENSE)

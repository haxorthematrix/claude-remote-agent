# Claude Remote Agent

An MCP (Model Context Protocol) server that enables Claude CLI to interact with remote Linux, macOS, and Windows systems via SSH in real-time.

## Privacy & Credential Security

**Your credentials never leave your machine.**

This MCP server runs entirely on your local machine and connects directly to your remote hosts using standard SSH:

- **Local Storage Only**: All configuration, credentials, and SSH keys are stored locally in `~/.config/claude-remote-agent/` and `~/.ssh/`
- **No Third-Party Sharing**: Your passwords, SSH keys, and host credentials are never sent to Anthropic, Claude, or any external service
- **Standard SSH**: Uses your existing SSH infrastructure - the same keys and config you use with `ssh` command
- **SSH Agent Support**: Can use your running `ssh-agent` so private keys never touch disk unencrypted
- **Direct Connections**: SSH connections go directly from your machine to your remote hosts - no proxy or relay servers

**How it works:**
```
Your Machine                          Remote Hosts
┌─────────────────────┐               ┌─────────────┐
│ Claude CLI          │               │ my-server   │
│   ↓                 │    SSH        │             │
│ MCP Server (local)  │──────────────→│ (your host) │
│   ↓                 │   Direct      │             │
│ ~/.ssh/id_ed25519   │  Connection   └─────────────┘
│ ~/.config/cra/      │
└─────────────────────┘
```

Claude sees only the *results* of commands (stdout/stderr), never your SSH keys or passwords.

## Requirements

### Local Machine (where you run Claude CLI)

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18.0+ | Required for running the MCP server |
| npm | 8.0+ | Comes with Node.js |
| Claude CLI | Latest | Install via `npm install -g @anthropic-ai/claude-code` |
| SSH Client | Any | OpenSSH (included on macOS/Linux), Windows 10+ has built-in |
| SSH Keys | - | Recommended for passwordless authentication |

### Remote Hosts

| Requirement | Notes |
|-------------|-------|
| SSH Server | OpenSSH or compatible, listening on port 22 (or custom port) |
| User Account | With appropriate permissions for intended operations |
| Shell | bash, sh, zsh, or PowerShell (Windows) |

**Windows Remote Hosts:**
- OpenSSH Server must be enabled (Settings > Apps > Optional Features > OpenSSH Server)
- Or via PowerShell (Admin): `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`
- Start service: `Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`

## Installation

### Step 1: Install the Agent

**Linux / macOS:**
```bash
# Clone the repository
git clone https://github.com/haxorthematrix/claude-remote-agent
cd claude-remote-agent

# Install dependencies and build
npm install
npm run build

# Link globally (makes 'claude-remote-agent' command available)
npm link

# Initialize configuration
claude-remote-agent init
```

**Windows (PowerShell):**
```powershell
# Install Node.js if needed (pick one)
winget install OpenJS.NodeJS.LTS
# or: choco install nodejs-lts -y
# or: scoop install nodejs-lts

# Clone and build
git clone https://github.com/haxorthematrix/claude-remote-agent
cd claude-remote-agent
npm install
npm run build

# Link globally
npm link

# Initialize configuration
claude-remote-agent init
```

### Step 2: Register with Claude CLI

```bash
claude mcp add remote-agent -- claude-remote-agent serve
```

This registers the MCP server with Claude CLI. The server will start automatically when Claude needs it.

### Step 3: Configure Remote Hosts

Edit `~/.config/claude-remote-agent/hosts.yaml`:

```yaml
hosts:
  my-server:
    hostname: 192.168.1.100
    port: 22
    user: myuser
    auth:
      type: key                    # Options: key, password, agent
      key_path: ~/.ssh/id_ed25519  # For type: key
    policy:
      confirmation_required: destructive_only  # Options: never, destructive_only, always
```

**Or import from existing SSH config:**
```bash
# View your SSH aliases
claude-remote-agent alias list

# Then add them to hosts.yaml manually, or use the CLI
claude-remote-agent add-host my-server -H 192.168.1.100 -u myuser -i ~/.ssh/id_ed25519
```

### Step 4: Test Connection

```bash
claude-remote-agent test my-server
```

## Authentication Methods

| Type | Config | Description |
|------|--------|-------------|
| `key` | `key_path: ~/.ssh/id_ed25519` | SSH private key (recommended) |
| `agent` | (no extra config) | Use running SSH agent (ssh-agent) |
| `password` | `password: secret` | Password auth (not recommended, stored in plaintext) |

**Example with SSH agent:**
```yaml
hosts:
  my-server:
    hostname: 192.168.1.100
    user: myuser
    auth:
      type: agent  # Uses SSH_AUTH_SOCK
```

## Features

### Core Capabilities
- **SSH Command Execution**: Run commands on remote hosts directly from Claude
- **File Operations**: Read, write, and edit files on remote systems via SFTP
- **File Transfers**: Upload and download files between local and remote hosts
- **Session Management**: Maintain stateful shell sessions for multi-command workflows
- **Host Groups**: Execute commands across multiple hosts simultaneously

### Connectivity
- **Multi-Platform Support**: Linux, macOS, and Windows remote hosts
- **Proxy Jump / Bastion Hosts**: Connect through jump servers for secure network access
- **Connection Pooling**: Efficient connection reuse for fast operations
- **SSH Alias Management**: Create and manage ~/.ssh/config entries via MCP tools

### Security
- **Per-Host Security Policies**: Configurable confirmation levels and command filtering
- **Command Allowlists/Blocklists**: Fine-grained control over permitted commands
- **Dangerous Command Detection**: Automatic detection of destructive operations
- **Output Sanitization**: Automatic redaction of secrets (passwords, API keys, tokens) in logs
- **Audit Logging**: Comprehensive tracking of all operations with session correlation

### MCP Tools (21 total)

| Tool | Description |
|------|-------------|
| `remote_execute` | Execute commands on remote hosts |
| `remote_file_read` | Read file contents from remote hosts |
| `remote_file_write` | Write content to files on remote hosts |
| `remote_file_edit` | Edit existing files with find/replace |
| `remote_upload` | Upload local files to remote hosts |
| `remote_download` | Download files from remote hosts |
| `remote_session_start` | Start a persistent shell session |
| `remote_session_execute` | Run commands in an existing session |
| `remote_session_end` | Close a session |
| `remote_session_list` | List active sessions |
| `remote_list_hosts` | List configured hosts and groups |
| `remote_host_info` | Get host configuration details |
| `remote_detect_system` | Detect OS and system capabilities |
| `remote_install_agent` | Install the agent on remote hosts |
| `remote_check_policy` | Check if a command is allowed |
| `ssh_alias_list` | List SSH config aliases |
| `ssh_alias_add` | Add SSH config entries |
| `ssh_alias_remove` | Remove SSH config entries |
| `config_reload` | Reload configuration from disk |
| `audit_log_query` | Query audit logs |
| `remote_permissions_status` | Check skip-permissions mode |

## Usage Examples

Once configured, talk to Claude naturally:

```
You: Check disk space on my-server
Claude: [Uses remote_execute] Here's the disk usage on my-server:
        /dev/sda1: 45% used (23GB free)

You: List all running docker containers on my-server
Claude: [Uses remote_execute with 'docker ps']
        CONTAINER ID   IMAGE          STATUS
        a1b2c3d4       nginx:latest   Up 2 days
        ...

You: Read the nginx config on my-server
Claude: [Uses remote_file_read] Here's /etc/nginx/nginx.conf:
        ...

You: Restart nginx on my-server
Claude: This will restart nginx. Proceed? [Confirms with user]
        [Uses remote_execute] nginx restarted successfully.
```

## CLI Reference

```bash
# MCP Server
claude-remote-agent serve              # Start MCP server (used by Claude CLI)

# Configuration
claude-remote-agent init               # Initialize config directory
claude-remote-agent list               # List configured hosts

# Connection Testing
claude-remote-agent test <host>        # Test SSH connection to a host

# Policy Checking
claude-remote-agent check-policy <host> "<command>"

# SSH Alias Management
claude-remote-agent alias list
claude-remote-agent alias add <name> -H <hostname> -u <user> [-p <port>] [-i <keyfile>]
claude-remote-agent alias remove <name>

# Add Host (creates SSH alias + agent config)
claude-remote-agent add-host <name> -H <hostname> -u <user> [options]
```

## Configuration Reference

### Host Configuration (`~/.config/claude-remote-agent/hosts.yaml`)

```yaml
hosts:
  # Basic host
  my-server:
    hostname: 192.168.1.100
    port: 22                          # Optional, default: 22
    user: myuser
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    policy:
      confirmation_required: destructive_only
    labels:                           # Optional metadata
      environment: production
      role: webserver

  # Host via bastion/jump server
  internal-db:
    hostname: 10.0.0.50
    user: dbadmin
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    proxy_jump: bastion               # Name of another host to jump through

  # Bastion host
  bastion:
    hostname: bastion.example.com
    user: jump-user
    auth:
      type: key
      key_path: ~/.ssh/bastion_key

# Host groups for batch operations
groups:
  web-servers:
    - my-server
    - web-2
  databases:
    - internal-db
```

### Global Configuration (`~/.config/claude-remote-agent/config.yaml`)

```yaml
global:
  default_timeout: 300                # Command timeout in seconds

  connection_pool:
    max_connections_per_host: 5
    idle_timeout: 600
    keepalive_interval: 30

  audit:
    enabled: true
    log_path: ~/.config/claude-remote-agent/audit.log
    log_commands: true
    log_output: true
    max_output_logged: 10000

  default_policy:
    confirmation_required: destructive_only
    blocked_commands:
      - "rm -rf /"
      - "mkfs.*"
    blocked_patterns:
      - "chmod -R 777 /"
```

## Security Policies

| Level | Behavior |
|-------|----------|
| `never` | No confirmation required (use for trusted dev environments) |
| `destructive_only` | Confirm only for rm, kill, reboot, etc. (recommended) |
| `write_only` | Confirm any write/modify operations |
| `always` | Confirm every command (use for production) |

### Dangerous Commands (auto-detected)

**Linux/macOS:** rm, rmdir, kill, killall, pkill, shutdown, reboot, halt, poweroff, systemctl stop/restart, docker rm/stop

**Windows:** del, rd, rmdir, format, taskkill, Stop-Process, Stop-Service, shutdown, Restart-Computer

## Audit Logging

All operations are logged to `~/.config/claude-remote-agent/audit.log`:

```json
{
  "timestamp": "2024-01-15T10:30:45Z",
  "session_id": "session-abc123",
  "tool": "remote_execute",
  "host": "my-server",
  "user": "myuser",
  "action": "systemctl status nginx",
  "exit_code": 0,
  "duration_ms": 245,
  "success": true
}
```

**Automatic Secret Redaction:** Passwords, API keys, tokens, private keys, AWS credentials, and other secrets are automatically redacted in logs.

## Troubleshooting

### "Connection refused" or "Connection timed out"
- Verify the host is reachable: `ping <hostname>`
- Check SSH is running on the remote host: `ssh <user>@<hostname>`
- Verify port is correct (default: 22)

### "Authentication failed"
- Check username is correct
- For key auth: verify key path and permissions (`chmod 600 ~/.ssh/id_*`)
- For agent auth: verify ssh-agent is running (`ssh-add -l`)
- Test manually: `ssh -i <keyfile> <user>@<hostname>`

### "Command not found: claude-remote-agent"
- Run `npm link` in the project directory
- Or use full path: `node /path/to/claude-remote-agent/dist/cli.js`

### MCP server not responding
- Check Claude CLI config: `cat ~/.claude.json`
- Verify server starts: `claude-remote-agent serve` (should wait for input)
- Check for errors in build: `npm run build`

### Permission denied on remote host
- Check user has required permissions
- For sudo commands, ensure user is in sudoers
- Check security policy isn't blocking the command: `claude-remote-agent check-policy <host> "<command>"`

## Supported Platforms

| Remote OS | Package Manager | Service Manager |
|-----------|-----------------|-----------------|
| Ubuntu/Debian | apt | systemd |
| RHEL/CentOS/Fedora | dnf/yum | systemd |
| Arch Linux | pacman | systemd |
| Alpine Linux | apk | systemd |
| macOS | Homebrew | launchd |
| Windows 10/11 | winget, choco, scoop | Windows Services |

## Documentation

See [SPEC.md](./SPEC.md) for the full specification including:
- Architecture details
- All MCP tool schemas
- Configuration options
- Security model
- Future roadmap

## License

MIT

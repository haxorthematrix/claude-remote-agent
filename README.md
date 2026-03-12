# Claude Remote Agent

An MCP (Model Context Protocol) server that enables Claude CLI to interact with remote Linux, macOS, and Windows systems via SSH in real-time.

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

### Operations
- **Remote Agent Installation**: Bootstrap the agent on new servers via Claude
- **System Detection**: Auto-detect OS, package manager, and init system
- **Config Hot-Reload**: Configuration changes apply without restart

### MCP Tools (19 total)
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

## Quick Start

### Installation (Linux/macOS)

```bash
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

### Installation (Windows)

**Prerequisites:** Node.js 18+ and Git must be installed. You can install them via:
- **winget:** `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`
- **Chocolatey:** `choco install nodejs-lts git -y`
- **Scoop:** `scoop install nodejs-lts git`

```powershell
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

**Note:** Windows SSH support requires OpenSSH client, which is included in Windows 10/11. For older versions, install via `winget install Microsoft.OpenSSH.Client` or enable it in Windows Features.

### Configuration

Edit `~/.config/claude-remote-agent/hosts.yaml` (or `%USERPROFILE%\.config\claude-remote-agent\hosts.yaml` on Windows) to add your remote hosts:

```yaml
hosts:
  # Linux/macOS server
  my-server:
    hostname: 192.168.1.100
    port: 22
    user: myuser
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    policy:
      confirmation_required: destructive_only

  # Windows server
  win-server:
    hostname: 192.168.1.200
    port: 22
    user: Administrator
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    policy:
      confirmation_required: always  # Be extra careful on Windows

  # Server behind a bastion/jump host
  internal-db:
    hostname: 10.0.0.50
    port: 22
    user: dbadmin
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    proxy_jump:
      hostname: bastion.example.com
      port: 22
      user: jump-user
      auth:
        type: key
        key_path: ~/.ssh/id_ed25519

groups:
  web-servers:
    - my-server
    - win-server
  all-db:
    - internal-db
```

### Register with Claude CLI

```bash
claude mcp add remote-agent -- claude-remote-agent serve
```

### Usage

Once configured, you can ask Claude to interact with your remote systems:

```
You: Install htop on my-server

Claude: I'll install htop on my-server for you.
[Uses remote_execute tool]
htop has been installed successfully.
```

### Adding New Servers

You can ask Claude to set up new servers:

```
You: Add my new server at 10.0.0.50 as "web-3", user is deploy

Claude: I'll set up web-3 for you.
[Creates SSH alias and agent configuration]
Done! You can now run: ssh web-3

You: Install the Claude agent on web-3

Claude: I'll install the remote agent on web-3.
[Detects Ubuntu 22.04, installs Node.js, builds agent]
Installation complete! You can now run commands on web-3.
```

## CLI Commands

```bash
# Start MCP server (used by Claude CLI)
claude-remote-agent serve

# Initialize config directory
claude-remote-agent init

# List configured hosts
claude-remote-agent list

# Test connection to a host
claude-remote-agent test my-server

# Check if a command is allowed by policy
claude-remote-agent check-policy my-server "rm -rf /tmp/*"

# SSH Alias Management
claude-remote-agent alias list                    # List all SSH aliases
claude-remote-agent alias add myhost -H 1.2.3.4 -u admin   # Add alias
claude-remote-agent alias remove myhost           # Remove alias

# Add new host (SSH alias + agent config)
claude-remote-agent add-host my-server \
  -H 192.168.1.100 \
  -u deploy \
  -i ~/.ssh/deploy_key \
  --policy moderate
```

## Supported Platforms

| Platform | Package Manager | Service Manager |
|----------|-----------------|-----------------|
| Ubuntu/Debian | apt | systemd |
| RHEL/CentOS/Fedora | dnf/yum | systemd |
| Arch Linux | pacman | systemd |
| Alpine Linux | apk | systemd |
| macOS | Homebrew | launchd |
| **Windows 10/11** | **winget, choco, scoop** | **Windows Services** |

### Windows Notes

- Requires OpenSSH server enabled on the remote Windows machine
- SSH can be enabled via Settings > Apps > Optional Features > OpenSSH Server
- Or via PowerShell (Admin): `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`
- The agent installs to `C:\Program Files\claude-remote-agent` by default
- Windows service creation uses NSSM if available, otherwise falls back to sc.exe

## Security Policies

Each host can have its own security policy:

| Level | Behavior |
|-------|----------|
| `never` | No confirmation required |
| `destructive_only` | Confirm only rm, kill, restart, etc. |
| `write_only` | Confirm any write operations |
| `always` | Confirm every command |

You can also define allowlists and blocklists for fine-grained control.

## Audit Logging

All remote operations are logged to `~/.config/claude-remote-agent/audit.log` with:
- Session tracking (unique session IDs)
- Command execution details (host, user, command, exit code, duration)
- File operation records
- Automatic secret redaction (passwords, API keys, tokens, private keys)

Configure in `~/.config/claude-remote-agent/config.yaml`:

```yaml
global:
  audit:
    enabled: true
    log_path: ~/.config/claude-remote-agent/audit.log
    log_commands: true
    log_output: true
    max_output_logged: 10000
```

### Output Sanitization

The following sensitive data is automatically redacted in logs:
- Passwords and passphrases
- API keys and Bearer tokens
- AWS credentials
- Private keys (RSA, DSA, EC, OpenSSH)
- JWT tokens
- Database connection strings
- GitHub/GitLab/Slack tokens

## Documentation

See [SPEC.md](./SPEC.md) for the full specification including:
- Architecture details
- All available MCP tools
- Configuration options
- Security model
- Future roadmap

## License

MIT

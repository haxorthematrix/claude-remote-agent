# Claude Remote Agent

An MCP (Model Context Protocol) server that enables Claude CLI to interact with remote Linux systems via SSH in real-time.

## Features

- **SSH Command Execution**: Run commands on remote hosts directly from Claude
- **File Operations**: Read and write files on remote systems
- **Session Management**: Maintain stateful sessions for multi-command workflows
- **Configurable Security**: Per-host security policies with confirmation levels
- **Host Groups**: Execute commands across multiple hosts simultaneously
- **Connection Pooling**: Efficient connection management for fast operations
- **Audit Logging**: Track all remote operations for security and compliance
- **SSH Alias Management**: Create and manage ~/.ssh/config entries via MCP tools
- **Remote Agent Installation**: Bootstrap the agent on new servers via Claude

## Quick Start

### Installation

```bash
# Clone and build
git clone https://github.com/your-org/claude-remote-agent
cd claude-remote-agent
npm install
npm run build

# Link globally
npm link

# Initialize configuration
claude-remote-agent init
```

### Configuration

Edit `~/.config/claude-remote-agent/hosts.yaml` to add your remote hosts:

```yaml
hosts:
  my-server:
    hostname: 192.168.1.100
    port: 22
    user: myuser
    auth:
      type: key
      key_path: ~/.ssh/id_ed25519
    policy:
      confirmation_required: destructive_only
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

## Security Policies

Each host can have its own security policy:

| Level | Behavior |
|-------|----------|
| `never` | No confirmation required |
| `destructive_only` | Confirm only rm, kill, restart, etc. |
| `write_only` | Confirm any write operations |
| `always` | Confirm every command |

You can also define allowlists and blocklists for fine-grained control.

## Documentation

See [SPEC.md](./SPEC.md) for the full specification including:
- Architecture details
- All available MCP tools
- Configuration options
- Security model
- Future roadmap

## License

MIT

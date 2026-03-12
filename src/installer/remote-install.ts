import { SSHConnection } from "../ssh/connection.js";
import { HostConfig } from "../types/index.js";

export interface InstallOptions {
  installNode?: boolean;
  nodeVersion?: string;
  installDir?: string;
  createSystemdService?: boolean;
  serviceName?: string;
}

const DEFAULT_OPTIONS: InstallOptions = {
  installNode: true,
  nodeVersion: "20",
  installDir: "/opt/claude-remote-agent",
  createSystemdService: false,
  serviceName: "claude-remote-agent",
};

/**
 * Detect the remote system's package manager
 */
export async function detectPackageManager(
  connection: SSHConnection
): Promise<"apt" | "yum" | "dnf" | "pacman" | "apk" | "unknown"> {
  const checks = [
    { cmd: "which apt-get", result: "apt" as const },
    { cmd: "which dnf", result: "dnf" as const },
    { cmd: "which yum", result: "yum" as const },
    { cmd: "which pacman", result: "pacman" as const },
    { cmd: "which apk", result: "apk" as const },
  ];

  for (const check of checks) {
    const result = await connection.exec(check.cmd);
    if (result.exit_code === 0) {
      return check.result;
    }
  }

  return "unknown";
}

/**
 * Detect OS information
 */
export async function detectOS(
  connection: SSHConnection
): Promise<{ distro: string; version: string; arch: string }> {
  const result = await connection.exec(
    'cat /etc/os-release 2>/dev/null || echo "ID=unknown"'
  );

  const lines = result.stdout.split("\n");
  let distro = "unknown";
  let version = "unknown";

  for (const line of lines) {
    if (line.startsWith("ID=")) {
      distro = line.substring(3).replace(/"/g, "");
    } else if (line.startsWith("VERSION_ID=")) {
      version = line.substring(11).replace(/"/g, "");
    }
  }

  const archResult = await connection.exec("uname -m");
  const arch = archResult.stdout.trim();

  return { distro, version, arch };
}

/**
 * Check if Node.js is installed and get version
 */
export async function checkNodeInstalled(
  connection: SSHConnection
): Promise<{ installed: boolean; version?: string }> {
  const result = await connection.exec("node --version 2>/dev/null");

  if (result.exit_code === 0) {
    return {
      installed: true,
      version: result.stdout.trim().replace(/^v/, ""),
    };
  }

  return { installed: false };
}

/**
 * Generate Node.js installation commands for different package managers
 */
function getNodeInstallCommands(
  pkgManager: string,
  nodeVersion: string
): string[] {
  switch (pkgManager) {
    case "apt":
      return [
        "curl -fsSL https://deb.nodesource.com/setup_" + nodeVersion + ".x | sudo -E bash -",
        "sudo apt-get install -y nodejs",
      ];
    case "dnf":
      return [
        "sudo dnf module enable nodejs:" + nodeVersion + " -y",
        "sudo dnf install nodejs -y",
      ];
    case "yum":
      return [
        "curl -fsSL https://rpm.nodesource.com/setup_" + nodeVersion + ".x | sudo bash -",
        "sudo yum install nodejs -y",
      ];
    case "pacman":
      return ["sudo pacman -S nodejs npm --noconfirm"];
    case "apk":
      return ["sudo apk add nodejs npm"];
    default:
      throw new Error(`Unsupported package manager: ${pkgManager}`);
  }
}

/**
 * Generate the installation script
 */
export function generateInstallScript(
  options: InstallOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const script = `#!/bin/bash
set -e

INSTALL_DIR="${opts.installDir}"
SERVICE_NAME="${opts.serviceName}"

echo "=== Claude Remote Agent Installer ==="
echo ""

# Create installation directory
echo "[1/4] Creating installation directory..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown $(whoami):$(whoami) "$INSTALL_DIR"

# Clone or download the agent
echo "[2/4] Downloading claude-remote-agent..."
cd "$INSTALL_DIR"

if command -v git &> /dev/null; then
    if [ -d ".git" ]; then
        git pull
    else
        git clone https://github.com/your-org/claude-remote-agent.git .
    fi
else
    # Fallback: download tarball
    curl -L https://github.com/your-org/claude-remote-agent/archive/main.tar.gz | tar xz --strip-components=1
fi

# Install dependencies and build
echo "[3/4] Installing dependencies..."
npm install
npm run build

# Create symlink
echo "[4/4] Creating command symlink..."
sudo ln -sf "$INSTALL_DIR/dist/cli.js" /usr/local/bin/claude-remote-agent
sudo chmod +x /usr/local/bin/claude-remote-agent

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Claude Remote Agent installed to: $INSTALL_DIR"
echo "Command available at: /usr/local/bin/claude-remote-agent"
echo ""
echo "Next steps:"
echo "  1. Run 'claude-remote-agent init' to create config"
echo "  2. Edit ~/.config/claude-remote-agent/hosts.yaml"
echo ""
`;

  return script;
}

/**
 * Generate systemd service file
 */
export function generateSystemdService(
  installDir: string,
  serviceName: string
): string {
  return `[Unit]
Description=Claude Remote Agent MCP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${installDir}
ExecStart=/usr/bin/node ${installDir}/dist/cli.js serve
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Full installation process
 */
export async function installOnRemote(
  connection: SSHConnection,
  options: InstallOptions = {},
  onProgress?: (step: string, output: string) => void
): Promise<{ success: boolean; message: string; steps: string[] }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const steps: string[] = [];

  const log = (step: string, output: string = "") => {
    steps.push(step);
    if (onProgress) {
      onProgress(step, output);
    }
  };

  try {
    // 1. Detect OS and package manager
    log("Detecting system...");
    const os = await detectOS(connection);
    const pkgManager = await detectPackageManager(connection);
    log(`Detected: ${os.distro} ${os.version} (${os.arch}), package manager: ${pkgManager}`);

    // 2. Check/install Node.js
    const nodeStatus = await checkNodeInstalled(connection);
    if (!nodeStatus.installed && opts.installNode) {
      log("Installing Node.js...");
      const nodeCommands = getNodeInstallCommands(pkgManager, opts.nodeVersion || "20");
      for (const cmd of nodeCommands) {
        const result = await connection.exec(cmd, { timeout: 300000 });
        if (result.exit_code !== 0) {
          throw new Error(`Failed to install Node.js: ${result.stderr}`);
        }
      }
      log("Node.js installed successfully");
    } else if (nodeStatus.installed) {
      log(`Node.js already installed: v${nodeStatus.version}`);
    }

    // 3. Install git if needed
    const gitCheck = await connection.exec("which git");
    if (gitCheck.exit_code !== 0) {
      log("Installing git...");
      const gitCmd =
        pkgManager === "apt"
          ? "sudo apt-get install -y git"
          : pkgManager === "dnf" || pkgManager === "yum"
          ? "sudo yum install -y git"
          : pkgManager === "pacman"
          ? "sudo pacman -S git --noconfirm"
          : "sudo apk add git";
      await connection.exec(gitCmd);
    }

    // 4. Run installation script
    log("Running installation script...");
    const script = generateInstallScript(opts);

    // Upload and execute script
    await connection.writeFile("/tmp/install-cra.sh", script, { mode: 0o755 });
    const installResult = await connection.exec("bash /tmp/install-cra.sh", {
      timeout: 600000, // 10 minutes
    });

    if (installResult.exit_code !== 0) {
      throw new Error(`Installation failed: ${installResult.stderr}`);
    }
    log("Installation script completed", installResult.stdout);

    // 5. Set up systemd service if requested
    if (opts.createSystemdService) {
      log("Creating systemd service...");
      const serviceContent = generateSystemdService(
        opts.installDir!,
        opts.serviceName!
      );
      await connection.writeFile(
        `/etc/systemd/system/${opts.serviceName}.service`,
        serviceContent
      );
      await connection.exec("sudo systemctl daemon-reload");
      await connection.exec(`sudo systemctl enable ${opts.serviceName}`);
      log("Systemd service created and enabled");
    }

    // 6. Initialize config
    log("Initializing configuration...");
    await connection.exec("claude-remote-agent init");
    log("Configuration initialized");

    // 7. Verify installation
    log("Verifying installation...");
    const verifyResult = await connection.exec("claude-remote-agent --version");
    if (verifyResult.exit_code !== 0) {
      throw new Error("Installation verification failed");
    }
    log(`Verified: claude-remote-agent ${verifyResult.stdout.trim()}`);

    return {
      success: true,
      message: "Claude Remote Agent installed successfully",
      steps,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Installation failed: ${message}`,
      steps,
    };
  }
}

/**
 * Generate a minimal install command that can be run via basic SSH
 */
export function getQuickInstallCommand(nodeVersion: string = "20"): string {
  return `curl -fsSL https://raw.githubusercontent.com/your-org/claude-remote-agent/main/install.sh | bash -s -- --node-version ${nodeVersion}`;
}

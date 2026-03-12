import { SSHConnection } from "../ssh/connection.js";
import { HostConfig } from "../types/index.js";

export type OSType = "linux" | "macos" | "unknown";

export interface InstallOptions {
  installNode?: boolean;
  nodeVersion?: string;
  installDir?: string;
  createService?: boolean;  // systemd on Linux, launchd on macOS
  serviceName?: string;
}

const DEFAULT_OPTIONS: InstallOptions = {
  installNode: true,
  nodeVersion: "20",
  installDir: "/opt/claude-remote-agent",  // Will be adjusted for macOS
  createService: false,
  serviceName: "claude-remote-agent",
};

/**
 * Get default install directory based on OS
 */
function getDefaultInstallDir(osType: OSType): string {
  if (osType === "macos") {
    return "/usr/local/opt/claude-remote-agent";
  }
  return "/opt/claude-remote-agent";
}

export type PackageManager = "apt" | "yum" | "dnf" | "pacman" | "apk" | "brew" | "unknown";

/**
 * Detect the remote system's package manager
 */
export async function detectPackageManager(
  connection: SSHConnection
): Promise<PackageManager> {
  const checks = [
    { cmd: "which brew", result: "brew" as const },  // Check brew first (macOS)
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
 * Detect OS type (Linux vs macOS)
 */
export async function detectOSType(connection: SSHConnection): Promise<OSType> {
  const result = await connection.exec("uname -s");
  const os = result.stdout.trim().toLowerCase();

  if (os === "darwin") {
    return "macos";
  } else if (os === "linux") {
    return "linux";
  }
  return "unknown";
}

/**
 * Detect OS information
 */
export async function detectOS(
  connection: SSHConnection
): Promise<{ osType: OSType; distro: string; version: string; arch: string }> {
  const osType = await detectOSType(connection);

  let distro = "unknown";
  let version = "unknown";

  if (osType === "macos") {
    // macOS: use sw_vers
    const prodResult = await connection.exec("sw_vers -productName 2>/dev/null");
    const verResult = await connection.exec("sw_vers -productVersion 2>/dev/null");

    distro = prodResult.exit_code === 0 ? prodResult.stdout.trim() : "macOS";
    version = verResult.exit_code === 0 ? verResult.stdout.trim() : "unknown";
  } else {
    // Linux: use /etc/os-release
    const result = await connection.exec(
      'cat /etc/os-release 2>/dev/null || echo "ID=unknown"'
    );

    const lines = result.stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("ID=")) {
        distro = line.substring(3).replace(/"/g, "");
      } else if (line.startsWith("VERSION_ID=")) {
        version = line.substring(11).replace(/"/g, "");
      }
    }
  }

  const archResult = await connection.exec("uname -m");
  const arch = archResult.stdout.trim();

  return { osType, distro, version, arch };
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
  pkgManager: PackageManager,
  nodeVersion: string
): string[] {
  switch (pkgManager) {
    case "brew":
      // Homebrew on macOS - node@version or just node for latest
      return [`brew install node@${nodeVersion} || brew install node`];
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
 * Generate git installation commands for different package managers
 */
function getGitInstallCommand(pkgManager: PackageManager): string {
  switch (pkgManager) {
    case "brew":
      return "brew install git";
    case "apt":
      return "sudo apt-get install -y git";
    case "dnf":
    case "yum":
      return "sudo yum install -y git";
    case "pacman":
      return "sudo pacman -S git --noconfirm";
    case "apk":
      return "sudo apk add git";
    default:
      throw new Error(`Unsupported package manager: ${pkgManager}`);
  }
}

/**
 * Generate the installation script
 */
export function generateInstallScript(
  options: InstallOptions = {},
  osType: OSType = "linux"
): string {
  const installDir = options.installDir || getDefaultInstallDir(osType);
  const opts = { ...DEFAULT_OPTIONS, ...options, installDir };

  // macOS needs different group ownership
  const chownCmd = osType === "macos"
    ? 'sudo chown -R $(whoami):staff "$INSTALL_DIR"'
    : 'sudo chown -R $(whoami):$(whoami) "$INSTALL_DIR"';

  const script = `#!/bin/bash
set -e

INSTALL_DIR="${opts.installDir}"
SERVICE_NAME="${opts.serviceName}"
OS_TYPE="${osType}"

echo "=== Claude Remote Agent Installer ==="
echo "Target OS: $OS_TYPE"
echo ""

# Create installation directory
echo "[1/4] Creating installation directory..."
sudo mkdir -p "$INSTALL_DIR"
${chownCmd}

# Clone or download the agent
echo "[2/4] Downloading claude-remote-agent..."
cd "$INSTALL_DIR"

if command -v git &> /dev/null; then
    if [ -d ".git" ]; then
        git pull
    else
        git clone https://github.com/haxorthematrix/claude-remote-agent.git .
    fi
else
    # Fallback: download tarball
    curl -L https://github.com/haxorthematrix/claude-remote-agent/archive/main.tar.gz | tar xz --strip-components=1
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
 * Generate systemd service file (Linux)
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
 * Generate launchd plist file (macOS)
 */
export function generateLaunchdPlist(
  installDir: string,
  serviceName: string
): string {
  const label = `com.claude.${serviceName}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${installDir}/dist/cli.js</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${installDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/usr/local/var/log/${serviceName}.log</string>
    <key>StandardErrorPath</key>
    <string>/usr/local/var/log/${serviceName}.error.log</string>
</dict>
</plist>
`;
}

/**
 * Full installation process
 */
export async function installOnRemote(
  connection: SSHConnection,
  options: InstallOptions = {},
  onProgress?: (step: string, output: string) => void
): Promise<{ success: boolean; message: string; steps: string[]; osType: OSType }> {
  const steps: string[] = [];

  const log = (step: string, output: string = "") => {
    steps.push(step);
    if (onProgress) {
      onProgress(step, output);
    }
  };

  let detectedOSType: OSType = "unknown";

  try {
    // 1. Detect OS and package manager
    log("Detecting system...");
    const os = await detectOS(connection);
    detectedOSType = os.osType;
    const pkgManager = await detectPackageManager(connection);

    const osLabel = os.osType === "macos" ? "macOS" : "Linux";
    log(`Detected: ${osLabel} - ${os.distro} ${os.version} (${os.arch}), package manager: ${pkgManager}`);

    // Adjust install directory based on OS
    const installDir = options.installDir || getDefaultInstallDir(os.osType);
    const opts = { ...DEFAULT_OPTIONS, ...options, installDir };

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
      const gitCmd = getGitInstallCommand(pkgManager);
      await connection.exec(gitCmd);
      log("Git installed");
    }

    // 4. Run installation script
    log("Running installation script...");
    const script = generateInstallScript(opts, os.osType);

    // Upload and execute script
    await connection.writeFile("/tmp/install-cra.sh", script, { mode: 0o755 });
    const installResult = await connection.exec("bash /tmp/install-cra.sh", {
      timeout: 600000, // 10 minutes
    });

    if (installResult.exit_code !== 0) {
      throw new Error(`Installation failed: ${installResult.stderr}`);
    }
    log("Installation script completed", installResult.stdout);

    // 5. Set up service if requested (systemd for Linux, launchd for macOS)
    if (opts.createService) {
      if (os.osType === "macos") {
        log("Creating launchd service...");
        const plistContent = generateLaunchdPlist(
          opts.installDir!,
          opts.serviceName!
        );
        const plistPath = `/Library/LaunchDaemons/com.claude.${opts.serviceName}.plist`;

        // Create log directory
        await connection.exec("sudo mkdir -p /usr/local/var/log");

        await connection.writeFile(plistPath, plistContent);
        await connection.exec(`sudo chown root:wheel ${plistPath}`);
        await connection.exec(`sudo chmod 644 ${plistPath}`);
        await connection.exec(`sudo launchctl load ${plistPath}`);
        log("Launchd service created and loaded");
      } else {
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
      message: `Claude Remote Agent installed successfully on ${osLabel}`,
      steps,
      osType: os.osType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Installation failed: ${message}`,
      steps,
      osType: detectedOSType,
    };
  }
}

/**
 * Generate a minimal install command that can be run via basic SSH
 */
export function getQuickInstallCommand(nodeVersion: string = "20"): string {
  return `curl -fsSL https://raw.githubusercontent.com/your-org/claude-remote-agent/main/install.sh | bash -s -- --node-version ${nodeVersion}`;
}

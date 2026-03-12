import { SSHConnection } from "../ssh/connection.js";
import { HostConfig } from "../types/index.js";

export type OSType = "linux" | "macos" | "windows" | "unknown";

export interface InstallOptions {
  installNode?: boolean;
  nodeVersion?: string;
  installDir?: string;
  createService?: boolean;  // systemd on Linux, launchd on macOS, Windows Service
  serviceName?: string;
}

const DEFAULT_OPTIONS: InstallOptions = {
  installNode: true,
  nodeVersion: "20",
  installDir: "/opt/claude-remote-agent",  // Will be adjusted per OS
  createService: false,
  serviceName: "claude-remote-agent",
};

/**
 * Get default install directory based on OS
 */
function getDefaultInstallDir(osType: OSType): string {
  switch (osType) {
    case "macos":
      return "/usr/local/opt/claude-remote-agent";
    case "windows":
      return "C:\\Program Files\\claude-remote-agent";
    default:
      return "/opt/claude-remote-agent";
  }
}

export type PackageManager =
  | "apt" | "yum" | "dnf" | "pacman" | "apk"  // Linux
  | "brew"                                      // macOS
  | "winget" | "choco" | "scoop"               // Windows
  | "unknown";

/**
 * Detect the remote system's package manager
 */
export async function detectPackageManager(
  connection: SSHConnection,
  osType?: OSType
): Promise<PackageManager> {
  // Windows package managers
  if (osType === "windows") {
    const winChecks = [
      { cmd: "where winget", result: "winget" as const },
      { cmd: "where choco", result: "choco" as const },
      { cmd: "where scoop", result: "scoop" as const },
    ];

    for (const check of winChecks) {
      const result = await connection.exec(check.cmd);
      if (result.exit_code === 0) {
        return check.result;
      }
    }
    return "unknown";
  }

  // Unix package managers
  const unixChecks = [
    { cmd: "which brew", result: "brew" as const },  // Check brew first (macOS)
    { cmd: "which apt-get", result: "apt" as const },
    { cmd: "which dnf", result: "dnf" as const },
    { cmd: "which yum", result: "yum" as const },
    { cmd: "which pacman", result: "pacman" as const },
    { cmd: "which apk", result: "apk" as const },
  ];

  for (const check of unixChecks) {
    const result = await connection.exec(check.cmd);
    if (result.exit_code === 0) {
      return check.result;
    }
  }

  return "unknown";
}

/**
 * Detect OS type (Linux vs macOS vs Windows)
 */
export async function detectOSType(connection: SSHConnection): Promise<OSType> {
  // Try uname first (works on Unix-like systems and Git Bash/WSL on Windows)
  const unameResult = await connection.exec("uname -s 2>/dev/null || echo UNKNOWN");
  const uname = unameResult.stdout.trim().toLowerCase();

  if (uname === "darwin") {
    return "macos";
  } else if (uname === "linux") {
    return "linux";
  } else if (uname.includes("mingw") || uname.includes("msys") || uname.includes("cygwin")) {
    // Git Bash, MSYS2, or Cygwin on Windows
    return "windows";
  }

  // Try Windows-specific detection via PowerShell
  const psResult = await connection.exec(
    'powershell -Command "[System.Environment]::OSVersion.Platform" 2>$null'
  );
  if (psResult.exit_code === 0 && psResult.stdout.trim().toLowerCase().includes("win")) {
    return "windows";
  }

  // Try cmd.exe
  const cmdResult = await connection.exec("echo %OS% 2>nul");
  if (cmdResult.exit_code === 0 && cmdResult.stdout.trim().toLowerCase().includes("windows")) {
    return "windows";
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
  let arch = "unknown";

  if (osType === "windows") {
    // Windows: use PowerShell or systeminfo
    const verResult = await connection.exec(
      'powershell -Command "(Get-CimInstance Win32_OperatingSystem).Caption"'
    );
    const buildResult = await connection.exec(
      'powershell -Command "(Get-CimInstance Win32_OperatingSystem).Version"'
    );
    const archResult = await connection.exec(
      'powershell -Command "$env:PROCESSOR_ARCHITECTURE"'
    );

    distro = verResult.exit_code === 0 ? verResult.stdout.trim() : "Windows";
    version = buildResult.exit_code === 0 ? buildResult.stdout.trim() : "unknown";
    arch = archResult.exit_code === 0 ? archResult.stdout.trim() : "unknown";

    // Map architecture names
    if (arch.toLowerCase() === "amd64") arch = "x86_64";
  } else if (osType === "macos") {
    // macOS: use sw_vers
    const prodResult = await connection.exec("sw_vers -productName 2>/dev/null");
    const verResult = await connection.exec("sw_vers -productVersion 2>/dev/null");
    const archResult = await connection.exec("uname -m");

    distro = prodResult.exit_code === 0 ? prodResult.stdout.trim() : "macOS";
    version = verResult.exit_code === 0 ? verResult.stdout.trim() : "unknown";
    arch = archResult.stdout.trim();
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

    const archResult = await connection.exec("uname -m");
    arch = archResult.stdout.trim();
  }

  return { osType, distro, version, arch };
}

/**
 * Check if Node.js is installed and get version
 */
export async function checkNodeInstalled(
  connection: SSHConnection,
  osType?: OSType
): Promise<{ installed: boolean; version?: string }> {
  // Try standard node command (works on all platforms)
  const cmd = osType === "windows"
    ? "node --version 2>nul"
    : "node --version 2>/dev/null";

  const result = await connection.exec(cmd);

  if (result.exit_code === 0 && result.stdout.trim().startsWith("v")) {
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
    // Windows package managers
    case "winget":
      return [`winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements`];
    case "choco":
      return [`choco install nodejs-lts -y`];
    case "scoop":
      return [`scoop install nodejs-lts`];

    // macOS
    case "brew":
      return [`brew install node@${nodeVersion} || brew install node`];

    // Linux
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
    // Windows
    case "winget":
      return "winget install Git.Git --accept-source-agreements --accept-package-agreements";
    case "choco":
      return "choco install git -y";
    case "scoop":
      return "scoop install git";

    // macOS
    case "brew":
      return "brew install git";

    // Linux
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
 * Generate the installation script (Unix - bash)
 */
export function generateInstallScript(
  options: InstallOptions = {},
  osType: OSType = "linux"
): string {
  if (osType === "windows") {
    return generateWindowsInstallScript(options);
  }

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
 * Generate the installation script for Windows (PowerShell)
 */
export function generateWindowsInstallScript(
  options: InstallOptions = {}
): string {
  const installDir = options.installDir || getDefaultInstallDir("windows");
  const opts = { ...DEFAULT_OPTIONS, ...options, installDir };

  // PowerShell script for Windows
  const script = `#Requires -RunAsAdministrator
# Claude Remote Agent - Windows Installation Script

$ErrorActionPreference = "Stop"

$INSTALL_DIR = "${opts.installDir.replace(/\\/g, "\\\\")}"
$SERVICE_NAME = "${opts.serviceName}"

Write-Host "=== Claude Remote Agent Installer ===" -ForegroundColor Green
Write-Host "Target OS: Windows"
Write-Host ""

# Create installation directory
Write-Host "[1/4] Creating installation directory..." -ForegroundColor Cyan
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
}

# Clone or download the agent
Write-Host "[2/4] Downloading claude-remote-agent..." -ForegroundColor Cyan
Set-Location $INSTALL_DIR

if (Get-Command git -ErrorAction SilentlyContinue) {
    if (Test-Path ".git") {
        git pull
    } else {
        git clone https://github.com/haxorthematrix/claude-remote-agent.git .
    }
} else {
    # Fallback: download zip
    $zipUrl = "https://github.com/haxorthematrix/claude-remote-agent/archive/main.zip"
    $zipFile = "$env:TEMP\\claude-remote-agent.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile
    Expand-Archive -Path $zipFile -DestinationPath "$env:TEMP\\cra-extract" -Force
    Copy-Item -Path "$env:TEMP\\cra-extract\\claude-remote-agent-main\\*" -Destination $INSTALL_DIR -Recurse -Force
    Remove-Item -Path $zipFile -Force
    Remove-Item -Path "$env:TEMP\\cra-extract" -Recurse -Force
}

# Install dependencies and build
Write-Host "[3/4] Installing dependencies..." -ForegroundColor Cyan
npm install
npm run build

# Add to PATH
Write-Host "[4/4] Adding to PATH..." -ForegroundColor Cyan
$binPath = Join-Path $INSTALL_DIR "dist"
$currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($currentPath -notlike "*$binPath*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$binPath", "Machine")
    Write-Host "Added $binPath to system PATH"
}

# Create batch file wrapper
$batchContent = @"
@echo off
node "$INSTALL_DIR\\dist\\cli.js" %*
"@
$batchPath = "C:\\Windows\\claude-remote-agent.cmd"
Set-Content -Path $batchPath -Value $batchContent -Force

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Claude Remote Agent installed to: $INSTALL_DIR"
Write-Host "Command available: claude-remote-agent"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open a new terminal (to refresh PATH)"
Write-Host "  2. Run 'claude-remote-agent init' to create config"
Write-Host "  3. Edit %USERPROFILE%\\.config\\claude-remote-agent\\hosts.yaml"
Write-Host ""
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
 * Generate Windows service installation commands (using NSSM or sc.exe)
 */
export function generateWindowsServiceCommands(
  installDir: string,
  serviceName: string
): string[] {
  // Using NSSM (Non-Sucking Service Manager) for better Node.js support
  // Falls back to sc.exe if NSSM not available
  const displayName = "Claude Remote Agent MCP Server";
  const nodeExe = "node.exe";
  const scriptPath = `${installDir}\\dist\\cli.js`;

  return [
    // Try NSSM first (better for Node.js services)
    `nssm install ${serviceName} "${nodeExe}" "${scriptPath} serve" 2>nul || (` +
    // Fallback to sc.exe with a wrapper batch file
    `sc create ${serviceName} binPath= "cmd /c node ${scriptPath} serve" start= auto DisplayName= "${displayName}"` +
    `)`,
    `sc description ${serviceName} "Claude Remote Agent MCP Server - enables Claude CLI to interact with this system"`,
  ];
}

/**
 * Generate PowerShell commands to create a Windows service
 */
export function generateWindowsServicePowerShell(
  installDir: string,
  serviceName: string
): string {
  return `
# Create Windows Service for Claude Remote Agent
$serviceName = "${serviceName}"
$displayName = "Claude Remote Agent MCP Server"
$description = "Claude Remote Agent MCP Server - enables Claude CLI to interact with this system"
$nodePath = (Get-Command node).Source
$scriptPath = "${installDir.replace(/\\/g, "\\\\")}\\dist\\cli.js"

# Check if NSSM is available (preferred for Node.js services)
if (Get-Command nssm -ErrorAction SilentlyContinue) {
    nssm install $serviceName $nodePath "$scriptPath serve"
    nssm set $serviceName DisplayName $displayName
    nssm set $serviceName Description $description
    nssm set $serviceName AppDirectory "${installDir.replace(/\\/g, "\\\\")}"
    nssm set $serviceName Start SERVICE_AUTO_START
    Write-Host "Service created using NSSM"
} else {
    # Create a wrapper script
    $wrapperPath = "${installDir.replace(/\\/g, "\\\\")}\\service-wrapper.cmd"
    $wrapperContent = @"
@echo off
cd /d "${installDir.replace(/\\/g, "\\\\")}"
node dist/cli.js serve
"@
    Set-Content -Path $wrapperPath -Value $wrapperContent

    # Use New-Service (requires wrapper for Node.js)
    New-Service -Name $serviceName \`
        -BinaryPathName "cmd.exe /c $wrapperPath" \`
        -DisplayName $displayName \`
        -Description $description \`
        -StartupType Automatic

    Write-Host "Service created using sc.exe wrapper"
}

Write-Host "Service '$serviceName' created. Start with: Start-Service $serviceName"
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

    const osLabel = os.osType === "macos" ? "macOS" : os.osType === "windows" ? "Windows" : "Linux";
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
    const gitCheckCmd = os.osType === "windows" ? "where git" : "which git";
    const gitCheck = await connection.exec(gitCheckCmd);
    if (gitCheck.exit_code !== 0) {
      log("Installing git...");
      const gitCmd = getGitInstallCommand(pkgManager);
      await connection.exec(gitCmd);
      log("Git installed");
    }

    // 4. Run installation script
    log("Running installation script...");
    const script = generateInstallScript(opts, os.osType);

    // Upload and execute script - different paths for Windows vs Unix
    let installResult;
    if (os.osType === "windows") {
      // Windows: use PowerShell
      const scriptPath = `${process.env.TEMP || "C:\\Windows\\Temp"}\\install-cra.ps1`;
      await connection.writeFile(scriptPath, script);
      installResult = await connection.exec(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 600000 }
      );
    } else {
      // Unix: use bash
      await connection.writeFile("/tmp/install-cra.sh", script, { mode: 0o755 });
      installResult = await connection.exec("bash /tmp/install-cra.sh", {
        timeout: 600000, // 10 minutes
      });
    }

    if (installResult.exit_code !== 0) {
      throw new Error(`Installation failed: ${installResult.stderr}`);
    }
    log("Installation script completed", installResult.stdout);

    // 5. Set up service if requested (systemd for Linux, launchd for macOS, Windows Service)
    if (opts.createService) {
      if (os.osType === "windows") {
        log("Creating Windows service...");
        const serviceScript = generateWindowsServicePowerShell(
          opts.installDir!,
          opts.serviceName!
        );
        const serviceScriptPath = `${process.env.TEMP || "C:\\Windows\\Temp"}\\create-service.ps1`;
        await connection.writeFile(serviceScriptPath, serviceScript);
        const serviceResult = await connection.exec(
          `powershell -ExecutionPolicy Bypass -File "${serviceScriptPath}"`,
          { timeout: 120000 }
        );
        if (serviceResult.exit_code !== 0) {
          log(`Warning: Service creation may have failed: ${serviceResult.stderr}`);
        } else {
          log("Windows service created");
        }
      } else if (os.osType === "macos") {
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
    const initCmd = os.osType === "windows"
      ? "claude-remote-agent init"
      : "claude-remote-agent init";
    await connection.exec(initCmd);
    log("Configuration initialized");

    // 7. Verify installation
    log("Verifying installation...");
    const verifyCmd = os.osType === "windows"
      ? "claude-remote-agent --version"
      : "claude-remote-agent --version";
    const verifyResult = await connection.exec(verifyCmd);
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

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SSH_CONFIG_PATH = path.join(os.homedir(), ".ssh", "config");

export interface SSHAlias {
  name: string;
  hostname: string;
  port?: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  extraOptions?: Record<string, string>;
}

/**
 * Parse SSH config file into structured entries
 */
export function parseSSHConfig(): SSHAlias[] {
  if (!fs.existsSync(SSH_CONFIG_PATH)) {
    return [];
  }

  const content = fs.readFileSync(SSH_CONFIG_PATH, "utf-8");
  const lines = content.split("\n");
  const aliases: SSHAlias[] = [];
  let current: Partial<SSHAlias> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("#") || trimmed === "") {
      continue;
    }

    // Match "Key Value" or "Key=Value"
    const match = trimmed.match(/^(\S+)\s+(.+)$/) || trimmed.match(/^(\S+)=(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    const keyLower = key.toLowerCase();

    if (keyLower === "host") {
      // Save previous entry
      if (current && current.name) {
        aliases.push(current as SSHAlias);
      }
      // Start new entry (skip wildcards)
      if (!value.includes("*")) {
        current = { name: value, extraOptions: {} };
      } else {
        current = null;
      }
    } else if (current) {
      switch (keyLower) {
        case "hostname":
          current.hostname = value;
          break;
        case "port":
          current.port = parseInt(value, 10);
          break;
        case "user":
          current.user = value;
          break;
        case "identityfile":
          current.identityFile = value;
          break;
        case "proxyjump":
          current.proxyJump = value;
          break;
        default:
          current.extraOptions = current.extraOptions || {};
          current.extraOptions[key] = value;
      }
    }
  }

  // Don't forget the last entry
  if (current && current.name) {
    aliases.push(current as SSHAlias);
  }

  return aliases;
}

/**
 * Get a specific SSH alias by name
 */
export function getSSHAlias(name: string): SSHAlias | undefined {
  const aliases = parseSSHConfig();
  return aliases.find((a) => a.name === name);
}

/**
 * Add or update an SSH alias in the config
 */
export function setSSHAlias(alias: SSHAlias): void {
  ensureSSHConfigExists();

  const existingAliases = parseSSHConfig();
  const existingIndex = existingAliases.findIndex((a) => a.name === alias.name);

  if (existingIndex >= 0) {
    // Update existing - need to rewrite the file
    existingAliases[existingIndex] = alias;
    writeSSHConfig(existingAliases);
  } else {
    // Append new entry
    const entry = formatSSHAlias(alias);
    const content = fs.readFileSync(SSH_CONFIG_PATH, "utf-8");
    const newContent = content.trimEnd() + "\n\n" + entry;
    fs.writeFileSync(SSH_CONFIG_PATH, newContent);
  }
}

/**
 * Remove an SSH alias from the config
 */
export function removeSSHAlias(name: string): boolean {
  const existingAliases = parseSSHConfig();
  const filtered = existingAliases.filter((a) => a.name !== name);

  if (filtered.length === existingAliases.length) {
    return false; // Not found
  }

  writeSSHConfig(filtered);
  return true;
}

/**
 * Format an SSH alias as config text
 */
function formatSSHAlias(alias: SSHAlias): string {
  const lines: string[] = [`Host ${alias.name}`];

  if (alias.hostname) {
    lines.push(`    HostName ${alias.hostname}`);
  }
  if (alias.port && alias.port !== 22) {
    lines.push(`    Port ${alias.port}`);
  }
  if (alias.user) {
    lines.push(`    User ${alias.user}`);
  }
  if (alias.identityFile) {
    lines.push(`    IdentityFile ${alias.identityFile}`);
  }
  if (alias.proxyJump) {
    lines.push(`    ProxyJump ${alias.proxyJump}`);
  }
  if (alias.extraOptions) {
    for (const [key, value] of Object.entries(alias.extraOptions)) {
      lines.push(`    ${key} ${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * Write complete SSH config from aliases
 */
function writeSSHConfig(aliases: SSHAlias[]): void {
  ensureSSHConfigExists();

  // Read existing file to preserve comments and wildcard hosts
  const existingContent = fs.readFileSync(SSH_CONFIG_PATH, "utf-8");
  const lines = existingContent.split("\n");

  // Extract header comments and wildcard host blocks
  const headerLines: string[] = [];
  const wildcardBlocks: string[] = [];
  let inWildcard = false;
  let currentWildcard: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase().startsWith("host ")) {
      const hostValue = trimmed.substring(5).trim();
      if (hostValue.includes("*")) {
        if (currentWildcard.length > 0) {
          wildcardBlocks.push(currentWildcard.join("\n"));
        }
        inWildcard = true;
        currentWildcard = [line];
      } else {
        if (inWildcard && currentWildcard.length > 0) {
          wildcardBlocks.push(currentWildcard.join("\n"));
          currentWildcard = [];
        }
        inWildcard = false;
      }
    } else if (inWildcard) {
      currentWildcard.push(line);
    } else if (!lines.slice(0, lines.indexOf(line)).some((l) => l.trim().toLowerCase().startsWith("host "))) {
      // Header (before any Host entries)
      if (trimmed !== "" || headerLines.length > 0) {
        headerLines.push(line);
      }
    }
  }

  if (currentWildcard.length > 0) {
    wildcardBlocks.push(currentWildcard.join("\n"));
  }

  // Build new config
  const parts: string[] = [];

  if (headerLines.length > 0) {
    parts.push(headerLines.join("\n").trimEnd());
  }

  if (wildcardBlocks.length > 0) {
    parts.push(wildcardBlocks.join("\n\n"));
  }

  for (const alias of aliases) {
    parts.push(formatSSHAlias(alias));
  }

  const newContent = parts.join("\n\n") + "\n";
  fs.writeFileSync(SSH_CONFIG_PATH, newContent);
}

/**
 * Ensure ~/.ssh/config exists with correct permissions
 */
function ensureSSHConfigExists(): void {
  const sshDir = path.dirname(SSH_CONFIG_PATH);

  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { mode: 0o700 });
  }

  if (!fs.existsSync(SSH_CONFIG_PATH)) {
    fs.writeFileSync(SSH_CONFIG_PATH, "# SSH Config\n", { mode: 0o600 });
  }
}

/**
 * Validate that we can connect to an alias (basic check)
 */
export function validateAlias(alias: SSHAlias): string[] {
  const errors: string[] = [];

  if (!alias.name || alias.name.trim() === "") {
    errors.push("Alias name is required");
  }

  if (!alias.hostname || alias.hostname.trim() === "") {
    errors.push("Hostname or IP address is required");
  }

  if (alias.port && (alias.port < 1 || alias.port > 65535)) {
    errors.push("Port must be between 1 and 65535");
  }

  if (alias.identityFile) {
    const expandedPath = alias.identityFile.replace(/^~/, os.homedir());
    if (!fs.existsSync(expandedPath)) {
      errors.push(`Identity file not found: ${alias.identityFile}`);
    }
  }

  return errors;
}

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";
import {
  Config,
  ConfigSchema,
  GlobalConfig,
  HostConfig,
  PolicyConfig,
} from "../types/index.js";

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".config", "claude-remote-agent");
const CONFIG_FILE = "config.yaml";
const HOSTS_FILE = "hosts.yaml";

export class ConfigLoader {
  private configDir: string;
  private config: Config | null = null;

  constructor(configDir?: string) {
    this.configDir = configDir || DEFAULT_CONFIG_DIR;
  }

  /**
   * Load configuration from disk
   */
  async load(): Promise<Config> {
    const configPath = path.join(this.configDir, CONFIG_FILE);
    const hostsPath = path.join(this.configDir, HOSTS_FILE);

    let globalConfig: Partial<GlobalConfig> = {};
    let hostsConfig: { hosts?: Record<string, unknown>; groups?: Record<string, string[]> } = {};

    // Load global config if exists
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content);
      globalConfig = parsed?.global || {};
    }

    // Load hosts config if exists
    if (fs.existsSync(hostsPath)) {
      const content = fs.readFileSync(hostsPath, "utf-8");
      hostsConfig = parseYaml(content) || {};
    }

    // Merge and validate
    const merged = {
      global: globalConfig,
      hosts: hostsConfig.hosts || {},
      groups: hostsConfig.groups || {},
    };

    this.config = ConfigSchema.parse(merged);
    return this.config;
  }

  /**
   * Get loaded config (throws if not loaded)
   */
  getConfig(): Config {
    if (!this.config) {
      throw new Error("Configuration not loaded. Call load() first.");
    }
    return this.config;
  }

  /**
   * Get global configuration
   */
  getGlobalConfig(): GlobalConfig {
    return this.getConfig().global;
  }

  /**
   * Get host configuration by name
   */
  getHost(name: string): HostConfig | undefined {
    return this.getConfig().hosts[name];
  }

  /**
   * Get hosts in a group
   */
  getGroup(name: string): string[] {
    return this.getConfig().groups[name] || [];
  }

  /**
   * Resolve host or group to list of host names
   */
  resolveHosts(nameOrGroup: string): string[] {
    const config = this.getConfig();

    // Check if it's a group
    if (config.groups[nameOrGroup]) {
      return config.groups[nameOrGroup];
    }

    // Check if it's a host
    if (config.hosts[nameOrGroup]) {
      return [nameOrGroup];
    }

    throw new Error(`Unknown host or group: ${nameOrGroup}`);
  }

  /**
   * Get effective policy for a host (merged with defaults)
   */
  getEffectivePolicy(hostName: string): PolicyConfig {
    const config = this.getConfig();
    const host = config.hosts[hostName];

    if (!host) {
      throw new Error(`Unknown host: ${hostName}`);
    }

    // Merge host policy with default policy
    const defaultPolicy = config.global.default_policy;
    const hostPolicy: Partial<PolicyConfig> = host.policy || {};

    return {
      confirmation_required:
        hostPolicy.confirmation_required || defaultPolicy.confirmation_required,
      allowed_commands:
        hostPolicy.allowed_commands !== undefined
          ? hostPolicy.allowed_commands
          : defaultPolicy.allowed_commands,
      blocked_commands: [
        ...defaultPolicy.blocked_commands,
        ...(hostPolicy.blocked_commands || []),
      ],
      blocked_patterns: [
        ...defaultPolicy.blocked_patterns,
        ...(hostPolicy.blocked_patterns || []),
      ],
      read_only: hostPolicy.read_only ?? defaultPolicy.read_only,
    };
  }

  /**
   * List all configured hosts
   */
  listHosts(): Array<{ name: string; config: HostConfig }> {
    return Object.entries(this.getConfig().hosts).map(([name, config]) => ({
      name,
      config,
    }));
  }

  /**
   * Initialize config directory with example files
   */
  async init(): Promise<void> {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    const configPath = path.join(this.configDir, CONFIG_FILE);
    const hostsPath = path.join(this.configDir, HOSTS_FILE);

    // Copy example files if they don't exist
    const exampleDir = path.join(__dirname, "..", "..", "config");

    if (!fs.existsSync(configPath)) {
      const example = fs.readFileSync(
        path.join(exampleDir, "config.example.yaml"),
        "utf-8"
      );
      fs.writeFileSync(configPath, example);
      console.log(`Created ${configPath}`);
    }

    if (!fs.existsSync(hostsPath)) {
      const example = fs.readFileSync(
        path.join(exampleDir, "hosts.example.yaml"),
        "utf-8"
      );
      fs.writeFileSync(hostsPath, example);
      console.log(`Created ${hostsPath}`);
    }
  }
}

// Singleton instance
let loader: ConfigLoader | null = null;

export function getConfigLoader(configDir?: string): ConfigLoader {
  if (!loader || configDir) {
    loader = new ConfigLoader(configDir);
  }
  return loader;
}

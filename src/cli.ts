#!/usr/bin/env node

import { Command } from "commander";
import { getConfigLoader } from "./config/loader.js";
import { main as startServer } from "./index.js";
import {
  parseSSHConfig,
  setSSHAlias,
  removeSSHAlias,
  SSHAlias,
} from "./ssh/aliases.js";

const program = new Command();

program
  .name("claude-remote-agent")
  .description("MCP server enabling Claude CLI to interact with remote systems via SSH")
  .version("0.1.0");

program
  .command("serve")
  .description("Start the MCP server (used by Claude CLI)")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (options) => {
    process.env.CRA_CONFIG_PATH = options.config;
    await startServer();
  });

program
  .command("init")
  .description("Initialize configuration directory with example files")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (options) => {
    const loader = getConfigLoader(options.config);
    await loader.init();
    console.log("\nConfiguration initialized!");
    console.log("Edit the config files to add your remote hosts.");
    console.log("\nTo add to Claude CLI, run:");
    console.log('  claude mcp add remote-agent -- claude-remote-agent serve');
  });

program
  .command("list")
  .description("List configured hosts")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (options) => {
    try {
      const loader = getConfigLoader(options.config);
      await loader.load();

      const hosts = loader.listHosts();

      if (hosts.length === 0) {
        console.log("No hosts configured.");
        console.log("Run 'claude-remote-agent init' to create example config files.");
        return;
      }

      console.log("Configured hosts:\n");
      for (const { name, config } of hosts) {
        console.log(`  ${name}`);
        console.log(`    Host: ${config.hostname}:${config.port}`);
        console.log(`    User: ${config.user}`);
        console.log(`    Auth: ${config.auth.type}`);
        if (Object.keys(config.labels).length > 0) {
          const labels = Object.entries(config.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          console.log(`    Labels: ${labels}`);
        }
        console.log();
      }

      const cfg = loader.getConfig();
      const groups = Object.keys(cfg.groups);
      if (groups.length > 0) {
        console.log("Groups:");
        for (const group of groups) {
          const members = cfg.groups[group].join(", ");
          console.log(`  ${group}: ${members}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("test <host>")
  .description("Test connection to a host")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (host, options) => {
    try {
      const { SSHConnection } = await import("./ssh/connection.js");

      const loader = getConfigLoader(options.config);
      await loader.load();

      const hostConfig = loader.getHost(host);
      if (!hostConfig) {
        console.error(`Unknown host: ${host}`);
        process.exit(1);
      }

      console.log(`Testing connection to ${host} (${hostConfig.hostname})...`);

      const connection = new SSHConnection(host, hostConfig);
      await connection.connect();

      const result = await connection.exec("echo 'Connection successful!' && hostname && uptime");

      console.log("\nConnection successful!");
      console.log(`Output:\n${result.stdout}`);

      connection.disconnect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Connection failed: ${message}`);
      process.exit(1);
    }
  });

program
  .command("check-policy <host> <command>")
  .description("Check if a command is allowed by the host's policy")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (host, command, options) => {
    try {
      const { policyEngine } = await import("./security/policy.js");

      const loader = getConfigLoader(options.config);
      await loader.load();

      const policy = loader.getEffectivePolicy(host);
      const result = policyEngine.checkCommand(command, policy);

      if (result.allowed) {
        console.log(`✓ Command is ALLOWED on ${host}`);
        if (result.requires_confirmation) {
          console.log(`  Note: Confirmation will be required`);
        }
      } else {
        console.log(`✗ Command is BLOCKED on ${host}`);
        console.log(`  Reason: ${result.reason}`);
        if (result.blocked_by) {
          console.log(`  Rule: ${result.blocked_by}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// SSH Alias Commands
const aliasCmd = program
  .command("alias")
  .description("Manage SSH aliases in ~/.ssh/config");

aliasCmd
  .command("list")
  .description("List all SSH aliases")
  .action(() => {
    const aliases = parseSSHConfig();

    if (aliases.length === 0) {
      console.log("No SSH aliases configured.");
      return;
    }

    console.log("SSH Aliases:\n");
    for (const alias of aliases) {
      console.log(`  ${alias.name}`);
      console.log(`    Hostname: ${alias.hostname || "(not set)"}`);
      if (alias.port) console.log(`    Port: ${alias.port}`);
      if (alias.user) console.log(`    User: ${alias.user}`);
      if (alias.identityFile) console.log(`    IdentityFile: ${alias.identityFile}`);
      if (alias.proxyJump) console.log(`    ProxyJump: ${alias.proxyJump}`);
      console.log();
    }
  });

aliasCmd
  .command("add <name>")
  .description("Add or update an SSH alias")
  .requiredOption("-H, --hostname <hostname>", "Hostname or IP address")
  .option("-p, --port <port>", "SSH port", "22")
  .option("-u, --user <user>", "Username")
  .option("-i, --identity <path>", "Path to identity file")
  .option("-J, --proxy-jump <host>", "ProxyJump host")
  .action((name, options) => {
    const alias: SSHAlias = {
      name,
      hostname: options.hostname,
      port: options.port ? parseInt(options.port, 10) : undefined,
      user: options.user,
      identityFile: options.identity,
      proxyJump: options.proxyJump,
    };

    setSSHAlias(alias);
    console.log(`Added SSH alias '${name}'`);
    console.log(`\nYou can now connect with: ssh ${name}`);
  });

aliasCmd
  .command("remove <name>")
  .description("Remove an SSH alias")
  .action((name) => {
    const removed = removeSSHAlias(name);
    if (removed) {
      console.log(`Removed SSH alias '${name}'`);
    } else {
      console.error(`SSH alias '${name}' not found`);
      process.exit(1);
    }
  });

// Add host command (combines SSH alias + agent config)
program
  .command("add-host <name>")
  .description("Add a new remote host (creates SSH alias + agent config)")
  .requiredOption("-H, --hostname <hostname>", "Hostname or IP address")
  .requiredOption("-u, --user <user>", "SSH username")
  .option("-p, --port <port>", "SSH port", "22")
  .option("-i, --identity <path>", "Path to identity file", "~/.ssh/id_ed25519")
  .option("--policy <level>", "Security policy (relaxed|moderate|strict|read-only)", "moderate")
  .option("-c, --config <path>", "Path to config directory")
  .action(async (name, options) => {
    // Create SSH alias
    const alias: SSHAlias = {
      name,
      hostname: options.hostname,
      port: parseInt(options.port, 10),
      user: options.user,
      identityFile: options.identity,
    };

    setSSHAlias(alias);
    console.log(`\n1. Created SSH alias '${name}'`);

    // Generate hosts.yaml entry
    const policyMap: Record<string, string> = {
      relaxed: "never",
      moderate: "destructive_only",
      strict: "always",
      "read-only": "always",
    };

    const hostYaml = `
  ${name}:
    hostname: ${options.hostname}
    port: ${options.port}
    user: ${options.user}
    auth:
      type: key
      key_path: ${options.identity}
    policy:
      confirmation_required: ${policyMap[options.policy]}${options.policy === "read-only" ? "\n      read_only: true" : ""}
`;

    console.log(`\n2. Add this to ~/.config/claude-remote-agent/hosts.yaml:`);
    console.log("```yaml");
    console.log(hostYaml);
    console.log("```");

    console.log(`\n3. Test with: ssh ${name}`);
    console.log(`4. Test with agent: claude-remote-agent test ${name}`);
  });

program.parse();

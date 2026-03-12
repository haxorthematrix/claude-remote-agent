import { Client, ConnectConfig, ClientChannel } from "ssh2";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HostConfig, AuthConfig } from "../types/index.js";

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export class SSHConnection {
  private client: Client;
  private connected: boolean = false;
  private hostName: string;
  private config: HostConfig;

  constructor(hostName: string, config: HostConfig) {
    this.client = new Client();
    this.hostName = hostName;
    this.config = config;
  }

  /**
   * Connect to the remote host
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const connectConfig = await this.buildConnectConfig();

    return new Promise((resolve, reject) => {
      this.client.on("ready", () => {
        this.connected = true;
        resolve();
      });

      this.client.on("error", (err) => {
        this.connected = false;
        reject(new Error(`SSH connection failed to ${this.hostName}: ${err.message}`));
      });

      this.client.on("close", () => {
        this.connected = false;
      });

      this.client.connect(connectConfig);
    });
  }

  /**
   * Execute a command on the remote host
   */
  async exec(
    command: string,
    options: {
      timeout?: number;
      working_dir?: string;
      env?: Record<string, string>;
      stdin?: string;
    } = {}
  ): Promise<ExecResult> {
    if (!this.connected) {
      await this.connect();
    }

    const startTime = Date.now();
    let fullCommand = command;

    // Prepend cd if working directory is specified
    if (options.working_dir) {
      fullCommand = `cd ${this.escapeShellArg(options.working_dir)} && ${command}`;
    }

    // Prepend environment variables
    if (options.env && Object.keys(options.env).length > 0) {
      const envPrefix = Object.entries(options.env)
        .map(([key, value]) => `${key}=${this.escapeShellArg(value)}`)
        .join(" ");
      fullCommand = `${envPrefix} ${fullCommand}`;
    }

    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 300000; // 5 minutes default
      let timeoutHandle: NodeJS.Timeout | null = null;

      this.client.exec(fullCommand, (err, stream) => {
        if (err) {
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";

        // Set up timeout
        timeoutHandle = setTimeout(() => {
          stream.close();
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);

        stream.on("close", (code: number) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          resolve({
            exit_code: code,
            stdout,
            stderr,
            duration_ms: Date.now() - startTime,
          });
        });

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        // Write stdin if provided
        if (options.stdin) {
          stream.write(options.stdin);
          stream.end();
        }
      });
    });
  }

  /**
   * Read a file from the remote host via SFTP
   */
  async readFile(remotePath: string): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP connection failed: ${err.message}`));
          return;
        }

        sftp.readFile(remotePath, "utf-8", (err, data) => {
          if (err) {
            reject(new Error(`Failed to read file ${remotePath}: ${err.message}`));
            return;
          }
          resolve(data.toString());
        });
      });
    });
  }

  /**
   * Write a file to the remote host via SFTP
   */
  async writeFile(
    remotePath: string,
    content: string,
    options: { mode?: number } = {}
  ): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP connection failed: ${err.message}`));
          return;
        }

        const writeOptions: { mode?: number } = {};
        if (options.mode) {
          writeOptions.mode = options.mode;
        }

        sftp.writeFile(remotePath, content, writeOptions, (err) => {
          if (err) {
            reject(new Error(`Failed to write file ${remotePath}: ${err.message}`));
            return;
          }
          resolve();
        });
      });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the connection
   */
  disconnect(): void {
    if (this.connected) {
      this.client.end();
      this.connected = false;
    }
  }

  /**
   * Build ssh2 connect configuration from host config
   */
  private async buildConnectConfig(): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: this.config.hostname,
      port: this.config.port || 22,
      username: this.config.user,
    };

    // Handle authentication
    const auth = this.config.auth;

    switch (auth.type) {
      case "key":
        const keyPath = this.expandPath(auth.key_path);
        config.privateKey = fs.readFileSync(keyPath);
        if (auth.passphrase) {
          config.passphrase = auth.passphrase;
        }
        break;

      case "password":
        config.password = auth.password;
        break;

      case "agent":
        config.agent = process.env.SSH_AUTH_SOCK;
        break;
    }

    return config;
  }

  /**
   * Expand ~ and environment variables in path
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith("~")) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
  }

  /**
   * Escape a shell argument
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

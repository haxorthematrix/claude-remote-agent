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

export interface ProxyJumpConfig {
  hostname: string;
  port: number;
  user: string;
  auth: AuthConfig;
}

export class SSHConnection {
  private client: Client;
  private proxyClient: Client | null = null;
  private connected: boolean = false;
  private hostName: string;
  private config: HostConfig;
  private proxyConfig: ProxyJumpConfig | null = null;

  constructor(hostName: string, config: HostConfig, proxyConfig?: ProxyJumpConfig) {
    this.client = new Client();
    this.hostName = hostName;
    this.config = config;
    this.proxyConfig = proxyConfig || null;
  }

  /**
   * Connect to the remote host
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // If we have a proxy config, connect through the proxy first
    if (this.proxyConfig) {
      await this.connectThroughProxy();
    } else {
      await this.connectDirect();
    }
  }

  /**
   * Connect directly to the host
   */
  private async connectDirect(): Promise<void> {
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
   * Connect through a proxy/bastion host (ProxyJump)
   */
  private async connectThroughProxy(): Promise<void> {
    if (!this.proxyConfig) {
      throw new Error("No proxy configuration provided");
    }

    // Step 1: Connect to the proxy/bastion host
    this.proxyClient = new Client();
    const proxyConnectConfig = await this.buildConnectConfigForProxy(this.proxyConfig);

    await new Promise<void>((resolve, reject) => {
      this.proxyClient!.on("ready", () => {
        resolve();
      });

      this.proxyClient!.on("error", (err) => {
        reject(new Error(`SSH connection to proxy host failed: ${err.message}`));
      });

      this.proxyClient!.connect(proxyConnectConfig);
    });

    // Step 2: Create a forwarded connection to the final destination
    const destHost = this.config.hostname;
    const destPort = this.config.port || 22;

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      this.proxyClient!.forwardOut(
        "127.0.0.1",
        0, // Let the system choose a source port
        destHost,
        destPort,
        (err, stream) => {
          if (err) {
            reject(new Error(`Failed to forward connection through proxy: ${err.message}`));
            return;
          }
          resolve(stream);
        }
      );
    });

    // Step 3: Connect to the final destination through the forwarded stream
    const connectConfig = await this.buildConnectConfig();
    // Use the stream as the socket for the connection
    // The ssh2 library supports using a Channel as sock for proxy connections
    (connectConfig as Record<string, unknown>).sock = stream;

    return new Promise((resolve, reject) => {
      this.client.on("ready", () => {
        this.connected = true;
        resolve();
      });

      this.client.on("error", (err) => {
        this.connected = false;
        reject(new Error(`SSH connection to ${this.hostName} through proxy failed: ${err.message}`));
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
   * Upload a local file to the remote host via SFTP
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    options: { mode?: number } = {}
  ): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    const expandedLocalPath = this.expandPath(localPath);

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP connection failed: ${err.message}`));
          return;
        }

        const readStream = fs.createReadStream(expandedLocalPath);
        const writeStream = sftp.createWriteStream(remotePath, {
          mode: options.mode,
        });

        writeStream.on("close", () => {
          resolve();
        });

        writeStream.on("error", (err: Error) => {
          reject(new Error(`Failed to upload file to ${remotePath}: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          reject(new Error(`Failed to read local file ${localPath}: ${err.message}`));
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Download a file from the remote host to local via SFTP
   */
  async downloadFile(
    remotePath: string,
    localPath: string
  ): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    const expandedLocalPath = this.expandPath(localPath);

    // Ensure local directory exists
    const localDir = path.dirname(expandedLocalPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP connection failed: ${err.message}`));
          return;
        }

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(expandedLocalPath);

        writeStream.on("close", () => {
          resolve();
        });

        writeStream.on("error", (err: Error) => {
          reject(new Error(`Failed to write local file ${localPath}: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          reject(new Error(`Failed to download file ${remotePath}: ${err.message}`));
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Get file stats from remote host
   */
  async stat(remotePath: string): Promise<{ size: number; isDirectory: boolean; mode: number }> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP connection failed: ${err.message}`));
          return;
        }

        sftp.stat(remotePath, (err, stats) => {
          if (err) {
            reject(new Error(`Failed to stat ${remotePath}: ${err.message}`));
            return;
          }
          resolve({
            size: stats.size,
            isDirectory: stats.isDirectory(),
            mode: stats.mode,
          });
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
    // Also disconnect the proxy client if we used one
    if (this.proxyClient) {
      this.proxyClient.end();
      this.proxyClient = null;
    }
  }

  /**
   * Check if using a proxy connection
   */
  isUsingProxy(): boolean {
    return this.proxyConfig !== null;
  }

  /**
   * Get proxy host name (if using proxy)
   */
  getProxyHost(): string | null {
    return this.proxyConfig?.hostname || null;
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
   * Build ssh2 connect configuration for proxy host
   */
  private async buildConnectConfigForProxy(proxyConfig: ProxyJumpConfig): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: proxyConfig.hostname,
      port: proxyConfig.port || 22,
      username: proxyConfig.user,
    };

    // Handle authentication for proxy
    const auth = proxyConfig.auth;

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

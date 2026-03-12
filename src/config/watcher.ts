import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

export interface ConfigWatcherOptions {
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
  /** Whether to log reload events to stderr (default: true) */
  logReloads?: boolean;
}

export interface ConfigWatcherEvents {
  reload: () => void;
  error: (error: Error) => void;
}

/**
 * Watches configuration files for changes and triggers reload events.
 * Uses debouncing to avoid multiple reloads for rapid changes.
 */
export class ConfigWatcher extends EventEmitter {
  private configDir: string;
  private watchers: fs.FSWatcher[] = [];
  private debounceMs: number;
  private logReloads: boolean;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watching: boolean = false;

  constructor(configDir: string, options: ConfigWatcherOptions = {}) {
    super();
    this.configDir = configDir;
    this.debounceMs = options.debounceMs ?? 500;
    this.logReloads = options.logReloads ?? true;
  }

  /**
   * Start watching configuration files
   */
  start(): void {
    if (this.watching) {
      return;
    }

    const filesToWatch = ["config.yaml", "hosts.yaml"];

    for (const file of filesToWatch) {
      const filePath = path.join(this.configDir, file);

      // Only watch if the file exists
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const watcher = fs.watch(filePath, (eventType) => {
          if (eventType === "change") {
            this.scheduleReload(file);
          }
        });

        watcher.on("error", (error) => {
          this.emit("error", new Error(`Watch error for ${file}: ${error.message}`));
        });

        this.watchers.push(watcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit("error", new Error(`Failed to watch ${file}: ${message}`));
      }
    }

    // Also watch the directory for new files
    try {
      const dirWatcher = fs.watch(this.configDir, (eventType, filename) => {
        if (filename && filesToWatch.includes(filename)) {
          this.scheduleReload(filename);
        }
      });

      dirWatcher.on("error", (error) => {
        this.emit("error", new Error(`Directory watch error: ${error.message}`));
      });

      this.watchers.push(dirWatcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("error", new Error(`Failed to watch config directory: ${message}`));
    }

    this.watching = true;

    if (this.logReloads) {
      console.error(`[claude-remote-agent] Watching for config changes in ${this.configDir}`);
    }
  }

  /**
   * Stop watching configuration files
   */
  stop(): void {
    if (!this.watching) {
      return;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.watching = false;
  }

  /**
   * Check if currently watching
   */
  isWatching(): boolean {
    return this.watching;
  }

  /**
   * Schedule a reload with debouncing
   */
  private scheduleReload(changedFile: string): void {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Schedule new reload
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      if (this.logReloads) {
        console.error(`[claude-remote-agent] Config changed (${changedFile}), reloading...`);
      }

      this.emit("reload");
    }, this.debounceMs);
  }

  /**
   * Typed event emitter methods
   */
  on<K extends keyof ConfigWatcherEvents>(
    event: K,
    listener: ConfigWatcherEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof ConfigWatcherEvents>(
    event: K,
    ...args: Parameters<ConfigWatcherEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Create a config watcher that automatically reloads a ConfigLoader
 */
export function createConfigWatcher(
  configDir: string,
  onReload: () => Promise<void>,
  options: ConfigWatcherOptions = {}
): ConfigWatcher {
  const watcher = new ConfigWatcher(configDir, options);

  watcher.on("reload", async () => {
    try {
      await onReload();
      if (options.logReloads !== false) {
        console.error("[claude-remote-agent] Configuration reloaded successfully");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[claude-remote-agent] Failed to reload configuration: ${message}`);
    }
  });

  watcher.on("error", (error) => {
    console.error(`[claude-remote-agent] Config watcher error: ${error.message}`);
  });

  return watcher;
}

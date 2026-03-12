import { z } from "zod";

// Authentication types
export const AuthConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("key"),
    key_path: z.string(),
    passphrase: z.string().optional(),
  }),
  z.object({
    type: z.literal("password"),
    password: z.string(),
  }),
  z.object({
    type: z.literal("agent"),
  }),
]);

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// Confirmation levels
export const ConfirmationLevel = z.enum([
  "never",
  "destructive_only",
  "write_only",
  "always",
]);

export type ConfirmationLevel = z.infer<typeof ConfirmationLevel>;

// Security policy
export const PolicyConfigSchema = z.object({
  confirmation_required: ConfirmationLevel.default("destructive_only"),
  allowed_commands: z.union([z.literal("*"), z.array(z.string())]).default([]),
  blocked_commands: z.array(z.string()).default([]),
  blocked_patterns: z.array(z.string()).default([]),
  read_only: z.boolean().default(false),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

// Host configuration
export const HostConfigSchema = z.object({
  hostname: z.string(),
  port: z.number().default(22),
  user: z.string(),
  auth: AuthConfigSchema,
  policy: PolicyConfigSchema.optional(),
  proxy_jump: z.string().optional(),
  labels: z.record(z.string()).default({}),
});

export type HostConfig = z.infer<typeof HostConfigSchema>;

// Global configuration
export const GlobalConfigSchema = z.object({
  default_timeout: z.number().default(300),
  connection_pool: z
    .object({
      max_connections_per_host: z.number().default(5),
      idle_timeout: z.number().default(600),
      keepalive_interval: z.number().default(30),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      log_path: z.string().default("~/.config/claude-remote-agent/audit.log"),
      log_commands: z.boolean().default(true),
      log_output: z.boolean().default(true),
      max_output_logged: z.number().default(10000),
    })
    .default({}),
  default_policy: PolicyConfigSchema.default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// Full configuration
export const ConfigSchema = z.object({
  global: GlobalConfigSchema.default({}),
  hosts: z.record(HostConfigSchema).default({}),
  groups: z.record(z.array(z.string())).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// Tool parameter types
export interface RemoteExecuteParams {
  host: string;
  command: string;
  timeout?: number;
  working_dir?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface RemoteExecuteResult {
  host: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  confirmation_skipped?: boolean;
}

export interface RemoteFileReadParams {
  host: string;
  path: string;
  offset?: number;
  limit?: number;
  encoding?: string;
}

export interface RemoteFileWriteParams {
  host: string;
  path: string;
  content: string;
  mode?: string;
  backup?: boolean;
}

export interface RemoteFileEditParams {
  host: string;
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface RemoteUploadParams {
  host: string;
  local_path: string;
  remote_path: string;
  mode?: string;
}

export interface RemoteDownloadParams {
  host: string;
  remote_path: string;
  local_path: string;
}

export interface RemoteSessionStartParams {
  host: string;
  working_dir?: string;
  env?: Record<string, string>;
}

export interface RemoteSessionExecuteParams {
  session_id: string;
  command: string;
  timeout?: number;
}

export interface RemoteSessionEndParams {
  session_id: string;
}

// Connection state
export interface ConnectionState {
  host: string;
  connected: boolean;
  lastActivity: Date;
  sessionCount: number;
}

// Audit log entry
export interface AuditEntry {
  timestamp: string;
  session_id: string;
  host: string;
  user: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  confirmed_by: "user" | "policy" | "pre-approved";
  output_hash?: string;
}

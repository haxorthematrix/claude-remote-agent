/**
 * Output Sanitizer - Detects and redacts sensitive data from command output
 *
 * This module provides pattern-based detection and redaction of sensitive
 * information like passwords, API keys, tokens, and other secrets.
 */

export interface SanitizerConfig {
  /** Whether sanitization is enabled (default: true) */
  enabled: boolean;
  /** Additional custom patterns to detect */
  custom_patterns?: string[];
  /** Replacement string for redacted content (default: "[REDACTED]") */
  redaction_string?: string;
}

export interface SanitizeResult {
  /** The sanitized output */
  output: string;
  /** Number of redactions made */
  redaction_count: number;
  /** Types of secrets detected */
  detected_types: string[];
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
  /** Group index to redact (if pattern has groups), or redact full match */
  redactGroup?: number;
}

/**
 * Common patterns for detecting secrets in output
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // Password patterns
  {
    name: "password_assignment",
    pattern: /(?:password|passwd|pwd|pass)\s*[:=]\s*['"]?([^'"\s\n]+)['"]?/gi,
    redactGroup: 1,
  },
  {
    name: "password_flag",
    pattern: /(?:--password|--passwd|-p)\s+['"]?([^'"\s\n]+)['"]?/gi,
    redactGroup: 1,
  },

  // API Keys
  {
    name: "generic_api_key",
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{16,})['"]?/gi,
    redactGroup: 1,
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+([a-zA-Z0-9_\-\.]+)/gi,
    redactGroup: 1,
  },
  {
    name: "authorization_header",
    pattern: /Authorization:\s*['"]?([^'"\n]+)['"]?/gi,
    redactGroup: 1,
  },

  // AWS Credentials
  {
    name: "aws_access_key",
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
  },
  {
    name: "aws_secret_key",
    pattern: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?([a-zA-Z0-9\/+=]{40})['"]?/gi,
    redactGroup: 1,
  },

  // Private Keys
  {
    name: "private_key",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },

  // JWT Tokens
  {
    name: "jwt_token",
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  },

  // Database Connection Strings
  {
    name: "db_connection_string",
    pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:]+:([^@]+)@/gi,
    redactGroup: 1,
  },

  // GitHub/GitLab Tokens
  {
    name: "github_token",
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
  },
  {
    name: "gitlab_token",
    pattern: /glpat-[a-zA-Z0-9_\-]{20,}/g,
  },

  // Slack Tokens
  {
    name: "slack_token",
    pattern: /xox[baprs]-[a-zA-Z0-9\-]+/g,
  },

  // Generic Secrets
  {
    name: "secret_assignment",
    pattern: /(?:secret|token|credential|auth)\s*[:=]\s*['"]?([^'"\s\n]{8,})['"]?/gi,
    redactGroup: 1,
  },

  // SSH Password prompts with entered passwords (if echoed)
  {
    name: "ssh_password",
    pattern: /(?:password|passphrase) for [^:]+:\s*(.+)$/gim,
    redactGroup: 1,
  },

  // Environment variable exports
  {
    name: "env_secret_export",
    pattern: /export\s+(?:.*(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|AUTH)[^=]*)=(['"]?)([^'"\n]+)\1/gi,
    redactGroup: 2,
  },

  // .env file patterns
  {
    name: "dotenv_secret",
    pattern: /^(?:.*(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|AUTH)[^=]*)=(['"]?)([^'"\n]+)\1$/gim,
    redactGroup: 2,
  },

  // Basic Auth in URLs
  {
    name: "url_basic_auth",
    pattern: /:\/\/([^:]+):([^@]+)@/g,
    redactGroup: 2,
  },

  // Windows credential patterns
  {
    name: "windows_credential",
    pattern: /(?:net use|runas).*\/user:\S+\s+(\S+)/gi,
    redactGroup: 1,
  },
];

/**
 * Sanitizer class for detecting and redacting sensitive data
 */
export class OutputSanitizer {
  private enabled: boolean;
  private customPatterns: RegExp[];
  private redactionString: string;

  constructor(config?: Partial<SanitizerConfig>) {
    this.enabled = config?.enabled ?? true;
    this.redactionString = config?.redaction_string ?? "[REDACTED]";
    this.customPatterns = (config?.custom_patterns ?? []).map(
      (p) => new RegExp(p, "gi")
    );
  }

  /**
   * Sanitize output by redacting detected secrets
   */
  sanitize(input: string): SanitizeResult {
    if (!this.enabled || !input) {
      return {
        output: input,
        redaction_count: 0,
        detected_types: [],
      };
    }

    let output = input;
    let redactionCount = 0;
    const detectedTypes: Set<string> = new Set();

    // Apply built-in patterns
    for (const secretPattern of SECRET_PATTERNS) {
      const result = this.applyPattern(output, secretPattern);
      if (result.count > 0) {
        output = result.output;
        redactionCount += result.count;
        detectedTypes.add(secretPattern.name);
      }
    }

    // Apply custom patterns
    for (let i = 0; i < this.customPatterns.length; i++) {
      const pattern = this.customPatterns[i];
      const matches = output.match(pattern);
      if (matches) {
        output = output.replace(pattern, this.redactionString);
        redactionCount += matches.length;
        detectedTypes.add(`custom_pattern_${i}`);
      }
    }

    return {
      output,
      redaction_count: redactionCount,
      detected_types: Array.from(detectedTypes),
    };
  }

  /**
   * Check if input contains any secrets (without modifying)
   */
  containsSecrets(input: string): boolean {
    if (!input) {
      return false;
    }

    for (const secretPattern of SECRET_PATTERNS) {
      // Reset lastIndex for global patterns
      secretPattern.pattern.lastIndex = 0;
      if (secretPattern.pattern.test(input)) {
        return true;
      }
    }

    for (const pattern of this.customPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(input)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get list of detected secret types in input
   */
  detectSecretTypes(input: string): string[] {
    if (!input) {
      return [];
    }

    const types: string[] = [];

    for (const secretPattern of SECRET_PATTERNS) {
      secretPattern.pattern.lastIndex = 0;
      if (secretPattern.pattern.test(input)) {
        types.push(secretPattern.name);
      }
    }

    return types;
  }

  /**
   * Apply a single pattern and redact matches
   */
  private applyPattern(
    input: string,
    secretPattern: SecretPattern
  ): { output: string; count: number } {
    const { pattern, redactGroup } = secretPattern;
    let count = 0;

    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    let output: string;

    if (redactGroup !== undefined) {
      // Redact only the specific capture group
      output = input.replace(pattern, (...args) => {
        count++;
        // args: match, group1, group2, ..., offset, string, groups
        const fullMatch = args[0];
        const groupValue = args[redactGroup];

        if (groupValue) {
          return fullMatch.replace(groupValue, this.redactionString);
        }
        return fullMatch;
      });
    } else {
      // Redact the entire match
      output = input.replace(pattern, () => {
        count++;
        return this.redactionString;
      });
    }

    return { output, count };
  }

  /**
   * Check if sanitization is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable sanitization
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Add a custom pattern
   */
  addCustomPattern(pattern: string): void {
    this.customPatterns.push(new RegExp(pattern, "gi"));
  }

  /**
   * Get the redaction string
   */
  getRedactionString(): string {
    return this.redactionString;
  }
}

// Singleton instance
let sanitizer: OutputSanitizer | null = null;

/**
 * Get or create the sanitizer instance
 */
export function getOutputSanitizer(config?: Partial<SanitizerConfig>): OutputSanitizer {
  if (!sanitizer) {
    sanitizer = new OutputSanitizer(config);
  }
  return sanitizer;
}

/**
 * Initialize the sanitizer with config
 */
export function initOutputSanitizer(config: Partial<SanitizerConfig>): OutputSanitizer {
  sanitizer = new OutputSanitizer(config);
  return sanitizer;
}

/**
 * Convenience function to sanitize output using singleton
 */
export function sanitizeOutput(input: string): SanitizeResult {
  return getOutputSanitizer().sanitize(input);
}

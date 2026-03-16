/**
 * Logger Utility
 *
 * Provides consistent logging throughout the agent system.
 *
 * Python vs TypeScript:
 * - Python: print() statements or logging module
 * - TypeScript: Structured logging with ANSI colors and log levels
 * - More type-safe and configurable than print()
 */

/**
 * Log level enumeration
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",

    // Foreground colors
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
} as const;

/**
 * Logger configuration
 */
export interface LoggerConfig {
    /** Minimum log level to output */
    minLevel?: LogLevel;
    /** Whether to use colors in output */
    useColors?: boolean;
    /** Whether to include timestamps */
    includeTimestamp?: boolean;
    /** Custom prefix for log messages */
    prefix?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<LoggerConfig> = {
    minLevel: LogLevel.INFO,
    useColors: true,
    includeTimestamp: false,
    prefix: "",
};

/**
 * Logger class
 *
 * Provides structured logging with levels and colors.
 *
 * Python equivalent:
 * ```python
 * import logging
 * logger = logging.getLogger(__name__)
 * logger.info("message")
 * ```
 */
export class Logger {
    private config: Required<LoggerConfig>;

    constructor(config: LoggerConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Format a log message with optional color and timestamp
     */
    private format(
        message: string,
        level: LogLevel,
        color: string
    ): string {
        const parts: string[] = [];

        // Add prefix if configured
        if (this.config.prefix) {
            parts.push(this.config.prefix);
        }

        // Add timestamp if configured
        if (this.config.includeTimestamp) {
            const timestamp = new Date().toISOString();
            parts.push(`[${timestamp}]`);
        }

        // Add the message with color
        if (this.config.useColors) {
            parts.push(`${color}${message}${COLORS.reset}`);
        } else {
            parts.push(message);
        }

        return parts.join(" ");
    }

    /**
     * Log a debug message
     */
    debug(message: string): void {
        if (this.config.minLevel <= LogLevel.DEBUG) {
            console.log(this.format(message, LogLevel.DEBUG, COLORS.dim));
        }
    }

    /**
     * Log an info message
     */
    info(message: string): void {
        if (this.config.minLevel <= LogLevel.INFO) {
            console.log(this.format(message, LogLevel.INFO, COLORS.cyan));
        }
    }

    /**
     * Log a warning message
     */
    warn(message: string): void {
        if (this.config.minLevel <= LogLevel.WARN) {
            console.warn(this.format(message, LogLevel.WARN, COLORS.yellow));
        }
    }

    /**
     * Log an error message
     */
    error(message: string): void {
        if (this.config.minLevel <= LogLevel.ERROR) {
            console.error(this.format(message, LogLevel.ERROR, COLORS.red));
        }
    }

    /**
     * Log a success message (green)
     */
    success(message: string): void {
        if (this.config.minLevel <= LogLevel.INFO) {
            console.log(this.format(message, LogLevel.INFO, COLORS.green));
        }
    }

    /**
     * Create a child logger with additional prefix
     */
    child(additionalPrefix: string): Logger {
        const newPrefix = this.config.prefix
            ? `${this.config.prefix} ${additionalPrefix}`
            : additionalPrefix;
        return new Logger({ ...this.config, prefix: newPrefix });
    }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

/**
 * Create a logger with a specific prefix
 *
 * @param prefix - Prefix for log messages
 * @returns New logger instance
 *
 * Python equivalent:
 * ```python
 * logger = logging.getLogger(f"myapp.{module_name}")
 * ```
 */
export function createLogger(prefix: string): Logger {
    return new Logger({ prefix });
}

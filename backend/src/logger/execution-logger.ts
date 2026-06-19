import { ConsoleLogger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export class ExecutionLogger extends ConsoleLogger {
  public static activeRunId: string | null = null;

  private getWorkspaceRoot(): string {
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, 'backend'))) {
      return cwd;
    }
    const parent = path.resolve(cwd, '..');
    if (fs.existsSync(path.join(parent, 'backend'))) {
      return parent;
    }
    return cwd;
  }

  private cleanAnsi(str: string): string {
    return str.replace(/\u001b\[\d+m/g, '');
  }

  private writeToFile(context: string, level: string, message: any, stackOrContext?: string) {
    if (process.env.DEBUG !== 'true') {
      return;
    }

    // Automatically parse runId from the message if present
    const msgStr = String(message);
    const runIdMatch = msgStr.match(/run_\d+/);
    if (runIdMatch) {
      ExecutionLogger.activeRunId = runIdMatch[0];
    }

    const timestamp = new Date().toLocaleString();
    const pid = process.pid;
    const cleanContext = (context || stackOrContext || 'Nest').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const runIdStr = ExecutionLogger.activeRunId ? ` [${ExecutionLogger.activeRunId}]` : '';

    // Format like standard terminal logs: [Nest] PID  - Timestamp  LEVEL [Context] Message
    let logLine = `[Nest] ${pid}  - ${timestamp}   ${level.toUpperCase()} [${cleanContext}]${runIdStr} ${message}`;
    if (level === 'error' && stackOrContext && stackOrContext !== cleanContext) {
      logLine += `\n${stackOrContext}`;
    }
    logLine += '\n';

    // Remove ANSI color codes for file storage
    const cleanLogLine = this.cleanAnsi(logLine);

    const workspaceRoot = this.getWorkspaceRoot();
    const outputDir = path.join(workspaceRoot, 'output');
    
    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const logFile = path.join(outputDir, `${cleanContext}.log`);
      fs.appendFileSync(logFile, cleanLogLine, 'utf8');

      // Also write all errors to errors.log
      if (level === 'error') {
        const errorsFile = path.join(outputDir, 'errors.log');
        fs.appendFileSync(errorsFile, cleanLogLine, 'utf8');
      }
    } catch (err) {
      // safe fallback
    }
  }

  log(message: any, context?: string) {
    super.log(message, context);
    this.writeToFile(context || this.context || 'Nest', 'log', message);
  }

  error(message: any, stack?: string, context?: string) {
    super.error(message, stack, context);
    this.writeToFile(context || this.context || 'Nest', 'error', message, stack);
  }

  warn(message: any, context?: string) {
    super.warn(message, context);
    this.writeToFile(context || this.context || 'Nest', 'warn', message);
  }

  debug(message: any, context?: string) {
    super.debug(message, context);
    this.writeToFile(context || this.context || 'Nest', 'debug', message);
  }

  verbose(message: any, context?: string) {
    super.verbose(message, context);
    this.writeToFile(context || this.context || 'Nest', 'verbose', message);
  }
}

// Singleton helper instance for backwards compatibility and direct runId updates
class ExecutionLoggerHelper {
  set activeRunId(val: string | null) {
    ExecutionLogger.activeRunId = val;
  }
  get activeRunId(): string | null {
    return ExecutionLogger.activeRunId;
  }

  info(executionId: string, message: string, data?: any) {
    ExecutionLogger.activeRunId = executionId;
    const msgStr = data !== undefined ? `${message} - ${JSON.stringify(data)}` : message;
    const loggerInstance = new ExecutionLogger();
    loggerInstance.log(msgStr, 'ExecutionLogger');
  }

  warn(executionId: string, message: string, data?: any) {
    ExecutionLogger.activeRunId = executionId;
    const msgStr = data !== undefined ? `${message} - ${JSON.stringify(data)}` : message;
    const loggerInstance = new ExecutionLogger();
    loggerInstance.warn(msgStr, 'ExecutionLogger');
  }

  error(executionId: string, message: string, data?: any) {
    ExecutionLogger.activeRunId = executionId;
    const msgStr = data !== undefined ? `${message} - ${JSON.stringify(data)}` : message;
    const loggerInstance = new ExecutionLogger();
    loggerInstance.error(msgStr, undefined, 'ExecutionLogger');
  }
}

export const logger = new ExecutionLoggerHelper();

if (typeof process !== 'undefined') {
  process.on('uncaughtException', (err) => {
    const runId = ExecutionLogger.activeRunId || 'unknown_run';
    logger.error(runId, `Unhandled Exception: ${err.message}`, { stack: err.stack });
  });
  process.on('unhandledRejection', (reason: any) => {
    const runId = ExecutionLogger.activeRunId || 'unknown_run';
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error(runId, `Unhandled Rejection: ${msg}`, { stack });
  });
}

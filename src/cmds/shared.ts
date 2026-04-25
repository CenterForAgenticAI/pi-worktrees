import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import * as pi from '@mariozechner/pi-coding-agent';
import { SessionManager } from '@mariozechner/pi-coding-agent';

// Feature-detect cross-cwd session replacement support.
// `createAgentSessionRuntime` was introduced in pi 0.65.0 alongside the
// `AgentSessionRuntime` runtime that rebuilds every cwd-bound service
// (bash/read/write/edit/grep tools, footer, session dir) when the target
// session has a different cwd. On pi 0.51.1–0.64.x `ctx.switchSession`
// exists but the rebuild is not guaranteed, which would leave us with a
// half-switched session (history moved, tools still in the old cwd).
const SUPPORTS_CROSS_CWD_SWITCH =
  typeof (pi as { createAgentSessionRuntime?: unknown }).createAgentSessionRuntime === 'function';

// `ReplacedSessionContext` is exported from
// `@mariozechner/pi-coding-agent/dist/core/extensions/index.js` but not from
// the package's top-level entrypoint (only `.` and `./hooks` are in the
// package `exports` map, as of pi 0.69.0). We recover the type by reflecting
// on the `switchSession` method's `withSession` callback parameter so we
// don't have to maintain a parallel structural copy.
type SwitchSessionOptions = NonNullable<Parameters<ExtensionCommandContext['switchSession']>[1]>;
type WithSessionCallback = NonNullable<SwitchSessionOptions['withSession']>;
export type ReplacedSessionContext = Parameters<WithSessionCallback>[0];
import { expandTemplate } from '../services/templates.ts';
import type { WorktreeCreatedContext } from '../types.ts';
import { WorktreeSettingsConfig } from '../services/config/schema.ts';

interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface OnCreateResult {
  success: boolean;
  executed: string[];
  failed?: {
    command: string;
    code: number;
    error: string;
  };
}

type CommandState = 'pending' | 'running' | 'success' | 'failed';

export interface OnCreateHookOptions {
  logPath?: string;
  displayOutputMaxLines?: number;
  cmdDisplayPending?: string;
  cmdDisplaySuccess?: string;
  cmdDisplayError?: string;
  cmdDisplayPendingColor?: string;
  cmdDisplaySuccessColor?: string;
  cmdDisplayErrorColor?: string;
}
export function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export type InPlaceSwitchUnsupportedReason =
  | 'no-switch-api'
  | 'no-session-file'
  | 'fork-failed'
  | 'switch-cancelled'
  | 'switch-failed';

/**
 * Outcome of `attemptInPlaceSwitch`.
 *
 * - `switched`: pi has torn down the old runtime and rebuilt at the worktree
 *   path. The OUTER `ctx` the caller passed in is now stale; only the
 *   `ReplacedSessionContext` handed to `withSession` is safe to use. If
 *   `postSwitchError` is set, pi rebuilt the runtime but a downstream step
 *   (rebindSession or the user-supplied withSession callback) threw.
 * - `already-here`: the caller's `ctx.cwd` already resolves to `target.path`,
 *   no switch attempted.
 * - `unsupported`: nothing was committed to disk that the helper hasn't
 *   already cleaned up; the outer `ctx` is still safe to use for fallback
 *   messaging or running an alternate hook.
 */
export type InPlaceSwitchResult =
  | { status: 'switched'; forkedSessionFile: string; postSwitchError?: Error }
  | { status: 'already-here' }
  | {
      status: 'unsupported';
      reason: InPlaceSwitchUnsupportedReason;
      error?: Error;
    };

/** Human-friendly explanation for an `unsupported` reason. */
export function describeUnsupportedSwitch(reason: InPlaceSwitchUnsupportedReason): string {
  switch (reason) {
    case 'no-switch-api':
      return "pi is too old to switch sessions in place (this extension's peerDep requires pi >= 0.65.0)";
    case 'no-session-file':
      return 'the current session has no persistent file (started with --no-session?)';
    case 'fork-failed':
      return 'forking the session file into the worktree failed';
    case 'switch-cancelled':
      return 'another extension cancelled the session switch';
    case 'switch-failed':
      return 'pi returned an error before the new session was activated';
  }
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function tryCleanupSessionFile(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // best-effort cleanup; the orphan is harmless beyond bucket noise
  }
}

/**
 * Fork the current session into the target cwd's bucket and ask pi to switch
 * into it. On pi >= 0.65.0 this rebuilds every cwd-bound service (bash/read/
 * write/edit/grep tools, footer, session dir) to point at `target.path`; on
 * older pi the switch may succeed but tools will keep their old cwd, which
 * the caller should surface to the user.
 *
 * The helper is intentionally conservative: it never mutates the source
 * session file and returns a structured outcome instead of throwing so the
 * caller can fall back to hook-only messaging when the switch isn't viable.
 */
export async function attemptInPlaceSwitch(
  ctx: ExtensionCommandContext,
  target: { path: string },
  options?: {
    /**
     * Invoked post-switch with a `ReplacedSessionContext` bound to the new
     * session. Use this (not the outer `ctx`) for any work that should see
     * the new cwd — e.g. running an onSwitch hook in "both" mode.
     */
    withSession?: WithSessionCallback;
  }
): Promise<InPlaceSwitchResult> {
  const targetPath = resolvePath(target.path);
  const cwdPath = resolvePath(ctx.cwd);

  // Path-equality check, with a realpath fallback so symlinked worktree
  // paths still detect "already here". `realpath` is best-effort — missing
  // paths or permission errors silently fall back to lexical comparison.
  if (cwdPath === targetPath || tryRealpath(cwdPath) === tryRealpath(targetPath)) {
    return { status: 'already-here' };
  }

  if (typeof ctx.switchSession !== 'function' || !SUPPORTS_CROSS_CWD_SWITCH) {
    return { status: 'unsupported', reason: 'no-switch-api' };
  }

  const sourceSessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sourceSessionFile) {
    return { status: 'unsupported', reason: 'no-session-file' };
  }

  let forkedSessionFile: string;
  try {
    const forked = SessionManager.forkFrom(sourceSessionFile, targetPath);
    const filePath = forked.getSessionFile();
    if (!filePath) {
      return {
        status: 'unsupported',
        reason: 'fork-failed',
        error: new Error('forkFrom() returned a SessionManager with no session file'),
      };
    }
    forkedSessionFile = filePath;
  } catch (err) {
    return {
      status: 'unsupported',
      reason: 'fork-failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // `withSessionRan` distinguishes "switch failed before pi rebuilt the
  // runtime" from "runtime was rebuilt and a downstream step threw". If we
  // got into withSession at all, pi has already replaced the live session
  // and the OUTER ctx must not be used for recovery.
  let withSessionRan = false;
  let userCallbackError: Error | undefined;

  try {
    const result = await ctx.switchSession(forkedSessionFile, {
      withSession: async (newCtx) => {
        withSessionRan = true;
        if (!options?.withSession) {
          return;
        }
        try {
          await options.withSession(newCtx);
        } catch (err) {
          // The switch is committed; if the caller's callback throws we
          // record it but do not let it propagate — otherwise the outer
          // `ctx.switchSession` rejects and the helper would misclassify
          // a successful switch as `switch-failed`.
          userCallbackError = err instanceof Error ? err : new Error(String(err));
        }
      },
    });

    if (result.cancelled) {
      // emitBeforeSwitch cancelled BEFORE teardown. Forked file is now an
      // orphan in the target cwd's session bucket.
      tryCleanupSessionFile(forkedSessionFile);
      return { status: 'unsupported', reason: 'switch-cancelled' };
    }

    return userCallbackError
      ? { status: 'switched', forkedSessionFile, postSwitchError: userCallbackError }
      : { status: 'switched', forkedSessionFile };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (withSessionRan) {
      // Switch was committed before this error fired (rebindSession or
      // similar). Do NOT clean up the forked file — it is the active
      // session now — and report `switched` so callers don't try to
      // recover with a stale ctx.
      return { status: 'switched', forkedSessionFile, postSwitchError: error };
    }
    // Pre-replacement failure. Clean up the orphan and let the caller fall
    // back to hook-only with the original ctx.
    tryCleanupSessionFile(forkedSessionFile);
    return { status: 'unsupported', reason: 'switch-failed', error };
  }
}

export function resolveLogfilePath(
  template: string,
  values: Record<'sessionId' | 'name' | 'timestamp', string>
): string {
  return template
    .replace(/\{\{sessionId\}\}|\{sessionId\}/g, values.sessionId)
    .replace(/\{\{name\}\}|\{name\}/g, values.name)
    .replace(/\{\{timestamp\}\}|\{timestamp\}/g, values.timestamp);
}

const ANSI = {
  reset: '\u001b[0m',
  gray: '\u001b[90m',
  blue: '\u001b[34m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
};

interface CommandDisplayConfig {
  pendingTemplate: string;
  successTemplate: string;
  errorTemplate: string;
  pendingColor: string;
  successColor: string;
  errorColor: string;
}

function applyCommandTemplate(template: string, command: string): string {
  return template.replace(/\{\{cmd\}\}|\{cmd\}/g, command);
}

function resolveAnsiColor(colorName: string): string {
  if (colorName === 'dim') {
    return ANSI.gray;
  }

  if (colorName === 'accent' || colorName === 'info') {
    return ANSI.blue;
  }

  if (colorName === 'success') {
    return ANSI.green;
  }

  if (colorName === 'error') {
    return ANSI.red;
  }

  if (colorName === 'warning') {
    return ANSI.yellow;
  }

  return '';
}

function colorize(text: string, colorName: string): string {
  const ansi = resolveAnsiColor(colorName);
  if (!ansi) {
    return text;
  }

  return `${ansi}${text}${ANSI.reset}`;
}

function formatCommandLine(
  command: string,
  state: CommandState,
  config: CommandDisplayConfig
): string {
  if (state === 'success') {
    return colorize(applyCommandTemplate(config.successTemplate, command), config.successColor);
  }

  if (state === 'failed') {
    return colorize(applyCommandTemplate(config.errorTemplate, command), config.errorColor);
  }

  return colorize(applyCommandTemplate(config.pendingTemplate, command), config.pendingColor);
}

function toLines(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function formatOutputLine(stream: 'stdout' | 'stderr', line: string, state: CommandState): string {
  const prefix = stream === 'stderr' ? '⚠' : '›';

  if (state === 'running') {
    return `   ${prefix} ${line}`;
  }

  return `${ANSI.gray}   ${prefix} ${line}${ANSI.reset}`;
}

function getDisplayLines(text: string, maxLines: number): string[] {
  const lines = toLines(text);
  if (maxLines < 0) {
    // Negative values mean "no limit" – return all lines.
    return lines;
  }

  if (maxLines === 0) {
    // Explicitly requested no output.
    return [];
  }
  return lines.slice(-maxLines);
}

function formatCommandList(
  commands: string[],
  states: CommandState[],
  outputs: CommandOutput[],
  commandDisplay: CommandDisplayConfig,
  hookName: string,
  logPath?: string,
  displayOutputMaxLines = 5
): string {
  const lines: string[] = [`${hookName} steps:`];
  for (const [index, command] of commands.entries()) {
    const state = states[index];
    lines.push(formatCommandLine(command, state, commandDisplay));
    for (const line of getDisplayLines(outputs[index].stdout, displayOutputMaxLines)) {
      lines.push(formatOutputLine('stdout', line, state));
    }
    for (const line of getDisplayLines(outputs[index].stderr, displayOutputMaxLines)) {
      lines.push(formatOutputLine('stderr', line, state));
    }
  }
  if (logPath) {
    lines.push('');
    lines.push(`${ANSI.gray}log: ${logPath}${ANSI.reset}`);
  }
  return lines.join('\n');
}

function appendCommandLog(logPath: string, command: string, result: CommandResult): void {
  const lines: string[] = [`$ ${command}`];

  if (result.stdout) {
    lines.push('[stdout]');
    lines.push(result.stdout.trimEnd());
  }

  if (result.stderr) {
    lines.push('[stderr]');
    lines.push(result.stderr.trimEnd());
  }

  lines.push(`[exit ${result.code}]`);
  lines.push('');

  appendFileSync(logPath, `${lines.join('\n')}\n`);
}

function runCommand(
  command: string,
  cwd: string,
  // eslint-disable-next-line no-unused-vars
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.('stdout', chunk);
    });

    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      onOutput?.('stderr', chunk);
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        code: 1,
        stdout: '',
        stderr: error.message,
      });
    });
  });
}

/**
 * Runs hook commands sequentially.
 * Stops at first failure and reports the failing command.
 */
export async function runHook(
  createdCtx: WorktreeCreatedContext,
  hookValue: WorktreeSettingsConfig['onCreate'] | undefined,
  hookName: 'onCreate' | 'onSwitch' | 'onBeforeRemove',
  // eslint-disable-next-line no-unused-vars
  notify: (msg: string, type: 'info' | 'error' | 'warning') => void,
  options?: OnCreateHookOptions
): Promise<OnCreateResult> {
  if (!hookValue) {
    return { success: true, executed: [] };
  }

  const commandTemplates = Array.isArray(hookValue) ? hookValue : [hookValue];
  const commands = commandTemplates.map((template) => expandTemplate(template, createdCtx));
  const executed: string[] = [];
  const commandStates: CommandState[] = commands.map(() => 'pending');
  const commandOutputs: CommandOutput[] = commands.map(() => ({ stdout: '', stderr: '' }));
  if (options?.logPath) {
    writeFileSync(
      options.logPath,
      [
        `# pi-worktree ${hookName} log`,
        `# worktree: ${createdCtx.path}`,
        `# branch: ${createdCtx.branch}`,
        '',
      ].join('\n')
    );
  }
  const displayOutputMaxLines = options?.displayOutputMaxLines ?? 5;
  const commandDisplay: CommandDisplayConfig = {
    pendingTemplate: options?.cmdDisplayPending ?? '[ ] {{cmd}}',
    successTemplate: options?.cmdDisplaySuccess ?? '[x] {{cmd}}',
    errorTemplate: options?.cmdDisplayError ?? '[ ] {{cmd}} [ERROR]',
    pendingColor: options?.cmdDisplayPendingColor ?? 'dim',
    successColor: options?.cmdDisplaySuccessColor ?? 'success',
    errorColor: options?.cmdDisplayErrorColor ?? 'error',
  };

  notify(
    formatCommandList(
      commands,
      commandStates,
      commandOutputs,
      commandDisplay,
      hookName,
      undefined,
      displayOutputMaxLines
    ),
    'info'
  );
  for (const [index, command] of commands.entries()) {
    commandStates[index] = 'running';
    notify(
      formatCommandList(
        commands,
        commandStates,
        commandOutputs,
        commandDisplay,
        hookName,
        undefined,
        displayOutputMaxLines
      ),
      'info'
    );
    const result = await runCommand(command, createdCtx.path, (stream, chunk) => {
      commandOutputs[index][stream] += chunk;
      notify(
        formatCommandList(
          commands,
          commandStates,
          commandOutputs,
          commandDisplay,
          hookName,
          undefined,
          displayOutputMaxLines
        ),
        'info'
      );
    });

    if (options?.logPath) {
      appendCommandLog(options.logPath, command, result);
    }

    executed.push(command);
    if (!result.success) {
      commandStates[index] = 'failed';
      notify(
        formatCommandList(
          commands,
          commandStates,
          commandOutputs,
          commandDisplay,
          hookName,
          options?.logPath,
          displayOutputMaxLines
        ),
        'error'
      );
      notify(
        `${hookName} failed (exit ${result.code}): ${result.stderr.slice(0, 200)}${
          options?.logPath ? `\nlog: ${options.logPath}` : ''
        }`,
        'error'
      );
      return {
        success: false,
        executed,
        failed: {
          command,
          code: result.code,
          error: result.stderr,
        },
      };
    }
    commandStates[index] = 'success';
    notify(
      formatCommandList(
        commands,
        commandStates,
        commandOutputs,
        commandDisplay,
        hookName,
        undefined,
        displayOutputMaxLines
      ),
      'info'
    );
  }

  notify(
    formatCommandList(
      commands,
      commandStates,
      commandOutputs,
      commandDisplay,
      hookName,
      options?.logPath,
      displayOutputMaxLines
    ),
    'info'
  );
  return { success: true, executed };
}
export async function runOnCreateHook(
  createdCtx: WorktreeCreatedContext,
  settings: WorktreeSettingsConfig,
  // eslint-disable-next-line no-unused-vars
  notify: (msg: string, type: 'info' | 'error' | 'warning') => void,
  options?: OnCreateHookOptions
): Promise<OnCreateResult> {
  return runHook(createdCtx, settings.onCreate, 'onCreate', notify, options);
}

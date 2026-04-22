import { basename } from 'path';
import { DefaultLogfileTemplate } from '../services/config/config.ts';
import { isGitRepo, listWorktrees, type WorktreeInfo } from '../services/git.ts';
import type { CmdHandler, WorktreeCreatedContext } from '../types.ts';
import type { OnCreateHookOptions, ReplacedSessionContext } from './shared.ts';
import { attemptInPlaceSwitch, resolveLogfilePath, runHook, sanitizePathPart } from './shared.ts';

function formatWorktreeOption(worktree: WorktreeInfo): string {
  const markers = [worktree.isMain ? '[main]' : '', worktree.isCurrent ? '[current]' : '']
    .filter(Boolean)
    .join(' ');

  return `${worktree.branch}${markers ? ' ' + markers : ''}\n  ${worktree.path}`;
}

function describeUnsupported(reason: string): string {
  switch (reason) {
    case 'no-switch-api':
      return 'pi is too old to switch sessions in place (requires pi >= 0.51.1, and >= 0.65.0 for correct cross-cwd tool rebinding)';
    case 'no-session-file':
      return 'the current session has no persistent file (started with --no-session?)';
    case 'fork-failed':
      return 'forking the session file into the worktree failed';
    case 'switch-cancelled':
      return 'another extension cancelled the session switch';
    case 'switch-failed':
      return 'pi returned an error while switching the session';
    default:
      return reason;
  }
}

function buildHookOptions(
  current: {
    logfile?: string;
    onCreateDisplayOutputMaxLines?: number;
    onCreateCmdDisplayPending?: string;
    onCreateCmdDisplaySuccess?: string;
    onCreateCmdDisplayError?: string;
    onCreateCmdDisplayPendingColor?: string;
    onCreateCmdDisplaySuccessColor?: string;
    onCreateCmdDisplayErrorColor?: string;
  },
  target: { path: string; branch: string },
  sessionId: string
): OnCreateHookOptions {
  const safeName = sanitizePathPart(basename(target.path));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolveLogfilePath(current.logfile ?? DefaultLogfileTemplate, {
    sessionId,
    name: safeName,
    timestamp,
  });

  return {
    logPath,
    displayOutputMaxLines: current.onCreateDisplayOutputMaxLines,
    cmdDisplayPending: current.onCreateCmdDisplayPending,
    cmdDisplaySuccess: current.onCreateCmdDisplaySuccess,
    cmdDisplayError: current.onCreateCmdDisplayError,
    cmdDisplayPendingColor: current.onCreateCmdDisplayPendingColor,
    cmdDisplaySuccessColor: current.onCreateCmdDisplaySuccessColor,
    cmdDisplayErrorColor: current.onCreateCmdDisplayErrorColor,
  };
}

export const cmdList: CmdHandler = async (_args, ctx, deps) => {
  if (!isGitRepo(ctx.cwd)) {
    ctx.ui.notify('Not in a git repository', 'error');
    return;
  }

  const worktrees = listWorktrees(ctx.cwd);

  if (worktrees.length === 0) {
    ctx.ui.notify('No worktrees found', 'info');
    return;
  }

  if (!ctx.hasUI) {
    const lines = worktrees.map((worktree) => {
      const markers = [worktree.isMain ? '[main]' : '', worktree.isCurrent ? '[current]' : '']
        .filter(Boolean)
        .join(' ');

      return `${worktree.branch}${markers ? ' ' + markers : ''}\n    ${worktree.path}`;
    });

    const configured = Array.from(deps.configService.worktrees.entries()).map(
      ([pattern, settings]) => {
        return `${pattern}\n    ${settings.worktreeRoot ?? settings.parentDir}\n    ${settings.onCreate}`;
      }
    );

    ctx.ui.notify(
      `Worktrees:\n\n${lines.join('\n\n')} \n\nConfigured:\n\n${configured.join('\n\n')}`,
      'info'
    );
    return;
  }

  const options = worktrees.map(formatWorktreeOption);
  const byOption = new Map(options.map((option, index) => [option, worktrees[index]]));
  const selected = await ctx.ui.select('Select a worktree', options);

  if (selected === undefined) {
    ctx.ui.notify('Cancelled', 'info');
    return;
  }

  const target = byOption.get(selected);
  if (!target) {
    ctx.ui.notify('Invalid selection', 'error');
    return;
  }

  const current = deps.configService.current({ cwd: target.path });
  const sessionId = sanitizePathPart(ctx.sessionManager?.getSessionId?.() || 'session');
  const hookOptions = buildHookOptions(current, target, sessionId);
  const createdCtx: WorktreeCreatedContext = {
    path: target.path,
    name: basename(target.path),
    branch: target.branch,
    project: current.project,
    mainWorktree: current.mainWorktree,
  };

  const wantsSwitch = current.switchBehavior === 'in-place' || current.switchBehavior === 'both';
  const wantsHook = current.switchBehavior === 'hook-only' || current.switchBehavior === 'both';

  // Runs the onSwitch hook with whichever notify/status handles are currently
  // live. In "in-place" or "both" modes this is invoked from inside the
  // `withSession` callback, so the new (post-switch) ctx is what's used.
  const runOnSwitchHook = async (
    // eslint-disable-next-line no-unused-vars
    notify: (message: string, level?: 'info' | 'error' | 'warning') => void
  ): Promise<boolean> => {
    if (!current.onSwitch) {
      return true;
    }
    const result = await runHook(createdCtx, current.onSwitch, 'onSwitch', notify, hookOptions);
    if (!result.success) {
      notify('onSwitch failed', 'error');
      return false;
    }
    return true;
  };

  if (wantsSwitch) {
    ctx.ui.notify(`Switching session to ${target.branch} (${target.path})...`, 'info');

    const switchResult = await attemptInPlaceSwitch(ctx, target, {
      withSession: async (newCtx: ReplacedSessionContext) => {
        newCtx.ui.notify(
          `✓ Switched. This pi session is now working in ${target.path}. Session history was preserved.`,
          'info'
        );
        if (wantsHook) {
          await runOnSwitchHook(newCtx.ui.notify.bind(newCtx.ui));
        }
      },
    });

    if (switchResult.status === 'switched') {
      // All post-switch messaging happened inside withSession with the fresh
      // ReplacedSessionContext. Do not touch the outer `ctx` here; it is
      // considered stale after `switchSession` returns.
      return;
    }

    if (switchResult.status === 'already-here') {
      ctx.ui.notify(`Already working in ${target.path}.`, 'info');
      if (wantsHook) {
        const stopBusy = deps.statusService.busy(ctx, `Running onSwitch for ${target.branch}...`);
        const ok = await runOnSwitchHook(ctx.ui.notify.bind(ctx.ui));
        stopBusy();
        if (ok) {
          deps.statusService.positive(ctx, `onSwitch complete: ${target.branch}`);
        } else {
          deps.statusService.critical(ctx, 'onSwitch failed');
        }
      }
      return;
    }

    // switchResult.status === 'unsupported' — fall through to hook-only with
    // a warning that explains why. `ctx` is still live because no session
    // replacement took effect.
    const reason = switchResult.reason;
    ctx.ui.notify(
      `Couldn't switch the session in place: ${describeUnsupported(reason)}. Falling back to onSwitch.`,
      'warning'
    );
    if (switchResult.error) {
      ctx.ui.notify(switchResult.error.message, 'error');
    }
  }

  // Hook-only path: either the user asked for it, or in-place mode fell back.
  if (!current.onSwitch) {
    ctx.ui.notify(
      [
        `Worktree path: ${target.path}`,
        `Branch:        ${target.branch}`,
        '',
        'No onSwitch hook is configured and in-place switching is not',
        'available in this context. To work in this worktree, either:',
        `  • exit and run: cd ${target.path} && pi`,
        '  • configure an onSwitch hook that spawns pi there in a new',
        '    terminal/tab, e.g.:',
        "      /worktree settings onSwitch 'zellij action new-tab --cwd {{path}} -- pi'",
        `      (or: tmux new-window -c {{path}} pi)`,
        '  • (on pi >= 0.65.0) set switchBehavior = "in-place" to move this',
        '    session into the worktree directly:',
        '      /worktree settings switchBehavior in-place',
      ].join('\n'),
      'info'
    );
    return;
  }

  const stopBusy = deps.statusService.busy(ctx, `Running onSwitch for ${target.branch}...`);
  try {
    const ok = await runOnSwitchHook(ctx.ui.notify.bind(ctx.ui));
    stopBusy();
    if (!ok) {
      deps.statusService.critical(ctx, 'onSwitch failed');
      return;
    }
    deps.statusService.positive(ctx, `onSwitch complete: ${target.branch}`);
    ctx.ui.notify(
      `onSwitch finished. Note: this pi session has not been moved to ${target.path} — in hook-only mode, onSwitch is expected to have opened pi there in a separate tab/window/pane. To move this session in place instead, set switchBehavior = "in-place".`,
      'info'
    );
  } catch (err) {
    stopBusy();
    deps.statusService.critical(ctx, 'onSwitch failed');
    ctx.ui.notify(`onSwitch failed: ${(err as Error).message}`, 'error');
  }
};

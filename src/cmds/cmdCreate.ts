import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { basename, join } from 'path';
import { ensureExcluded, git, isGitRepo, listWorktrees } from '../services/git.ts';
import type { OnCreateHookOptions, ReplacedSessionContext } from './shared.ts';
import {
  attemptInPlaceSwitch,
  describeUnsupportedSwitch,
  resolveLogfilePath,
  runHook,
  runOnCreateHook,
  sanitizePathPart,
} from './shared.ts';
import type { CommandDeps, WorktreeCreatedContext } from '../types.ts';
import { DefaultLogfileTemplate } from '../services/config/config.ts';
import { parseCreateCommandArgs } from './createArgs.ts';
import { generateBranchName } from '../services/branchNameGenerator.ts';

// TODO: this needs to be rethought so that we use configService.current(ctx.cwd)
export async function cmdCreate(
  args: string,
  ctx: ExtensionCommandContext,
  deps: CommandDeps
): Promise<void> {
  const parsed = parseCreateCommandArgs(args);
  if ('error' in parsed) {
    ctx.ui.notify(parsed.error, 'error');
    return;
  }

  const worktreeName = parsed.worktreeName;
  if (!isGitRepo(ctx.cwd)) {
    ctx.ui.notify('Not in a git repository', 'error');
    return;
  }

  const current = deps.configService.current(ctx);

  let branchName = parsed.generate ? '' : parsed.branch;
  if (parsed.generate) {
    const generated = await generateBranchName({
      commandTemplate: current.branchNameGenerator,
      input: parsed.generatorInput,
      cwd: ctx.cwd,
    });

    if (!generated.ok) {
      ctx.ui.notify(generated.message, 'error');
      return;
    }

    branchName = generated.branchName;
    ctx.ui.notify(
      `Using generated branch '${branchName}' from branchNameGenerator (input: '${parsed.generatorInput}').`,
      'info'
    );
  }

  if (!parsed.generate && parsed.showLegacyWarning) {
    ctx.ui.notify(
      `Legacy create style detected: '/worktree create <feature-name>' is deprecated. '${branchName}' is now treated as the branch name. If you want old semantics, run '/worktree create feature/${branchName}' (optionally '--name ${branchName}').`,
      'warning'
    );
  }

  const worktreePath = join(current.parentDir, worktreeName);

  const existingWorktree = listWorktrees(ctx.cwd).find(
    (worktree) =>
      worktree.path === worktreePath ||
      basename(worktree.path) === worktreeName ||
      worktree.branch === branchName
  );
  if (existingWorktree) {
    await handleExistingWorktree(ctx, deps, current, existingWorktree);
    return;
  }

  try {
    git(['rev-parse', '--verify', branchName], ctx.cwd);
    ctx.ui.notify(`Branch '${branchName}' already exists. Use a different name.`, 'error');
    return;
  } catch {
    // branch doesn't exist
  }

  ensureExcluded(ctx.cwd, current.parentDir);
  const stopBusy = deps.statusService.busy(ctx, `Creating worktree: ${worktreeName}...`);
  try {
    git(['worktree', 'add', '-b', branchName, worktreePath], current.mainWorktree);
    stopBusy();
    deps.statusService.positive(ctx, `Created: ${worktreeName}`);
  } catch (err) {
    stopBusy();
    deps.statusService.critical(ctx, `Failed to create worktree`);
    ctx.ui.notify(`Failed to create worktree: ${(err as Error).message}`, 'error');
    return;
  }

  const createdCtx: WorktreeCreatedContext = {
    path: worktreePath,
    name: worktreeName,
    branch: branchName,
    ...current,
  };

  const sessionId = sanitizePathPart(ctx.sessionManager?.getSessionId?.() || 'session');
  const safeName = sanitizePathPart(worktreeName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolveLogfilePath(current.logfile ?? DefaultLogfileTemplate, {
    sessionId,
    name: safeName,
    timestamp,
  });

  const hookOptions: OnCreateHookOptions = {
    logPath,
    displayOutputMaxLines: current.onCreateDisplayOutputMaxLines,
    cmdDisplayPending: current.onCreateCmdDisplayPending,
    cmdDisplaySuccess: current.onCreateCmdDisplaySuccess,
    cmdDisplayError: current.onCreateCmdDisplayError,
    cmdDisplayPendingColor: current.onCreateCmdDisplayPendingColor,
    cmdDisplaySuccessColor: current.onCreateCmdDisplaySuccessColor,
    cmdDisplayErrorColor: current.onCreateCmdDisplayErrorColor,
  };

  await runOnCreateHook(createdCtx, current, ctx.ui.notify.bind(ctx.ui), hookOptions);

  // After creation + onCreate, optionally move this pi session into the new
  // worktree. switchBehavior controls the post-create action:
  //   in-place / both: switch the running session into the worktree
  //   hook-only:       leave the session in main (legacy behavior)
  // For 'both' we run onSwitch inside the replaced session as a
  // "every-time-you-enter" hook, layered on top of onCreate's
  // "first-time-only" semantics.
  if (current.switchBehavior === 'hook-only') {
    return;
  }

  await switchIntoNewWorktree(ctx, current, createdCtx, hookOptions);
}

async function switchIntoNewWorktree(
  ctx: ExtensionCommandContext,
  current: ReturnType<CommandDeps['configService']['current']>,
  createdCtx: WorktreeCreatedContext,
  hookOptions: OnCreateHookOptions
): Promise<void> {
  const wantsHookAfterSwitch = current.switchBehavior === 'both';

  ctx.ui.notify(`Switching session into ${createdCtx.branch} (${createdCtx.path})...`, 'info');

  const switchResult = await attemptInPlaceSwitch(
    ctx,
    { path: createdCtx.path },
    {
      withSession: async (newCtx) => {
        newCtx.ui.notify(
          `✓ Switched. This pi session is now working in ${createdCtx.path}. Session history was preserved.`,
          'info'
        );
        if (wantsHookAfterSwitch && current.onSwitch) {
          const result = await runHook(
            createdCtx,
            current.onSwitch,
            'onSwitch',
            newCtx.ui.notify.bind(newCtx.ui),
            hookOptions
          );
          if (!result.success) {
            newCtx.ui.notify('onSwitch failed', 'error');
          }
        }
      },
    }
  );

  if (switchResult.status === 'switched') {
    return;
  }

  if (switchResult.status === 'already-here') {
    // Unusual: user ran /worktree create from inside the path that ended up
    // matching. Surface it without dressing it up.
    ctx.ui.notify(
      `This pi session is already rooted at ${createdCtx.path}. No switch needed.`,
      'info'
    );
    return;
  }

  // unsupported — do not run a fallback hook here. onCreate already ran;
  // there's nothing meaningful left to do besides telling the user.
  ctx.ui.notify(
    `Couldn't switch into the new worktree: ${describeUnsupportedSwitch(switchResult.reason)}.`,
    'warning'
  );
  if (switchResult.error) {
    ctx.ui.notify(switchResult.error.message, 'error');
  }
  ctx.ui.notify(
    `Worktree created at ${createdCtx.path}. To work in it, either exit and run \`cd ${createdCtx.path} && pi\`, or run /worktree list to switch later.`,
    'info'
  );
}

async function handleExistingWorktree(
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
  current: ReturnType<CommandDeps['configService']['current']>,
  existingWorktree: { path: string; branch: string }
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`Worktree already exists at: ${existingWorktree.path}`, 'error');
    return;
  }

  const wantsSwitch = current.switchBehavior === 'in-place' || current.switchBehavior === 'both';
  const wantsHook = current.switchBehavior === 'hook-only' || current.switchBehavior === 'both';

  const confirmMessage = wantsSwitch
    ? `Path: ${existingWorktree.path}\nBranch: ${existingWorktree.branch}\n\nSwitch this pi session into the worktree?${
        wantsHook && current.onSwitch ? ' (onSwitch will run after the switch.)' : ''
      }`
    : current.onSwitch
      ? `Path: ${existingWorktree.path}\nBranch: ${existingWorktree.branch}\n\nRun onSwitch for this worktree?`
      : `Path: ${existingWorktree.path}\nBranch: ${existingWorktree.branch}\n\nShow this worktree's path?`;

  const shouldProceed = await ctx.ui.confirm('Worktree already exists', confirmMessage);

  if (!shouldProceed) {
    ctx.ui.notify('Cancelled', 'info');
    return;
  }

  const existingCtx: WorktreeCreatedContext = {
    path: existingWorktree.path,
    name: basename(existingWorktree.path),
    branch: existingWorktree.branch,
    project: current.project,
    mainWorktree: current.mainWorktree,
  };

  const sessionId = sanitizePathPart(ctx.sessionManager?.getSessionId?.() || 'session');
  const safeName = sanitizePathPart(existingCtx.name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolveLogfilePath(current.logfile ?? DefaultLogfileTemplate, {
    sessionId,
    name: safeName,
    timestamp,
  });

  const hookOptions: OnCreateHookOptions = {
    logPath,
    displayOutputMaxLines: current.onCreateDisplayOutputMaxLines,
    cmdDisplayPending: current.onCreateCmdDisplayPending,
    cmdDisplaySuccess: current.onCreateCmdDisplaySuccess,
    cmdDisplayError: current.onCreateCmdDisplayError,
    cmdDisplayPendingColor: current.onCreateCmdDisplayPendingColor,
    cmdDisplaySuccessColor: current.onCreateCmdDisplaySuccessColor,
    cmdDisplayErrorColor: current.onCreateCmdDisplayErrorColor,
  };

  const runOnSwitchHook = async (
    // eslint-disable-next-line no-unused-vars
    notify: (msg: string, type: 'info' | 'error' | 'warning') => void
  ): Promise<boolean> => {
    if (!current.onSwitch) {
      return true;
    }
    const result = await runHook(existingCtx, current.onSwitch, 'onSwitch', notify, hookOptions);
    if (!result.success) {
      notify('onSwitch failed', 'error');
      return false;
    }
    return true;
  };

  if (wantsSwitch) {
    ctx.ui.notify(
      `Switching session to ${existingWorktree.branch} (${existingWorktree.path})...`,
      'info'
    );

    const switchResult = await attemptInPlaceSwitch(ctx, existingWorktree, {
      withSession: async (newCtx: ReplacedSessionContext) => {
        newCtx.ui.notify(
          `✓ Switched. This pi session is now working in ${existingWorktree.path}. Session history was preserved.`,
          'info'
        );
        if (wantsHook) {
          await runOnSwitchHook(newCtx.ui.notify.bind(newCtx.ui));
        }
      },
    });

    if (switchResult.status === 'switched') {
      return;
    }

    if (switchResult.status === 'already-here') {
      ctx.ui.notify(
        `This pi session is already rooted at ${existingWorktree.path}. No switch needed.`,
        'info'
      );
      if (wantsHook) {
        await runOnSwitchHook(ctx.ui.notify.bind(ctx.ui));
      }
      return;
    }

    ctx.ui.notify(
      `Couldn't switch the session in place: ${describeUnsupportedSwitch(switchResult.reason)}. Falling back to onSwitch.`,
      'warning'
    );
    if (switchResult.error) {
      ctx.ui.notify(switchResult.error.message, 'error');
    }
  }

  if (!current.onSwitch) {
    ctx.ui.notify(
      [
        `Worktree path: ${existingWorktree.path}`,
        `Branch:        ${existingWorktree.branch}`,
        '',
        'No onSwitch hook is configured and in-place switching is not',
        'available in this context. To work in this worktree, either:',
        `  • exit and run: cd ${existingWorktree.path} && pi`,
        '  • configure /worktree settings onSwitch "<command that spawns pi in a new tab/window>"',
        '  • (on pi >= 0.65.0) set switchBehavior = "in-place" to move this',
        '    session into the worktree directly:',
        '      /worktree settings switchBehavior in-place',
      ].join('\n'),
      'info'
    );
    return;
  }

  const ok = await runOnSwitchHook(ctx.ui.notify.bind(ctx.ui));
  if (!ok) {
    return;
  }
  ctx.ui.notify(`Worktree path: ${existingWorktree.path}`, 'info');
  if (current.switchBehavior !== 'hook-only') {
    ctx.ui.notify(
      `onSwitch finished. Note: this pi session was not moved to ${existingWorktree.path} because the in-place switch fell back. The hook just ran instead.`,
      'info'
    );
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdCreate } from '../../src/cmds/cmdCreate.ts';
import type { CommandDeps } from '../../src/types.ts';
import * as gitService from '../../src/services/git.ts';

const forkFromMock = vi.fn();

vi.mock('@mariozechner/pi-coding-agent', () => ({
  // The cross-cwd feature-detect in shared.ts looks for this symbol; provide
  // it so the helper takes the supported path.
  createAgentSessionRuntime: () => undefined,
  SessionManager: {
    forkFrom: (...args: unknown[]) => forkFromMock(...args),
  },
}));

const baseCurrent = {
  project: 'repo',
  mainWorktree: '/main/repo',
  parentDir: '/tmp/repo.worktrees',
  logfile: '/tmp/pi-worktree-{sessionId}-{name}.log',
  onCreateDisplayOutputMaxLines: 5,
  onCreateCmdDisplayPending: '[ ] {{cmd}}',
  onCreateCmdDisplaySuccess: '[x] {{cmd}}',
  onCreateCmdDisplayError: '[ ] {{cmd}} [ERROR]',
  onCreateCmdDisplayPendingColor: 'dim',
  onCreateCmdDisplaySuccessColor: 'success',
  onCreateCmdDisplayErrorColor: 'error',
};

function createDeps(overrides: Record<string, unknown>): CommandDeps {
  return {
    settings: {},
    configService: {
      current: vi.fn(() => ({ ...baseCurrent, ...overrides })),
      worktrees: new Map(),
    } as unknown as CommandDeps['configService'],
    statusService: {
      busy: vi.fn(() => vi.fn()),
      positive: vi.fn(),
      critical: vi.fn(),
    } as unknown as CommandDeps['statusService'],
  };
}

const notify = vi.fn();
const confirm = vi.fn();

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/main/repo',
    hasUI: true,
    ui: { notify, confirm },
    sessionManager: {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/source-session.jsonl',
    },
    switchSession: vi.fn(
      // eslint-disable-next-line no-unused-vars
      async (_p: string, opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        await opts?.withSession?.({ ui: { notify: vi.fn() } });
        return { cancelled: false };
      }
    ),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  notify.mockReset();
  confirm.mockReset();
  forkFromMock.mockReset();
  forkFromMock.mockImplementation(() => ({
    getSessionFile: () => '/tmp/forked-session.jsonl',
  }));

  vi.spyOn(gitService, 'isGitRepo').mockReturnValue(true);
  vi.spyOn(gitService, 'listWorktrees').mockReturnValue([]);
  vi.spyOn(gitService, 'ensureExcluded').mockImplementation(() => {});
  // First call (rev-parse --verify <branch>) throws to signify the branch
  // does not exist; subsequent calls (worktree add) succeed.
  vi.spyOn(gitService, 'git').mockImplementation((args: string[]) => {
    if (args[0] === 'rev-parse') {
      throw new Error('branch does not exist');
    }
    return '';
  });
});

describe('cmdCreate new worktree + switchBehavior=in-place (default)', () => {
  it('runs onCreate, then forks the session and switches into the new worktree', async () => {
    const deps = createDeps({
      switchBehavior: 'in-place',
      onCreate: 'echo created',
    });
    const ctx = createCtx();

    await cmdCreate('feature/login', ctx as never, deps);

    // Worktree was created.
    expect(gitService.git).toHaveBeenCalledWith(
      ['worktree', 'add', '-b', 'feature/login', '/tmp/repo.worktrees/feature-login'],
      '/main/repo'
    );
    // Session was forked + switched into the new worktree.
    expect(forkFromMock).toHaveBeenCalledWith(
      '/tmp/source-session.jsonl',
      '/tmp/repo.worktrees/feature-login'
    );
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);

    // onCreate ran (in the OLD ctx, before the switch).
    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toMatch(/onCreate steps:/);
    expect(fullText).toContain('echo created');
    expect(fullText).toMatch(/Switching session into feature\/login/);
  });

  it('still switches even when no onCreate is configured', async () => {
    const deps = createDeps({ switchBehavior: 'in-place' });
    const ctx = createCtx();

    await cmdCreate('feature/empty', ctx as never, deps);

    expect(forkFromMock).toHaveBeenCalledTimes(1);
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);
  });
});

describe('cmdCreate new worktree + switchBehavior=hook-only', () => {
  it('runs onCreate but does NOT fork or switch the session', async () => {
    const deps = createDeps({
      switchBehavior: 'hook-only',
      onCreate: 'echo created',
      onSwitch: 'echo switched-should-not-run',
    });
    const ctx = createCtx();

    await cmdCreate('feature/local', ctx as never, deps);

    expect(gitService.git).toHaveBeenCalledWith(
      ['worktree', 'add', '-b', 'feature/local', '/tmp/repo.worktrees/feature-local'],
      '/main/repo'
    );
    expect(forkFromMock).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toMatch(/onCreate steps:/);
    // onSwitch should not run on a fresh creation in hook-only mode.
    expect(fullText).not.toMatch(/onSwitch steps:/);
  });
});

describe('cmdCreate new worktree + switchBehavior=both', () => {
  it('runs onCreate, switches, then runs onSwitch inside the replaced session', async () => {
    const deps = createDeps({
      switchBehavior: 'both',
      onCreate: 'echo first-time-only',
      onSwitch: 'echo every-time',
    });
    const newCtxNotify = vi.fn();
    const ctx = createCtx({
      switchSession: vi.fn(
        // eslint-disable-next-line no-unused-vars
        async (_p: string, opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
          await opts?.withSession?.({ ui: { notify: newCtxNotify } });
          return { cancelled: false };
        }
      ),
    });

    await cmdCreate('feature/layered', ctx as never, deps);

    // onCreate ran in the OLD ctx, before the switch.
    const oldText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(oldText).toContain('echo first-time-only');

    // After the switch, onSwitch ran in the NEW ctx.
    const newText = newCtxNotify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(newText).toContain('✓ Switched');
    expect(newText).toMatch(/onSwitch steps:/);
    expect(newText).toContain('echo every-time');
  });

  it('does not run onSwitch in "both" mode if no onSwitch is configured', async () => {
    const deps = createDeps({
      switchBehavior: 'both',
      onCreate: 'echo only-onCreate',
    });
    const newCtxNotify = vi.fn();
    const ctx = createCtx({
      switchSession: vi.fn(
        // eslint-disable-next-line no-unused-vars
        async (_p: string, opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
          await opts?.withSession?.({ ui: { notify: newCtxNotify } });
          return { cancelled: false };
        }
      ),
    });

    await cmdCreate('feature/onCreate-only', ctx as never, deps);

    const newText = newCtxNotify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(newText).toContain('✓ Switched');
    expect(newText).not.toMatch(/onSwitch steps:/);
  });
});

describe('cmdCreate new worktree + switchBehavior=in-place fallback', () => {
  it('reports a graceful warning + path notice when the in-place switch is unsupported', async () => {
    const deps = createDeps({
      switchBehavior: 'in-place',
      onCreate: 'echo created',
    });
    const ctx = createCtx({ switchSession: undefined });

    await cmdCreate('feature/no-switch-api', ctx as never, deps);

    expect(forkFromMock).not.toHaveBeenCalled();
    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    // onCreate still ran.
    expect(fullText).toMatch(/onCreate steps:/);
    // Warning explains the unsupported reason.
    expect(fullText).toMatch(/Couldn't switch into the new worktree/);
    expect(fullText).toMatch(/pi is too old/);
    // Actionable next-step is offered.
    expect(fullText).toMatch(/cd .* && pi/);
    expect(fullText).toMatch(/\/worktree list to switch later/);
  });
});

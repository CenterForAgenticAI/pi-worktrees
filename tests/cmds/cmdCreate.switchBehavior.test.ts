import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdCreate } from '../../src/cmds/cmdCreate.ts';
import type { CommandDeps } from '../../src/types.ts';
import * as gitService from '../../src/services/git.ts';

const forkFromMock = vi.fn();

vi.mock('@mariozechner/pi-coding-agent', () => ({
  // The cross-cwd feature-detect in shared.ts looks for this symbol; provide
  // it so the helper takes the supported path during tests.
  createAgentSessionRuntime: () => undefined,
  SessionManager: {
    forkFrom: (...args: unknown[]) => forkFromMock(...args),
  },
}));

const baseCurrent = {
  project: 'repo',
  mainWorktree: '/main/repo',
  parentDir: '/main/repo.worktrees',
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

let worktreePath = '';
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
        // Simulate pi calling withSession with a fresh ReplacedSessionContext.
        await opts?.withSession?.({ ui: { notify: vi.fn() } });
        return { cancelled: false };
      }
    ),
    ...overrides,
  };
}

beforeEach(() => {
  notify.mockReset();
  confirm.mockReset();
  forkFromMock.mockReset();
  forkFromMock.mockImplementation(() => ({
    getSessionFile: () => '/tmp/forked-session.jsonl',
  }));

  worktreePath = mkdtempSync(`${tmpdir()}/pi-worktree-create-`);

  vi.spyOn(gitService, 'isGitRepo').mockReturnValue(true);
  // Make our requested branch look pre-existing on the same worktree path.
  vi.spyOn(gitService, 'listWorktrees').mockReturnValue([
    {
      path: worktreePath,
      branch: 'feature/a',
      head: 'abc',
      isMain: false,
      isCurrent: false,
    },
  ]);
  // Default: user accepts the confirm prompt.
  confirm.mockResolvedValue(true);
});

describe('cmdCreate existing-worktree + switchBehavior=in-place', () => {
  it('switches the session in place when the user confirms', async () => {
    const deps = createDeps({ switchBehavior: 'in-place' });
    const ctx = createCtx();

    // Drive cmdCreate down the existing-worktree path: branch matches.
    await cmdCreate(`feature/a --name ${worktreePath.split('/').pop()}`, ctx as never, deps);

    expect(forkFromMock).toHaveBeenCalledWith('/tmp/source-session.jsonl', worktreePath);
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);

    const confirmCall = confirm.mock.calls[0];
    expect(String(confirmCall[1])).toMatch(/Switch this pi session into the worktree/);
  });

  it('falls back to hook-only with a warning when in-place is unsupported', async () => {
    const deps = createDeps({
      switchBehavior: 'in-place',
      onSwitch: 'echo fallback',
    });
    const ctx = createCtx({ switchSession: undefined });

    await cmdCreate(`feature/a --name ${worktreePath.split('/').pop()}`, ctx as never, deps);

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toMatch(/Couldn't switch the session in place/);
    expect(fullText).toMatch(/onSwitch steps:/);
    expect(fullText).toMatch(/was not moved/);
  });

  it('runs onSwitch inside withSession when switchBehavior is "both"', async () => {
    const deps = createDeps({
      switchBehavior: 'both',
      onSwitch: 'echo post-switch',
    });
    const ctx = createCtx();

    await cmdCreate(`feature/a --name ${worktreePath.split('/').pop()}`, ctx as never, deps);

    expect(ctx.switchSession).toHaveBeenCalledTimes(1);
    const confirmCall = confirm.mock.calls[0];
    expect(String(confirmCall[1])).toMatch(/onSwitch will run after the switch/);
  });

  it('respects "hook-only" and never forks/switches', async () => {
    const deps = createDeps({
      switchBehavior: 'hook-only',
      onSwitch: 'echo hook-only',
    });
    const ctx = createCtx();

    await cmdCreate(`feature/a --name ${worktreePath.split('/').pop()}`, ctx as never, deps);

    expect(forkFromMock).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();

    const confirmCall = confirm.mock.calls[0];
    expect(String(confirmCall[1])).toMatch(/Run onSwitch for this worktree/);
    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toMatch(/onSwitch steps:/);
    // Same UX rule as cmdList: don't lecture users who chose hook-only.
    expect(fullText).not.toMatch(/was not moved/);
  });

  it('cancels when the user declines the confirm prompt', async () => {
    const deps = createDeps({ switchBehavior: 'in-place' });
    const ctx = createCtx();
    confirm.mockResolvedValue(false);

    await cmdCreate(`feature/a --name ${worktreePath.split('/').pop()}`, ctx as never, deps);

    expect(forkFromMock).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();
    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toContain('Cancelled');
  });
});

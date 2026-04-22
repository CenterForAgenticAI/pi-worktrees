import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdList } from '../../src/cmds/cmdList.ts';
import type { CommandDeps } from '../../src/types.ts';
import * as gitService from '../../src/services/git.ts';

// Shared stub for SessionManager.forkFrom. Each test can override.
const forkFromMock = vi.fn();

vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: {
    forkFrom: (...args: unknown[]) => forkFromMock(...args),
  },
}));

// Minimal defaults the `current` resolver fills in.
const baseCurrent = {
  project: 'repo',
  mainWorktree: '/main/repo',
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
const select = vi.fn();
const confirm = vi.fn();

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/main/repo',
    hasUI: true,
    ui: { notify, select, confirm },
    sessionManager: {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/source-session.jsonl',
    },
    switchSession: vi.fn(async () => ({ cancelled: false })),
    ...overrides,
  };
}

beforeEach(() => {
  notify.mockReset();
  select.mockReset();
  confirm.mockReset();
  forkFromMock.mockReset();
  forkFromMock.mockImplementation(() => ({
    getSessionFile: () => '/tmp/forked-session.jsonl',
  }));

  worktreePath = mkdtempSync(`${tmpdir()}/pi-worktree-switch-`);

  vi.spyOn(gitService, 'isGitRepo').mockReturnValue(true);
  vi.spyOn(gitService, 'listWorktrees').mockReturnValue([
    {
      path: worktreePath,
      branch: 'feature/a',
      head: 'abc123',
      isMain: false,
      isCurrent: false,
    },
  ]);
  select.mockResolvedValue(`feature/a\n  ${worktreePath}`);
});

describe('cmdList switchBehavior=in-place', () => {
  it('forks the session, calls ctx.switchSession, and emits switched-notice inside withSession', async () => {
    const deps = createDeps({ switchBehavior: 'in-place' });
    const ctx = createCtx();

    await cmdList('', ctx as never, deps);

    expect(forkFromMock).toHaveBeenCalledWith('/tmp/source-session.jsonl', worktreePath);
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);

    // Drive the withSession callback to ensure the post-switch notice fires.
    const [, opts] = (ctx.switchSession as ReturnType<typeof vi.fn>).mock.calls[0];
    const newNotify = vi.fn();
    await opts.withSession({ ui: { notify: newNotify } });

    const allNotifications = [
      ...notify.mock.calls.map((c) => String(c[0])),
      ...newNotify.mock.calls.map((c) => String(c[0])),
    ].join('\n');

    expect(allNotifications).toMatch(/Switching session to feature\/a/);
    expect(allNotifications).toContain('✓ Switched');
    expect(allNotifications).toContain(worktreePath);
    expect(allNotifications).toContain('Session history was preserved');
  });

  it('does not run onSwitch in "in-place" mode even when a hook is configured', async () => {
    const deps = createDeps({ switchBehavior: 'in-place', onSwitch: 'echo should-not-run' });
    const ctx = createCtx();

    await cmdList('', ctx as never, deps);

    const [, opts] = (ctx.switchSession as ReturnType<typeof vi.fn>).mock.calls[0];
    const newNotify = vi.fn();
    await opts.withSession({ ui: { notify: newNotify } });

    const allNotifications = [
      ...notify.mock.calls.map((c) => String(c[0])),
      ...newNotify.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    expect(allNotifications).toContain('✓ Switched');
    expect(allNotifications).not.toMatch(/onSwitch steps:/);
    expect(allNotifications).not.toContain('echo should-not-run');
  });

  it('falls back to hook-only + warning when switchSession is unavailable on this pi', async () => {
    const deps = createDeps({
      switchBehavior: 'in-place',
      onSwitch: 'zellij action new-tab --cwd {{path}} -- pi',
    });
    const ctx = createCtx({ switchSession: undefined });

    await cmdList('', ctx as never, deps);

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(forkFromMock).not.toHaveBeenCalled();
    expect(fullText).toMatch(/Couldn't switch the session in place/);
    expect(fullText).toMatch(/pi is too old/);
    // Hook-only fallback runs the configured onSwitch.
    expect(fullText).toMatch(/onSwitch steps:/);
  });

  it('falls back to guidance when in-place fails and no hook is configured', async () => {
    const deps = createDeps({ switchBehavior: 'in-place' });
    const ctx = createCtx({ switchSession: undefined });

    await cmdList('', ctx as never, deps);

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toContain('No onSwitch hook is configured');
    expect(fullText).toContain(`cd ${worktreePath} && pi`);
    expect(fullText).toContain('switchBehavior = "in-place"');
  });
});

describe('cmdList switchBehavior=both', () => {
  it('switches and then runs onSwitch inside withSession', async () => {
    const deps = createDeps({
      switchBehavior: 'both',
      onSwitch: 'echo post-switch',
    });
    const ctx = createCtx();

    await cmdList('', ctx as never, deps);

    expect(ctx.switchSession).toHaveBeenCalledTimes(1);
    const [, opts] = (ctx.switchSession as ReturnType<typeof vi.fn>).mock.calls[0];
    const newNotify = vi.fn();
    await opts.withSession({ ui: { notify: newNotify } });

    const inside = newNotify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(inside).toContain('✓ Switched');
    expect(inside).toMatch(/onSwitch steps:/);
    expect(inside).toContain('echo post-switch');
  });
});

describe('cmdList switchBehavior=hook-only', () => {
  it('never forks or calls switchSession; runs the hook in place', async () => {
    const deps = createDeps({
      switchBehavior: 'hook-only',
      onSwitch: 'echo hook',
    });
    const ctx = createCtx();

    await cmdList('', ctx as never, deps);

    expect(forkFromMock).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).toMatch(/onSwitch steps:/);
    expect(fullText).toContain('echo hook');
    // Post-hook reminder explains the hook-only stance.
    expect(fullText).toMatch(/has not been moved/);
    expect(fullText).toContain('switchBehavior = "in-place"');
  });

  it('prints guidance (not "No onSwitch configured") when no hook is set', async () => {
    const deps = createDeps({ switchBehavior: 'hook-only' });
    const ctx = createCtx();

    await cmdList('', ctx as never, deps);

    const fullText = notify.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fullText).not.toMatch(/^No onSwitch configured for: /m);
    expect(fullText).toContain('No onSwitch hook is configured');
    expect(fullText).toContain(`cd ${worktreePath} && pi`);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attemptInPlaceSwitch } from '../../src/cmds/shared.ts';

// SessionManager is the source of `forkFrom`; we stub it out per-test.
const forkFromMock = vi.fn();

vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: {
    forkFrom: (...args: unknown[]) => forkFromMock(...args),
  },
}));

type MockCtx = {
  cwd: string;
  switchSession?: ReturnType<typeof vi.fn>;
  sessionManager?: { getSessionFile?: () => string | undefined } | undefined;
};

function ctxWith(overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    cwd: '/main/repo',
    switchSession: vi.fn(async () => ({ cancelled: false })),
    sessionManager: {
      getSessionFile: () => '/tmp/source-session.jsonl',
    },
    ...overrides,
  };
}

beforeEach(() => {
  forkFromMock.mockReset();
  forkFromMock.mockImplementation((_src: string, targetCwd: string) => ({
    getSessionFile: () => `/tmp/sessions/${Buffer.from(targetCwd).toString('hex')}.jsonl`,
  }));
});

describe('attemptInPlaceSwitch', () => {
  it('forks the session and calls ctx.switchSession with the forked path', async () => {
    const ctx = ctxWith();
    const withSession = vi.fn(async () => {});

    const result = await attemptInPlaceSwitch(
      ctx as never,
      { path: '/worktrees/feature-a' },
      { withSession }
    );

    expect(forkFromMock).toHaveBeenCalledWith('/tmp/source-session.jsonl', '/worktrees/feature-a');
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);
    const [, options] = (ctx.switchSession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options).toMatchObject({ withSession });
    expect(result).toEqual({
      status: 'switched',
      forkedSessionFile: expect.stringContaining('/tmp/sessions/'),
    });
  });

  it('short-circuits with "already-here" when ctx.cwd equals the target', async () => {
    const ctx = ctxWith({ cwd: '/worktrees/feature-a' });

    const result = await attemptInPlaceSwitch(ctx as never, {
      path: '/worktrees/feature-a',
    });

    expect(result).toEqual({ status: 'already-here' });
    expect(forkFromMock).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();
  });

  it('returns "no-switch-api" when ctx has no switchSession method', async () => {
    const ctx = ctxWith({ switchSession: undefined });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toEqual({ status: 'unsupported', reason: 'no-switch-api' });
    expect(forkFromMock).not.toHaveBeenCalled();
  });

  it('returns "no-session-file" when the current session is not persistent', async () => {
    const ctx = ctxWith({
      sessionManager: { getSessionFile: () => undefined },
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toEqual({ status: 'unsupported', reason: 'no-session-file' });
    expect(forkFromMock).not.toHaveBeenCalled();
  });

  it('returns "fork-failed" and wraps the thrown error', async () => {
    const ctx = ctxWith();
    const boom = new Error('disk full');
    forkFromMock.mockImplementation(() => {
      throw boom;
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'fork-failed',
      error: boom,
    });
    expect(ctx.switchSession).not.toHaveBeenCalled();
  });

  it('returns "switch-cancelled" when ctx.switchSession returns cancelled', async () => {
    const ctx = ctxWith({
      switchSession: vi.fn(async () => ({ cancelled: true })),
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toEqual({ status: 'unsupported', reason: 'switch-cancelled' });
  });

  it('returns "switch-failed" when ctx.switchSession throws', async () => {
    const boom = new Error('pi is broken');
    const ctx = ctxWith({
      switchSession: vi.fn(async () => {
        throw boom;
      }),
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'switch-failed',
      error: boom,
    });
  });
});

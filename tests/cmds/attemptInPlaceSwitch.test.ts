import { beforeEach, describe, expect, it, vi } from 'vitest';

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptInPlaceSwitch, describeUnsupportedSwitch } from '../../src/cmds/shared.ts';

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
  it('forks the session, calls ctx.switchSession with the forked path, and proxies withSession through', async () => {
    const ctx = ctxWith();
    const userWithSession = vi.fn(async () => {});
    // Simulate pi calling withSession with a fresh ReplacedSessionContext.
    (ctx.switchSession as ReturnType<typeof vi.fn>).mockImplementation(async (_path, opts) => {
      await opts?.withSession?.({ ui: { notify: vi.fn() } });
      return { cancelled: false };
    });

    const result = await attemptInPlaceSwitch(
      ctx as never,
      { path: '/worktrees/feature-a' },
      { withSession: userWithSession }
    );

    expect(forkFromMock).toHaveBeenCalledWith('/tmp/source-session.jsonl', '/worktrees/feature-a');
    // The helper wraps withSession so it can swallow caller errors. Verify by
    // behavior: when pi invokes the wrapper, the wrapper must invoke ours.
    expect(userWithSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'switched',
      forkedSessionFile: expect.stringContaining('/tmp/sessions/'),
    });
  });

  it('still reports "switched" with postSwitchError when the user-supplied withSession throws', async () => {
    const ctx = ctxWith();
    const callbackError = new Error('hook crashed');
    const userWithSession = vi.fn(async () => {
      throw callbackError;
    });
    (ctx.switchSession as ReturnType<typeof vi.fn>).mockImplementation(async (_path, opts) => {
      // pi awaits the wrapper; our wrapper catches user errors so this resolves cleanly.
      await opts?.withSession?.({ ui: { notify: vi.fn() } });
      return { cancelled: false };
    });

    const result = await attemptInPlaceSwitch(
      ctx as never,
      { path: '/worktrees/feature-a' },
      { withSession: userWithSession }
    );

    expect(result).toMatchObject({
      status: 'switched',
      postSwitchError: callbackError,
    });
  });

  it('still reports "switched" when ctx.switchSession rejects AFTER withSession started', async () => {
    const ctx = ctxWith();
    const userWithSession = vi.fn(async () => {});
    const lateError = new Error('rebindSession blew up');
    (ctx.switchSession as ReturnType<typeof vi.fn>).mockImplementation(async (_path, opts) => {
      // pi has already torn down + rebuilt; withSession is invoked.
      await opts?.withSession?.({ ui: { notify: vi.fn() } });
      // But something downstream throws.
      throw lateError;
    });

    const result = await attemptInPlaceSwitch(
      ctx as never,
      { path: '/worktrees/feature-a' },
      { withSession: userWithSession }
    );

    expect(result).toMatchObject({
      status: 'switched',
      postSwitchError: lateError,
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

  it('short-circuits with "already-here" across trailing slash differences', async () => {
    const ctx = ctxWith({ cwd: '/worktrees/feature-a/' });

    const result = await attemptInPlaceSwitch(ctx as never, {
      path: '/worktrees/feature-a',
    });

    expect(result).toEqual({ status: 'already-here' });
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

  it('returns "switch-failed" when ctx.switchSession throws BEFORE withSession runs', async () => {
    const boom = new Error('pi is broken');
    const ctx = ctxWith({
      // Throw without invoking withSession — simulates a pre-replacement
      // failure (assertSessionCwdExists, teardownCurrent, etc.).
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

describe('attemptInPlaceSwitch orphan cleanup', () => {
  it('deletes the forked session file when the switch is cancelled pre-replacement', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-switch-orphan-'));
    const orphanPath = join(tmp, 'orphan.jsonl');
    writeFileSync(orphanPath, '{"type":"session"}\n');

    forkFromMock.mockImplementation(() => ({ getSessionFile: () => orphanPath }));
    const ctx = ctxWith({
      switchSession: vi.fn(async () => ({ cancelled: true })),
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toEqual({ status: 'unsupported', reason: 'switch-cancelled' });
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('deletes the forked session file when ctx.switchSession throws pre-replacement', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-switch-orphan-'));
    const orphanPath = join(tmp, 'orphan.jsonl');
    writeFileSync(orphanPath, '{"type":"session"}\n');

    forkFromMock.mockImplementation(() => ({ getSessionFile: () => orphanPath }));
    const ctx = ctxWith({
      switchSession: vi.fn(async () => {
        throw new Error('pre-replacement boom');
      }),
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toMatchObject({ status: 'unsupported', reason: 'switch-failed' });
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('keeps the forked session file when withSession ran (it is the active session)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-switch-orphan-'));
    const activePath = join(tmp, 'active.jsonl');
    writeFileSync(activePath, '{"type":"session"}\n');

    forkFromMock.mockImplementation(() => ({ getSessionFile: () => activePath }));
    const ctx = ctxWith({
      switchSession: vi.fn(async (_p, opts) => {
        await opts?.withSession?.({ ui: { notify: vi.fn() } });
        // pi succeeded; we keep the forked file.
        return { cancelled: false };
      }),
    });

    const result = await attemptInPlaceSwitch(ctx as never, { path: '/worktrees/feature-a' });

    expect(result).toMatchObject({ status: 'switched' });
    expect(existsSync(activePath)).toBe(true);
  });
});

describe('describeUnsupportedSwitch', () => {
  it('returns a non-empty human description for every reason', () => {
    const reasons = [
      'no-switch-api',
      'no-session-file',
      'fork-failed',
      'switch-cancelled',
      'switch-failed',
    ] as const;
    for (const reason of reasons) {
      const text = describeUnsupportedSwitch(reason);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/undefined/i);
    }
  });
});

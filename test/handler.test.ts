import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { handleWebhookEvent, parseWebhookEvent } from '../src/webhook/handler.js';
import type { TrialGuard } from '../src/service/trial-guard.js';

const logger = pino({ level: 'silent' });

function fakeGuard() {
  return {
    onUserCreated: vi.fn(),
    onUserDeleted: vi.fn(),
    onHwidAdded: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrialGuard & {
    onUserCreated: ReturnType<typeof vi.fn>;
    onUserDeleted: ReturnType<typeof vi.fn>;
    onHwidAdded: ReturnType<typeof vi.fn>;
  };
}

describe('parseWebhookEvent', () => {
  it('parses an envelope with scope+event+data', () => {
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { uuid: 'u-1', username: 'alice', tag: 'trial' },
    });
    expect(event.scope).toBe('user');
    expect(event.event).toBe('user.created');
  });

  it('tolerates extra unknown top-level fields', () => {
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: {},
      meta: null,
      timestamp: '2026-05-04T12:00:00.000Z',
      something: { nested: 42 },
    });
    expect(event.scope).toBe('user');
  });

  it('rejects payload without scope', () => {
    expect(() => parseWebhookEvent({ event: 'user.created', data: {} })).toThrow();
  });
});

describe('handleWebhookEvent', () => {
  it('routes user.created to guard.onUserCreated', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { uuid: 'u-1', username: 'alice', tag: 'trial' },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserCreated).toHaveBeenCalledWith({
      uuid: 'u-1',
      username: 'alice',
      tag: 'trial',
    });
  });

  it('routes user.deleted to guard.onUserDeleted', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.deleted',
      data: { uuid: 'u-1', username: 'alice' },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserDeleted).toHaveBeenCalledWith('u-1');
  });

  it('routes user_hwid_devices.added even when hwidUserDevice has no userId/requestIp', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user_hwid_devices',
      event: 'user_hwid_devices.added',
      data: {
        user: { uuid: 'u-1', username: 'alice', tag: 'trial' },
        hwidUserDevice: { hwid: 'hwid-aaa', platform: 'ios' },
      },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onHwidAdded).toHaveBeenCalledWith(
      { uuid: 'u-1', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
  });

  it('passes null tag through unchanged', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { uuid: 'u-1', username: 'alice', tag: null },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserCreated).toHaveBeenCalledWith({
      uuid: 'u-1',
      username: 'alice',
      tag: null,
    });
  });

  it('ignores unrelated user.* events', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.modified',
      data: { uuid: 'u-1', username: 'alice', tag: 'trial' },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserCreated).not.toHaveBeenCalled();
    expect(guard.onUserDeleted).not.toHaveBeenCalled();
  });

  it('ignores other scopes', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'node',
      event: 'node.created',
      data: { foo: 'bar' },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserCreated).not.toHaveBeenCalled();
    expect(guard.onHwidAdded).not.toHaveBeenCalled();
  });

  it('throws on user.created with missing uuid', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { username: 'no-uuid' },
    });
    await expect(handleWebhookEvent(event, { guard, logger })).rejects.toThrow();
  });
});

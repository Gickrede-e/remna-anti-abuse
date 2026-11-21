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
  const currentUser = {
    id: 101,
    shortUuid: 'fixture-subscription',
    username: 'alice',
    tag: 'trial',
    createdAt: '2026-11-20T10:00:00.000Z',
  };

  it('registers user.created with the numeric Remnawave user ID', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({ scope: 'user', event: 'user.created', data: currentUser });

    await handleWebhookEvent(event, { guard, logger });

    expect(guard.onUserCreated).toHaveBeenCalledWith({
      id: '101',
      username: 'alice',
      tag: 'trial',
      createdAt: currentUser.createdAt,
    });
  });

  it('removes user.deleted with the numeric Remnawave user ID', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({ scope: 'user', event: 'user.deleted', data: currentUser });

    await handleWebhookEvent(event, { guard, logger });

    expect(guard.onUserDeleted).toHaveBeenCalledWith('101');
  });

  it('passes the numeric owner ID and account creation time from a device webhook', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user_hwid_devices',
      event: 'user_hwid_devices.added',
      data: { user: currentUser, hwidUserDevice: { userId: currentUser.id, hwid: 'hwid-aaa' } },
    });

    await handleWebhookEvent(event, { guard, logger });

    expect(guard.onHwidAdded).toHaveBeenCalledWith(
      { id: '101', username: 'alice', tag: 'trial', createdAt: currentUser.createdAt },
      { hwid: 'hwid-aaa' },
      expect.stringMatching(/^webhook:[a-f0-9]{64}$/),
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '101'])(
    'rejects an invalid numeric user ID %s',
    async (id) => {
      const guard = fakeGuard();
      const event = parseWebhookEvent({
        scope: 'user',
        event: 'user.created',
        data: { ...currentUser, id },
      });

      await expect(handleWebhookEvent(event, { guard, logger })).rejects.toThrow();
      expect(guard.onUserCreated).not.toHaveBeenCalled();
    },
  );

  it('uses the legacy UUID when an older payload also contains a numeric ID', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { uuid: 'u-1', id: 101, username: 'alice', tag: 'trial' },
    });
    await handleWebhookEvent(event, { guard, logger });
    expect(guard.onUserCreated).toHaveBeenCalledWith({
      id: 'u-1',
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
      { id: 'u-1', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
      expect.stringMatching(/^webhook:[a-f0-9]{64}$/),
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
      id: 'u-1',
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

  it('rejects user.created without an ID or a legacy UUID', async () => {
    const guard = fakeGuard();
    const event = parseWebhookEvent({
      scope: 'user',
      event: 'user.created',
      data: { username: 'no-uuid' },
    });
    await expect(handleWebhookEvent(event, { guard, logger })).rejects.toThrow();
  });
});

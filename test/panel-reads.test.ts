import { pino } from 'pino';
import { expect, it, vi } from 'vitest';
import { createRemnawaveClient } from '../src/remnawave-client.js';

const legacyUuid = '00000000-0000-4000-8000-000000000001';
const createdAt = '2026-10-01T12:00:00.000Z';
const legacyUser = { uuid: legacyUuid, id: 101, tag: 'TRIAL', status: 'ACTIVE', createdAt };
const currentUser = { id: 102, tag: 'TRIAL', status: 'ACTIVE', createdAt };

function mockPanel(...responses: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(Response.json({ response }));
  }
  const client = createRemnawaveClient({
    baseUrl: 'https://panel.example/',
    apiToken: 'test-token',
    logger: pino({ level: 'silent' }),
    fetchImpl,
  });

  return { client, fetchImpl };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const item of items) rows.push(item);
  return rows;
}

it('paginates trial users and keeps the legacy UUID and numeric device alias', async () => {
  const { client, fetchImpl } = mockPanel(
    { total: 2, users: [legacyUser] },
    { total: 2, users: [currentUser] },
  );

  const users = await collect(client.listTrialUsers(['TRIAL']));

  expect(users).toMatchObject([
    { id: legacyUuid, deviceUserId: '101', tag: 'TRIAL', status: 'ACTIVE', createdAt },
    { id: '102', deviceUserId: '102', tag: 'TRIAL', status: 'ACTIVE', createdAt },
  ]);
  const requests = fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
  expect(requests.map(url => url.pathname)).toEqual(['/api/users', '/api/users']);
  expect(requests.map(url => url.searchParams.get('start'))).toEqual(['0', '1']);
});

it.each([
  { owner: { userUuid: legacyUuid }, userId: legacyUuid },
  { owner: { userId: 102 }, userId: '102' },
])('paginates HWID devices with owner fields $owner', async ({ owner, userId }) => {
  const { client, fetchImpl } = mockPanel();
  const devices = ['device-a', 'device-b'].map(hwid => ({ hwid, ...owner, createdAt }));
  fetchImpl.mockImplementation(async input => {
    const request = new URL(String(input));
    const start = Number(request.searchParams.get('start'));
    return Response.json({ response: { total: devices.length, devices: devices.slice(start, start + 1) } });
  });

  const result = await collect(client.listDevices());

  expect(result).toMatchObject([
    { hwid: 'device-a', userId, createdAt },
    { hwid: 'device-b', userId, createdAt },
  ]);
  const requests = fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
  expect(requests.every(url => url.pathname === '/api/hwid/devices')).toBe(true);
  expect(requests.filter(url => url.searchParams.get('size') !== '1')
    .map(url => url.searchParams.get('start'))).toEqual(['0', '1']);
});

it('rejects a user page containing a malformed account', async () => {
  const { client } = mockPanel({ total: 1, users: [{ ...currentUser, id: {} }] });

  await expect(collect(client.listTrialUsers(['TRIAL']))).rejects.toThrow();
});

it('rejects a premature empty device page', async () => {
  const { client, fetchImpl } = mockPanel();
  fetchImpl.mockImplementation(async input => {
    const request = new URL(String(input));
    const devices = request.searchParams.get('start') === '0'
      ? [{ hwid: 'numeric-device', userId: 102, createdAt }]
      : [];
    return Response.json({ response: { total: 2, devices } });
  });

  await expect(collect(client.listDevices())).rejects.toThrow();
});

it('normalizes and validates the identity returned by a single-user lookup', async () => {
  const { client, fetchImpl } = mockPanel(legacyUser, currentUser, legacyUser);

  await expect(client.getUser(legacyUuid)).resolves.toMatchObject({
    id: legacyUuid, deviceUserId: '101', tag: 'TRIAL', status: 'ACTIVE', createdAt,
  });
  await expect(client.getUser('102')).resolves.toMatchObject({
    id: '102', deviceUserId: '102', tag: 'TRIAL', status: 'ACTIVE', createdAt,
  });
  await expect(client.getUser('103')).rejects.toThrow();
  expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/users/' + legacyUuid,
    '/api/users/102',
    '/api/users/103',
  ]);
});

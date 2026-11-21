import { expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { createRemnawaveClient } from '../src/remnawave-client.js';

it('posts the bodyless disable action for the numeric Remnawave ID', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  const client = createRemnawaveClient({
    baseUrl: 'https://panel.example/',
    apiToken: 'test-token',
    logger: pino({ level: 'silent' }),
    fetchImpl,
  });

  await client.disableUser('101');

  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledWith('https://panel.example/api/users/101/actions/disable', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      Accept: 'application/json',
    },
  });
});

import { describe, expect, it } from 'vitest';
import { computeSignature, isFreshTimestamp, verifySignature } from '../src/webhook/verify.js';

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ scope: 'user', event: 'user.created' });

  it('accepts a correctly signed body', () => {
    const sig = computeSignature(body, secret);
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it('rejects when a single byte of the body is changed', () => {
    const sig = computeSignature(body, secret);
    const tamperedBody = body.replace('user.created', 'user.deleted');
    expect(verifySignature(tamperedBody, sig, secret)).toBe(false);
  });

  it('rejects when signature is empty', () => {
    expect(verifySignature(body, '', secret)).toBe(false);
  });

  it('rejects when signature is the wrong length', () => {
    expect(verifySignature(body, 'deadbeef', secret)).toBe(false);
  });

  it('rejects when signed with a different secret', () => {
    const sig = computeSignature(body, 'other-secret');
    expect(verifySignature(body, sig, secret)).toBe(false);
  });
});

describe('isFreshTimestamp', () => {
  const now = Date.parse('2026-05-03T12:00:00.000Z');

  it('accepts an ISO timestamp within tolerance', () => {
    const ts = new Date(now - 10_000).toISOString();
    expect(isFreshTimestamp(ts, 60, now)).toBe(true);
  });

  it('rejects an ISO timestamp outside tolerance', () => {
    const ts = new Date(now - 10 * 60_000).toISOString();
    expect(isFreshTimestamp(ts, 60, now)).toBe(false);
  });

  it('accepts a unix-seconds timestamp within tolerance', () => {
    const ts = String(Math.floor((now - 5_000) / 1000));
    expect(isFreshTimestamp(ts, 60, now)).toBe(true);
  });

  it('rejects undefined', () => {
    expect(isFreshTimestamp(undefined, 60, now)).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(isFreshTimestamp('not-a-date', 60, now)).toBe(false);
  });
});

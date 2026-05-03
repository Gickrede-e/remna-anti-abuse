import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = computeSignature(rawBody, secret);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

export function isFreshTimestamp(
  timestampHeader: string | undefined,
  toleranceSec: number,
  now: number = Date.now(),
): boolean {
  if (!timestampHeader) return false;
  const ts = Date.parse(timestampHeader);
  if (Number.isNaN(ts)) {
    const numeric = Number(timestampHeader);
    if (!Number.isFinite(numeric)) return false;
    const millis = numeric < 1e12 ? numeric * 1000 : numeric;
    return Math.abs(now - millis) <= toleranceSec * 1000;
  }
  return Math.abs(now - ts) <= toleranceSec * 1000;
}

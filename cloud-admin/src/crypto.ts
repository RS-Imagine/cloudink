const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(input: string | BufferSource): Promise<ArrayBuffer> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return crypto.subtle.digest('SHA-256', bytes);
}

export async function sha256Hex(input: string | BufferSource): Promise<string> {
  return bytesToHex(new Uint8Array(await sha256Bytes(input)));
}

export async function sameSha256(
  a: string | BufferSource,
  b: string | BufferSource,
): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

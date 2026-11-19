const textEncoder = new TextEncoder();

export const $ = (id) => document.getElementById(id);

export function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

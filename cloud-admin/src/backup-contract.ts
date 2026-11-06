// Pure backup paths shared by the Worker and browser ZIP reader.
export function backupSource(key: string) {
  const match = key.match(
    /^(published|drafts|published-shorts|shorts)\/([A-Za-z0-9_-]{1,100})\.md$/,
  );
  return match
    ? { slug: match[2], short: ['published-shorts', 'shorts'].includes(match[1]) }
    : null;
}
export function legacyHistoryKey(key: string): boolean {
  return /^history\/[A-Za-z0-9_-]{1,100}\/[a-f0-9-]+\.md$/.test(key);
}
export function backupEntry(name: string): boolean {
  if (name === 'manifest.json') return true;
  if (name.startsWith('content/')) {
    const key = name.slice(8);
    return !!backupSource(key) || legacyHistoryKey(key);
  }
  if (!name.startsWith('media/')) return false;
  const key = name.slice(6);
  return (
    key.length <= 1024 &&
    (/^uploads\/icons\/[a-f0-9]{64}\.(?:svg|ico)$/.test(key) ||
      /^uploads\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(key)) &&
    !key.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

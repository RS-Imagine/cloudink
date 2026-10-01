import { parse, stringify } from 'smol-toml';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface FrontMatter {
  title: string; slug: string; date: string; updated?: string;
  description: string; draft: boolean;
}
export interface Draft { front_matter: FrontMatter; body_markdown: string }
export interface SiteConfig {
  title: string; bigTitle?: string; subtitle: string; author: string; description: string;
  footer?: string; clarityId?: string;
}
export interface LegacyPost extends Draft { body_html: string; body_plain_text: string }
export interface Release {
  schema_version: 1; id: string; created_at: string;
  site: SiteConfig; markdown_posts: Record<string, string>;
  legacy_posts: LegacyPost[]; about_html?: string; about_markdown?: string;
  assets: Record<string, string>;
}
export interface Publishing {
  release_id: string; previous_id: string; status: 'queued' | 'building' | 'built' | 'deployed' | 'failed';
  started_at: string; error?: string;
}

export function validSlug(slug: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(slug)) throw new HttpError(400, '文章地址只能使用英文字母、数字、短横线和下划线（最多 100 个字符）。');
  return slug;
}
function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `${name}为空或超过长度限制。`);
  return value;
}
function date(value: unknown): string {
  const s = text(value, '日期', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new HttpError(400, '日期需要是有效的 YYYY-MM-DD。');
  return s;
}
export function validateDraft(input: unknown): Draft {
  if (!input || typeof input !== 'object' || !('front_matter' in input) || !('body_markdown' in input)) throw new HttpError(400, '文章格式不正确。');
  const raw = input.front_matter;
  if (!raw || typeof raw !== 'object') throw new HttpError(400, '文章信息不完整。');
  const f = raw as Record<string, unknown>;
  return { front_matter: {
    title: text(f.title, '标题', 300), slug: validSlug(text(f.slug, '文章地址', 100)),
    date: date(f.date), ...(f.updated ? { updated: date(f.updated) } : {}),
    description: text(f.description ?? '', '摘要', 2000, false), draft: f.draft === true,
  }, body_markdown: text(input.body_markdown, '正文', 1_000_000, false) };
}
export function parseSource(source: string): Draft {
  const match = source.replace(/^\uFEFF/, '').match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new HttpError(400, 'Markdown 需要包含 +++ 包围的 TOML 文章信息。');
  try { return validateDraft({ front_matter: parse(match[1]), body_markdown: match[2].replace(/^\r?\n/, '') }); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, '无法解析 Markdown 的 TOML 文章信息。'); }
}
export function serializeDraft(draft: Draft): string {
  return `+++\n${stringify({ ...draft.front_matter })}+++\n\n${draft.body_markdown}`;
}
export function validateSite(input: unknown): SiteConfig {
  if (!input || typeof input !== 'object') throw new HttpError(400, '网站信息格式不正确。');
  const v = input as Record<string, unknown>;
  const appearance: Pick<SiteConfig,'footer'|'clarityId'>={};
  if(v.footer!==undefined)appearance.footer=text(v.footer,'页脚',2000,false);
  if(v.clarityId!==undefined){appearance.clarityId=text(v.clarityId,'统计项目',64,false);if(appearance.clarityId&&!/^[A-Za-z0-9]+$/.test(appearance.clarityId))throw new HttpError(400,'统计项目格式不正确。');}
  return {title: text(v.title,'网站标题',300), subtitle:text(v.subtitle,'副标题',1000,false), author:text(v.author,'作者',300), description:text(v.description,'网站描述',2000,false), ...(v.bigTitle ? {bigTitle:text(v.bigTitle,'首页大标题',300)} : {}),...appearance};
}
export async function limitedBody(request: Request, max: number): Promise<ArrayBuffer> {
  if (Number(request.headers.get('content-length') || 0) > max) throw new HttpError(413, '上传内容太大。');
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); throw new HttpError(413, '上传内容太大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
export async function jsonInput(request: Request, max = 2_100_000): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415,'请使用 JSON 请求。');
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(await limitedBody(request, max)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object required');
    return data as Record<string, unknown>;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400,'请求格式不正确。'); }
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers } });
}
export async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key); return obj ? obj.json<T>() : null;
}

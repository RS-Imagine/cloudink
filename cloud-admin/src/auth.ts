import type { CloudInkEnv } from './env';
import { initializeBrowserContent } from './browser-publishing';
import { HttpError, json, jsonInput, readJson, validateSite, type SiteConfig } from './models';

interface Account {
  email: string;
  salt: string;
  hash: string;
  version: string;
  initialSite: SiteConfig;
}
export interface Session {
  csrf: string;
  expires: number;
  version: string;
  email?: string;
}
const COOKIE = '__Host-cloudink_session';
const encoder = new TextEncoder();
export function randomToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function digest(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))));
}
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}
export function sameOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    throw new HttpError(403, '请求来源不正确，请重新打开后台。');
}
async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000 },
        key,
        256,
      ),
    ),
  );
}
function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128)
    throw new HttpError(400, '密码需要 12–128 个字符。');
  return value;
}
export function emailInput(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new HttpError(400, '请输入有效的登录邮箱。');
  return value.trim().toLowerCase();
}
function cookie(token: string, age: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}
function cookieToken(request: Request): string {
  return (
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1) || ''
  );
}
export async function requireSession(request: Request, env: CloudInkEnv): Promise<Session> {
  const token = cookieToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, '请先登录。');
  const [session, account] = await Promise.all([
    readJson<Session>(env.STORAGE, `auth/sessions/${await digest(token)}`),
    readJson<Account>(env.STORAGE, 'auth/account.json'),
  ]);
  if (!session || !account || session.expires < Date.now() || session.version !== account.version)
    throw new HttpError(401, '登录已过期，请重新登录。');
  if (!['GET', 'HEAD'].includes(request.method)) {
    sameOrigin(request);
    if (!(await sameSecret(request.headers.get('X-CSRF-Token') || '', session.csrf)))
      throw new HttpError(403, '登录校验已失效，请刷新页面。');
  }
  return { ...session, email: account.email };
}
async function loginResponse(env: CloudInkEnv, account: Account): Promise<Response> {
  const token = randomToken();
  const session: Session = {
    csrf: randomToken(),
    expires: Date.now() + 7 * 86400_000,
    version: account.version,
  };
  await env.STORAGE.put(`auth/sessions/${await digest(token)}`, JSON.stringify(session));
  return json({ email: account.email, csrf: session.csrf }, 200, {
    'Set-Cookie': cookie(token, 7 * 86400),
  });
}
export async function authRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
): Promise<Response | null> {
  if (path === '/api/session' && request.method === 'GET') {
    const session = await requireSession(request, env);
    return json({ email: session.email, csrf: session.csrf });
  }
  if ((path === '/api/login' || path === '/api/setup') && request.method === 'POST') {
    sameOrigin(request);
    const limit = await env.LOGIN_LIMITER.limit({
      key: request.headers.get('CF-Connecting-IP') || 'local',
    });
    if (!limit.success) throw new HttpError(429, '尝试次数过多，请一分钟后再试。');
    const data = await jsonInput(request, 16384);
    const account = await readJson<Account>(env.STORAGE, 'auth/account.json');
    if (path === '/api/setup') {
      if (account) throw new HttpError(409, '后台已经初始化，请使用登录页面。');
      if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 16 || env.SETUP_TOKEN.length > 128)
        throw new HttpError(
          503,
          '请在 Cloudflare 设置 16–128 个字符的 SETUP_TOKEN Secret，再打开初始化页面。',
        );
      if (
        !env.SETUP_TOKEN ||
        !(await sameSecret(request.headers.get('Authorization') || '', `Bearer ${env.SETUP_TOKEN}`))
      )
        throw new HttpError(403, '初始化口令不正确。');
      const email = emailInput(data.email);
      const password = passwordInput(data.password),
        salt = randomToken();
      const initialSite = validateSite(data.site);
      // Store the initial site with the account: interrupted setup can be resumed
      // by a normal login without reopening setup or resetting the password.
      const created: Account = {
        email,
        salt,
        hash: await passwordHash(password, salt),
        version: randomToken(),
        initialSite,
      };
      const saved = await env.STORAGE.put('auth/account.json', JSON.stringify(created), {
        onlyIf: { etagDoesNotMatch: '*' },
      });
      if (!saved) throw new HttpError(409, '后台已经初始化，请使用登录页面。');
      await initializeBrowserContent(env, initialSite);
      return loginResponse(env, created);
    }
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    if (password.length > 128) throw new HttpError(401, '邮箱或密码不正确。');
    // Hash even nonexistent accounts to avoid a cheap account-enumeration path.
    const hash = await passwordHash(password, account?.salt || 'uninitialized-cloudink');
    if (!account || email !== account.email || !(await sameSecret(hash, account.hash)))
      throw new HttpError(401, '邮箱或密码不正确，或后台尚未初始化。');
    await initializeBrowserContent(env, account.initialSite);
    return loginResponse(env, account);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    await requireSession(request, env);
    await env.STORAGE.delete(`auth/sessions/${await digest(cookieToken(request))}`);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/account' && request.method === 'PUT') {
    await requireSession(request, env);
    const data = await jsonInput(request, 4096),
      object = await env.STORAGE.get('auth/account.json');
    if (!object) throw new HttpError(401, '请重新登录。');
    const account = await object.json<Account>();
    if (
      typeof data.current_password !== 'string' ||
      data.current_password.length > 128 ||
      !(await sameSecret(await passwordHash(data.current_password, account.salt), account.hash))
    )
      throw new HttpError(400, '当前密码不正确。');
    const salt = randomToken();
    const updated: Account = {
      ...account,
      email: emailInput(data.email),
      version: randomToken(),
    };
    if (data.password) {
      updated.salt = salt;
      updated.hash = await passwordHash(passwordInput(data.password), salt);
    }
    const saved = await env.STORAGE.put('auth/account.json', JSON.stringify(updated), {
      onlyIf: { etagMatches: object.etag },
    });
    if (!saved) throw new HttpError(409, '账户刚刚发生了修改，请重新登录。');
    await env.STORAGE.delete(`auth/sessions/${await digest(cookieToken(request))}`);
    return loginResponse(env, updated);
  }
  return null;
}

import { HttpError, json, jsonInput, readJson } from './models';

interface Account { email: string; salt: string; hash: string; version: string }
export interface Session { csrf: string; expires: number; version: string }
const COOKIE = '__Host-rblog_session';
const encoder = new TextEncoder();
export function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function hex(bytes: Uint8Array): string { return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function digest(input: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(input)))); }
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(a)),crypto.subtle.digest('SHA-256',encoder.encode(b))]);
  return crypto.subtle.timingSafeEqual(x,y);
}
export function sameOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new HttpError(403,'请求来源不正确，请重新打开后台。');
}
async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100_000},key,256)));
}
function passwordInput(value: unknown): string {
  if(typeof value !== 'string' || value.length < 12 || value.length > 128) throw new HttpError(400,'密码需要 12–128 个字符。');
  return value;
}
function cookie(token: string, age: number): string { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`; }
function cookieToken(request: Request): string { return request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1) || ''; }
export async function requireSession(request: Request, env: Env): Promise<Session> {
  const token = cookieToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401,'请先登录。');
  const [session,account] = await Promise.all([readJson<Session>(env.CONTENT,`auth/sessions/${await digest(token)}`),readJson<Account>(env.CONTENT,'auth/account.json')]);
  if(!session || !account || session.expires < Date.now() || session.version !== account.version) throw new HttpError(401,'登录已过期，请重新登录。');
  if (!['GET','HEAD'].includes(request.method)) {
    sameOrigin(request);
    if (!await sameSecret(request.headers.get('X-CSRF-Token')||'',session.csrf)) throw new HttpError(403,'登录校验已失效，请刷新页面。');
  }
  return session;
}
async function loginResponse(env: Env, account: Account): Promise<Response> {
  const token = randomToken(); const session: Session={csrf:randomToken(),expires:Date.now()+7*86400_000,version:account.version};
  await env.CONTENT.put(`auth/sessions/${await digest(token)}`,JSON.stringify(session));
  return json({email:account.email,csrf:session.csrf},200,{'Set-Cookie':cookie(token,7*86400)});
}
export async function authRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/session' && request.method==='GET') {
    const session=await requireSession(request,env); return json({email:env.OWNER_EMAIL,csrf:session.csrf});
  }
  if ((path === '/api/login' || path === '/api/setup') && request.method==='POST') {
    sameOrigin(request);
    const ip=request.headers.get('CF-Connecting-IP') || 'local';
    const limit=await env.LOGIN_LIMITER.limit({key:ip});
    if(!limit.success) throw new HttpError(429,'尝试次数过多，请一分钟后再试。');
    const data=await jsonInput(request,4096);
    const account=await readJson<Account>(env.CONTENT,'auth/account.json');
    if(path==='/api/setup') {
      if(account) throw new HttpError(409,'后台已经初始化，请使用登录页面。');
      if(!env.SETUP_TOKEN || !await sameSecret(request.headers.get('Authorization')||'',`Bearer ${env.SETUP_TOKEN}`)) throw new HttpError(403,'初始化链接无效。');
      const password=passwordInput(data.password),salt=randomToken();
      const created: Account={email:env.OWNER_EMAIL.toLowerCase(),salt,hash:await passwordHash(password,salt),version:randomToken()};
      const saved=await env.CONTENT.put('auth/account.json',JSON.stringify(created),{onlyIf:{etagDoesNotMatch:'*'}});
      if(!saved) throw new HttpError(409,'后台已经初始化。');
      return loginResponse(env,created);
    }
    const email=typeof data.email==='string'?data.email.trim().toLowerCase():'';
    const password=typeof data.password==='string'?data.password:'';
    if(password.length>128) throw new HttpError(401,'邮箱或密码不正确。');
    // Hash even nonexistent accounts to avoid a cheap account-enumeration path.
    const hash=await passwordHash(password,account?.salt||'uninitialized-r-blog');
    if(!account || email!==env.OWNER_EMAIL.toLowerCase() || !await sameSecret(hash,account.hash)) throw new HttpError(401,'邮箱或密码不正确，或后台尚未初始化。');
    return loginResponse(env,account);
  }
  if(path==='/api/logout' && request.method==='POST') {
    await requireSession(request,env);
    await env.CONTENT.delete(`auth/sessions/${await digest(cookieToken(request))}`);
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  if(path==='/api/password' && request.method==='POST') {
    await requireSession(request,env);
    const data=await jsonInput(request,4096),obj=await env.CONTENT.get('auth/account.json');
    if(!obj) throw new HttpError(401,'请重新登录。');
    const account=await obj.json<Account>();
    if(typeof data.current_password!=='string' || data.current_password.length>128 || !await sameSecret(await passwordHash(data.current_password,account.salt),account.hash)) throw new HttpError(400,'当前密码不正确。');
    const salt=randomToken();
    const updated={...account,salt,hash:await passwordHash(passwordInput(data.password),salt),version:randomToken()};
    const saved=await env.CONTENT.put('auth/account.json',JSON.stringify(updated),{onlyIf:{etagMatches:obj.etag}});
    if(!saved) throw new HttpError(409,'账户刚刚发生了修改，请重新登录。');
    await env.CONTENT.delete(`auth/sessions/${await digest(cookieToken(request))}`);
    return loginResponse(env,updated);
  }
  return null;
}

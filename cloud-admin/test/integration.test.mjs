import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from "miniflare";
import { resolve } from "node:path";
const url = "https://admin.example.com";
const owner = "reader@example.net";
const password = "test-password-with-24-characters";
function draft(slug = "article", body = "\u6B63\u6587 **Markdown** $x^2$") {
  return { front_matter: { title: "\u6D4B\u8BD5\u6587\u7AE0", slug, date: "2026-10-01", description: "\u6458\u8981", draft: true }, body_markdown: body };
}
async function fixture(t, bindings = {}) {
  let marker = null, failHook = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "admin", scriptPath: resolve("dist/index.js"), modules: true, compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"], r2Buckets: ["CONTENT", "IMAGES"], ratelimits: { LOGIN_LIMITER: { namespace_id: "1001", simple: { limit: 5, period: 60 } } }, bindings: { OWNER_EMAIL: owner, SITE_URL: "https://reader-blog.example.net", IMAGE_ORIGIN: "https://reader-images.example.net", BUILD_TOKEN: "test-build-secret", SETUP_TOKEN: "test-setup-secret", ...bindings }, outboundService: async (request2) => {
    if (request2.url.includes("/pages/webhooks/") || request2.url.includes("/workers/builds/deploy_hooks/")) return new MFResponse(JSON.stringify({ success: !failHook }), { status: failHook ? 500 : 200, headers: { "Content-Type": "application/json" } });
    if (request2.url.includes("/_release.json")) return new MFResponse(JSON.stringify({ id: marker }), { headers: { "Content-Type": "application/json" } });
    return new MFResponse("Not found", { status: 404 });
  } }] }));
  t.after(() => mf.dispose());
  let cookie = "", csrf = "";
  async function request(path, method = "GET", body, extra = {}) {
    const headers = { ...cookie ? { Cookie: cookie } : {}, ...method !== "GET" ? { Origin: url, "X-CSRF-Token": csrf } : {}, ...extra };
    if (body !== void 0) headers["Content-Type"] = "application/json";
    return mf.dispatchFetch(url + path, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
  }
  const release = { schema_version: 1, id: "12345678-1234-1234-1234-123456789abc", created_at: (/* @__PURE__ */ new Date()).toISOString(), site: { title: "Existing Blog", bigTitle: "Brain Dump", subtitle: "Hello", author: "Test Author", description: "Existing description" }, markdown_posts: {}, legacy_posts: [{ front_matter: { title: "Old article", slug: "existing", date: "2026-06-11", description: "Old summary", draft: false }, body_markdown: "", body_html: "<p>Original HTML</p>", body_plain_text: "Original HTML" }], assets: {} };
  const bootstrap = await request("/internal/bootstrap", "POST", release, { Authorization: "Bearer test-build-secret" });
  assert.equal(bootstrap.status, 200);
  async function login() {
    const response = await request("/api/setup", "POST", { password }, { Authorization: "Bearer test-setup-secret" });
    assert.equal(response.status, 200, await response.clone().text());
    cookie = response.headers.get("Set-Cookie").split(";")[0];
    const session = await response.json();
    csrf = session.csrf;
  }
  return { mf, request, login, cookie: () => cookie, csrf: () => csrf, setMarker: (id) => {
    marker = id;
  }, setFailHook: () => {
    failHook = true;
  }, release };
}
test("private content and image uploads require a session; setup is single-use; CSRF is enforced", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/posts")).status, 401);
  assert.equal((await f.request("/api/upload", "POST", {})).status, 401);
  assert.equal((await f.request("/internal/bundle")).status, 401);
  assert.equal((await f.request("/api/setup", "POST", { password }, { Authorization: "Bearer wrong" })).status, 403);
  await f.login();
  assert.equal((await f.request("/api/setup", "POST", { password }, { Authorization: "Bearer test-setup-secret" })).status, 409);
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: draft(), etag: null }, { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: draft(), etag: null }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.request("/api/posts")).status, 200);
});
test("drafts stay private, stale saves conflict, and history preserves earlier content", async (t) => {
  const f = await fixture(t);
  await f.login();
  const saved = await f.request("/api/posts/article", "PUT", { draft: draft(), etag: null });
  assert.equal(saved.status, 200);
  const record = await saved.json();
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: draft("article", "Overwritten"), etag: null })).status, 409);
  const next = await f.request("/api/posts/article", "PUT", { draft: draft("article", "Newer content"), etag: record.etag });
  assert.equal(next.status, 200);
  const bundle = await f.request("/internal/bundle", "GET", void 0, { Authorization: "Bearer test-build-secret" });
  assert.ok(!(await bundle.text()).includes("Newer content"));
  const history = await f.request("/api/history/article");
  assert.equal((await history.json()).length, 2);
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: draft("wrong"), etag: record.etag })).status, 400);
});
test("a release includes only the requested saved article and becomes current only after the live marker matches", async (t) => {
  const f = await fixture(t);
  await f.login();
  const a = await f.request("/api/posts/article", "PUT", { draft: draft(), etag: null });
  const { etag } = await a.json();
  await f.request("/api/posts/private", "PUT", { draft: draft("private", "PRIVATE DRAFT"), etag: null });
  assert.equal((await f.request("/api/publish", "POST", { slug: "article", etag })).status, 503);
  assert.equal((await f.request("/api/settings/deployment", "PUT", { url: "https://evil.example/hook" })).status, 400);
  assert.equal((await f.request("/api/settings/deployment", "PUT", { url: "https://api.cloudflare.com/client/v4/pages/webhooks/test" })).status, 200);
  const published = await f.request("/api/publish", "POST", { slug: "article", etag });
  assert.equal(published.status, 202, await published.clone().text());
  const state = await published.json();
  assert.equal((await f.request("/api/publish", "POST", { slug: "article", etag })).status, 409);
  const bundle = await (await f.request("/internal/bundle", "GET", void 0, { Authorization: "Bearer test-build-secret" })).json();
  assert.equal(bundle.id, state.release_id);
  assert.ok(bundle.markdown_posts.article);
  assert.equal(bundle.markdown_posts.private, void 0);
  assert.equal(bundle.legacy_posts.length, 1);
  assert.equal((await (await f.request("/api/publish/status")).json()).status, "queued");
  f.setMarker(state.release_id);
  assert.equal((await (await f.request("/api/publish/status")).json()).status, "deployed");
  const bucket = await f.mf.getR2Bucket("CONTENT");
  const pointer = await bucket.get("state/published.json");
  assert.equal((await pointer.json()).id, state.release_id);
});
test("failed publication preserves the existing live release; invalid dates and traversal are rejected", async (t) => {
  const f = await fixture(t);
  await f.login();
  const bad = draft();
  bad.front_matter.date = "2026-02-30";
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: bad, etag: null })).status, 400);
  assert.equal((await f.request("/api/posts/article", "PUT", { draft: { ...draft(), front_matter: { ...draft().front_matter, slug: "../escape" } }, etag: null })).status, 400);
  const saved = await f.request("/api/posts/article", "PUT", { draft: draft(), etag: null });
  const { etag } = await saved.json();
  await f.request("/api/settings/deployment", "PUT", { url: "https://api.cloudflare.com/client/v4/pages/webhooks/test" });
  f.setFailHook();
  assert.equal((await f.request("/api/publish", "POST", { slug: "article", etag })).status, 502);
  const bundle = await (await f.request("/internal/bundle", "GET", void 0, { Authorization: "Bearer test-build-secret" })).json();
  assert.equal(bundle.id, f.release.id);
  assert.equal((await f.request("/api/posts/article")).status, 200);
});
test("password changes revoke old sessions and logout removes the current session", async (t) => {
  const f = await fixture(t);
  await f.login();
  const oldCookie = f.cookie();
  const changed = await f.request("/api/password", "POST", { current_password: password, password: "a-different-secure-password" });
  assert.equal(changed.status, 200);
  assert.equal((await f.request("/api/posts")).status, 401);
  const nextCookie = changed.headers.get("Set-Cookie").split(";")[0], { csrf } = await changed.json();
  const loggedOut = await f.request("/api/logout", "POST", {}, { Cookie: nextCookie, "X-CSRF-Token": csrf });
  assert.equal(loggedOut.status, 200);
  assert.equal((await f.request("/api/posts", "GET", void 0, { Cookie: oldCookie })).status, 401);
  assert.equal((await f.request("/api/posts", "GET", void 0, { Cookie: nextCookie })).status, 401);
});
test("uploads use unique names and reject non-image bytes", async (t) => {
  const f = await fixture(t);
  await f.login();
  const submit = async (bytes, name) => {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type: "image/png" }));
    const encoded=new Response(form);
    return f.mf.dispatchFetch(url + "/api/upload", { method: "POST", body: await encoded.arrayBuffer(), headers: { Origin: url, Cookie: f.cookie(), "X-CSRF-Token": f.csrf(), "Content-Type": encoded.headers.get("Content-Type") } });
  };
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const first = await submit(png, "same.png"), second = await submit(png, "same.png");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const a = await first.json(), b = await second.json();
  assert.notEqual(a.key, b.key);
  assert.equal((await submit(new TextEncoder().encode("<script>alert(1)<\/script>"), "fake.png")).status, 400);
  const image = await f.request(`/api/image?key=${encodeURIComponent(a.key)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
});
test('editor assets support conditional revalidation and expose the preview worker', async t => {
 const f=await fixture(t);
 const first=await f.request('/preview.worker.js');assert.equal(first.status,200);
 const etag=first.headers.get('ETag');assert.ok(etag);assert.match(first.headers.get('Cache-Control'),/must-revalidate/);
 const cached=await f.request('/preview.worker.js','GET',undefined,{'If-None-Match':etag});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
 const weak=await f.request('/preview.worker.js','GET',undefined,{'If-None-Match':`W/${etag}`});assert.equal(weak.status,304);
 const multiple=await f.request('/preview.worker.js','GET',undefined,{'If-None-Match':`"old", W/${etag}`});assert.equal(multiple.status,304);
 const wildcard=await f.request('/preview.worker.js','GET',undefined,{'If-None-Match':'*'});assert.equal(wildcard.status,304);
 assert.equal((await f.request('/preview.worker.js','GET',undefined,{'If-None-Match':'"old"'})).status,200);
});

test('Workers managed publishing uses its build token and preserves Pages rollback credentials', async t => {
  const f=await fixture(t,{WORKERS_BUILD_TOKEN:'test-workers-build-secret',WORKERS_DEPLOY_HOOK:'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/test'});
  assert.equal((await f.request('/internal/bundle','GET',undefined,{Authorization:'Bearer test-workers-build-secret'})).status,200);
  assert.equal((await f.request('/internal/bundle','GET',undefined,{Authorization:'Bearer wrong'})).status,401);
  await f.login();
  const settings=await (await f.request('/api/settings')).json();
  assert.deepEqual(settings.deployment,{configured:true,managed:true});
  assert.equal((await f.request('/api/settings/deployment','PUT',{url:'https://api.cloudflare.com/client/v4/pages/webhooks/test'})).status,409);
  const published=await f.request('/api/publish','POST',{rebuild:true});
  assert.equal(published.status,202);
  const state=await published.json();
  const status=await f.request('/internal/status','POST',{id:state.release_id,status:'built'},{Authorization:'Bearer test-workers-build-secret'});
  assert.equal(status.status,200);
  assert.equal((await (await f.request('/api/publish/status')).json()).status,'built');
  f.setMarker(state.release_id);
  assert.equal((await (await f.request('/api/publish/status')).json()).status,'deployed');
});
test('owner-configured Workers hooks are accepted and malformed hooks are rejected', async t => {
  const f=await fixture(t);await f.login();
  for(const url of ['https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/','https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/test/extra','https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/test?secret=x'])assert.equal((await f.request('/api/settings/deployment','PUT',{url})).status,400);
  assert.equal((await f.request('/api/settings/deployment','PUT',{url:'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/test'})).status,200);
  assert.equal((await f.request('/api/publish','POST',{rebuild:true})).status,202);
});

test('a fork uses its own public configuration and initialization cannot replace existing content', async t => {
  const f=await fixture(t,{OWNER_EMAIL:'writer@example.net',SITE_URL:'https://notes.reader.workers.dev',IMAGE_ORIGIN:'https://notes-images.reader.workers.dev',SITE_WORKER_NAME:'notes',PRODUCTION_BRANCH:'release',FOOTER_TEXT:'Reader notes',CLARITY_ID:''});
  const config=await(await f.request('/api/config')).json();
  assert.equal(config.siteUrl,'https://notes.reader.workers.dev');assert.equal(config.productionBranch,'release');assert.equal(config.initialized,false);
  assert.equal(JSON.stringify(config).includes('test-build-secret'),false);assert.equal('email' in config,false);
  const duplicate=await f.request('/internal/bootstrap','POST',{...f.release,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},{Authorization:'Bearer test-build-secret'});
  assert.equal(duplicate.status,409);
  const unchanged=await(await f.request('/internal/bundle','GET',undefined,{Authorization:'Bearer test-build-secret'})).json();
  assert.equal(unchanged.id,f.release.id);
  await f.login();assert.equal((await(await f.request('/api/config')).json()).initialized,true);
  const form=new FormData();form.set('file',new File([new Uint8Array([137,80,78,71,13,10,26,10])],'pic.png',{type:'image/png'}));
  const encoded=new Request(url+'/api/upload',{method:'POST',body:form});
  const upload=await f.mf.dispatchFetch(url+'/api/upload',{method:'POST',headers:{Cookie:f.cookie(),Origin:url,'X-CSRF-Token':f.csrf(),'Content-Type':encoded.headers.get('Content-Type')},body:await encoded.arrayBuffer()});
  assert.equal(upload.status,201);assert.ok((await upload.json()).url.startsWith('https://notes-images.reader.workers.dev/'));
});

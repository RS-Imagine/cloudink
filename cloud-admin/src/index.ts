import { ASSETS } from './assets.generated';
import { Buffer } from 'node:buffer';
import { authRoute, digest, requireSession, type Session } from './auth';
import { currentRelease, deploymentSettings, internalRoute, publish, publishStatus, saveHook } from './publishing';
import { HttpError, json, jsonInput, limitedBody, parseSource, readJson, serializeDraft, validSlug, validateDraft, validateSite, type Draft } from './models';

const MAX_IMAGE=10*1024*1024;
function editorial(draft: Draft): string { const f=draft.front_matter;return JSON.stringify([f.title,f.slug,f.date,f.description,draft.body_markdown]); }
async function draftSummary(draft: Draft): Promise<Record<string,string>> {
  const f=draft.front_matter;return {title:f.title,date:f.date,description:f.description.slice(0,1000),digest:await digest(editorial(draft))};
}
async function listDrafts(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[]=[];let cursor: string|undefined;
  do { const page=await bucket.list({prefix:'drafts/',limit:1000,include:['customMetadata'],cursor});objects.push(...page.objects);cursor=page.truncated?page.cursor:undefined; }while(cursor);
  return objects;
}
async function saveDraft(request: Request, env: Env, slug: string): Promise<Response> {
  const input=await jsonInput(request);
  let draft: Draft,source: string;
  if(typeof input.source==='string') {source=input.source;draft=parseSource(source);}
  else {draft=validateDraft(input.draft);draft.front_matter.draft=true;source=serializeDraft(draft);}
  if(draft.front_matter.slug!==slug) throw new HttpError(400,'文章地址与保存地址不一致。');
  const existing=await env.CONTENT.head(`drafts/${slug}.md`);
  if(existing && !existing.customMetadata?.deleted && input.etag!==existing.etag) throw new HttpError(409,'这篇文章在另一个窗口中发生了修改。请导出当前内容，再重新打开文章。');
  if(!existing && input.etag) throw new HttpError(409,'文章已被删除，请重新打开。');
  const saved=await env.CONTENT.put(`drafts/${slug}.md`,source,{onlyIf:existing?{etagMatches:existing.etag}:{etagDoesNotMatch:'*'},customMetadata:await draftSummary(draft),httpMetadata:{contentType:'text/markdown; charset=utf-8'}});
  if(!saved) throw new HttpError(409,'这篇文章刚刚发生了修改，请重新打开。');
  await env.CONTENT.put(`history/${slug}/${Date.now()}-${crypto.randomUUID()}.md`,source,{httpMetadata:{contentType:'text/markdown; charset=utf-8'}});
  return json({draft,source,etag:saved.etag,saved_at:new Date().toISOString()});
}
function imageType(bytes: Uint8Array): {type:string;ext:string} {
  const text=new TextDecoder().decode(bytes.slice(0,16));
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return {type:'image/jpeg',ext:'jpg'};
  if([137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) return {type:'image/png',ext:'png'};
  if(text.startsWith('GIF87a')||text.startsWith('GIF89a')) return {type:'image/gif',ext:'gif'};
  if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP') return {type:'image/webp',ext:'webp'};
  if(text.slice(4,8)==='ftyp'&&['avif','avis'].includes(text.slice(8,12))) return {type:'image/avif',ext:'avif'};
  throw new HttpError(400,'请上传 JPEG、PNG、GIF、WebP 或 AVIF 图片。');
}
async function apiRoute(request: Request, env: Env, path: string, session: Session): Promise<Response> {
  if(path==='/api/posts'&&request.method==='GET') {
    const publishing=await publishStatus(env);
    const [release,drafts]=await Promise.all([currentRelease(env),listDrafts(env.CONTENT)]);
    const published=new Map<string,{draft:Draft;digest:string}>();
    for(const [slug,source] of Object.entries(release.markdown_posts)) {const draft=parseSource(source);published.set(slug,{draft,digest:await digest(editorial(draft))});}
    const posts=new Map<string,unknown>();
    for(const post of release.legacy_posts) posts.set(post.front_matter.slug,{...post.front_matter,published:true,legacy:true,has_draft:false,changed:false});
    for(const [slug,p] of published) posts.set(slug,{...p.draft.front_matter,published:true,legacy:false,has_draft:false,changed:false});
    for(const object of drafts) {
      if(object.customMetadata?.deleted) continue;
      const slug=object.key.slice(7,-3),meta=object.customMetadata||{};
      posts.set(slug,{slug,title:meta.title||slug,date:meta.date||'',description:meta.description||'',published:published.has(slug)||release.legacy_posts.some(p=>p.front_matter.slug===slug),legacy:false,has_draft:true,changed:published.get(slug)?.digest!==meta.digest,etag:object.etag});
    }
    return json({posts:[...posts.values()],site:release.site,publishing,deployment:await deploymentSettings(env),email:env.OWNER_EMAIL,csrf:session.csrf});
  }
  const match=path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)$/);
  if(match) {
    const slug=validSlug(match[1]);
    if(request.method==='PUT') return saveDraft(request,env,slug);
    if(request.method==='GET') {
      const object=await env.CONTENT.get(`drafts/${slug}.md`);
      if(object && !object.customMetadata?.deleted) {const source=await object.text();return json({draft:parseSource(source),source,etag:object.etag,legacy:false});}
      const release=await currentRelease(env),source=release.markdown_posts[slug];
      if(source) return json({draft:parseSource(source),source,etag:null,legacy:false});
      const legacy=release.legacy_posts.find(p=>p.front_matter.slug===slug);
      if(legacy) return json({legacy:true,front_matter:legacy.front_matter});
      throw new HttpError(404,'文章不存在。');
    }
    if(request.method==='DELETE') {
      const release=await currentRelease(env);
      if(release.markdown_posts[slug]||release.legacy_posts.some(p=>p.front_matter.slug===slug)) throw new HttpError(409,'请先取消发布，再删除草稿。');
      const input=await jsonInput(request,4096),object=await env.CONTENT.head(`drafts/${slug}.md`);
      if(object&&input.etag!==object.etag) throw new HttpError(409,'文章已修改，请重新打开。');
      // R2 delete has no conditional variant; serialize deletion with an ETag
      // guarded tombstone so an editor cannot silently overwrite the deletion.
      if(object) {
        const locked=await env.CONTENT.put(`drafts/${slug}.md`,serializeDraft({front_matter:{title:'已删除',slug,date:'2000-01-01',description:'',draft:true},body_markdown:''}),{onlyIf:{etagMatches:object.etag},customMetadata:{title:'已删除',deleted:'true'}});
        if(!locked) throw new HttpError(409,'文章已修改，请重新打开。');
      }
      return json({ok:true});
    }
  }
  if(path==='/api/upload'&&request.method==='POST') {
    const body=await limitedBody(request,MAX_IMAGE+64*1024);
    const form=await new Response(body,{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData();
    const file=form.get('file'); if(!file||typeof file==='string') throw new HttpError(400,'请选择图片。');
    if(file.size>MAX_IMAGE) throw new HttpError(413,'每张图片最多 10 MB。');
    const bytes=new Uint8Array(await file.arrayBuffer()),type=imageType(bytes);
    const basename=file.name.replace(/\.[^.]*$/,'').replace(/[^A-Za-z0-9_-]/g,'-').slice(0,50)||'image';
    const key=`uploads/${new Date().toISOString().slice(0,7).replace('-','/')}/${crypto.randomUUID()}-${basename}.${type.ext}`;
    await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:type.type,cacheControl:'public, max-age=31536000, immutable'}});
    return json({key,url:`${env.IMAGE_ORIGIN}/${key}`,name:file.name},201);
  }
  if(path==='/api/image'&&request.method==='GET') {
    const key=new URL(request.url).searchParams.get('key');
    if(!key||key.length>1024||key.includes('..')||key.startsWith('/')) throw new HttpError(400,'图片地址不正确。');
    const image=await env.IMAGES.get(key);if(!image) throw new HttpError(404,'图片不存在。');
    const headers=new Headers({'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});image.writeHttpMetadata(headers);
    headers.set('Content-Security-Policy',"sandbox; default-src 'none'");
    return new Response(image.body,{headers});
  }
  if(path==='/api/publish'&&request.method==='POST') return publish(request,env);
  if(path==='/api/publish/status'&&request.method==='GET') return json(await publishStatus(env));
  if(path==='/api/settings'&&request.method==='GET') {
    const site=await env.CONTENT.get('draft-site.json'),release=await currentRelease(env);
    return json({site:site?await site.json():release.site,etag:site?.etag||null,deployment:await deploymentSettings(env)});
  }
  if(path==='/api/settings'&&request.method==='PUT') {
    const data=await jsonInput(request,16384),site=validateSite(data.site),old=await env.CONTENT.head('draft-site.json');
    if(old&&data.etag!==old.etag) throw new HttpError(409,'网站信息刚刚被修改，请重新打开设置。');
    const saved=await env.CONTENT.put('draft-site.json',JSON.stringify(site),{onlyIf:old?{etagMatches:old.etag}:{etagDoesNotMatch:'*'}});
    if(!saved) throw new HttpError(409,'网站信息刚刚被修改，请重新打开设置。');
    return json({site,etag:saved.etag});
  }
  if(path==='/api/settings/deployment'&&request.method==='PUT') {
    const data=await jsonInput(request,4096);await saveHook(env,data.url);return json({configured:true});
  }
  if(path==='/api/export'&&request.method==='GET') {
    const release=await currentRelease(env),drafts=await listDrafts(env.CONTENT),files:Record<string,string>={};
    for(const [slug,source] of Object.entries(release.markdown_posts)) files[`published/${slug}.md`]=source;
    for(const obj of drafts) {const source=await env.CONTENT.get(obj.key);if(source&&!obj.customMetadata?.deleted) files[obj.key]=await source.text();}
    files['site.json']=JSON.stringify(release.site); // UI writes this as site.json.
    return json({files,legacy_posts:release.legacy_posts,release_id:release.id});
  }
  const history=path.match(/^\/api\/history\/([A-Za-z0-9_-]+)$/);
  if(history&&request.method==='GET') {
    const slug=validSlug(history[1]),key=new URL(request.url).searchParams.get('key');
    if(key) {
      if(!key.startsWith(`history/${slug}/`)||!/^history\/[A-Za-z0-9_-]+\/[a-f0-9-]+\.md$/.test(key)) throw new HttpError(400,'历史版本地址不正确。');
      const obj=await env.CONTENT.get(key);if(!obj) throw new HttpError(404,'历史版本不存在。');const source=await obj.text();return json({source,draft:parseSource(source)});
    }
    const page=await env.CONTENT.list({prefix:`history/${slug}/`,limit:1000});return json(page.objects.map(o=>({key:o.key,saved_at:o.uploaded.toISOString()})).reverse().slice(0,50));
  }
  throw new HttpError(404,'接口不存在。');
}
function protect(response: Response, asset=false): Response {
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');
  headers.set('X-Frame-Options','DENY');headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(!asset) headers.set('Cache-Control','no-store');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; font-src 'self' https://cdn.jsdelivr.net; frame-src 'self' blob:; worker-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body,{status:response.status,headers});
}
export default {
  async fetch(request: Request,env: Env): Promise<Response> {
    try {
      const path=new URL(request.url).pathname;
      if(path==='/api/config' && request.method==='GET') return protect(json({siteUrl:env.SITE_URL,imageOrigin:env.IMAGE_ORIGIN,siteWorkerName:env.SITE_WORKER_NAME||'blog',productionBranch:env.PRODUCTION_BRANCH||'master',appearance:{footer:env.FOOTER_TEXT||'',clarityId:env.CLARITY_ID||''},initialized:!!await env.CONTENT.head('auth/account.json')}));
      if(request.method==='GET'&&(path==='/'||path==='/app.js'||path==='/preview.worker.js'||path==='/style.css'||path==='/blog_wasm.js'||path==='/blog_wasm_bg.wasm')) {
        const asset=ASSETS[path];if(!asset) throw new HttpError(404,'Not found');
        const headers={'Content-Type':asset.type,'ETag':asset.etag,'Cache-Control':path==='/'?'no-store':'public, max-age=0, must-revalidate'};
        const validators=request.headers.get('If-None-Match')?.split(',').map(tag=>tag.trim().replace(/^W\//,''));
        if(path!=='/'&&validators?.some(tag=>tag===asset.etag||tag==='*')) return protect(new Response(null,{status:304,headers}),true);
        return protect(new Response(Buffer.from(asset.data,'base64'),{headers}),true);
      }
      const internal=await internalRoute(request,env,path);if(internal) return protect(internal);
      const auth=await authRoute(request,env,path);if(auth) return protect(auth);
      if(path.startsWith('/api/')) {
        const session=await requireSession(request,env);return protect(await apiRoute(request,env,path,session));
      }
      throw new HttpError(404,'页面不存在。');
    } catch(e) {
      if(e instanceof HttpError) return protect(json({error:e.message},e.status));
      console.error(JSON.stringify({event:'request_failed',type:e instanceof Error?e.name:'unknown'}));
      return protect(json({error:'操作未完成，请稍后重试。'},500));
    }
  }
} satisfies ExportedHandler<Env>;

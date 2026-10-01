import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
const origin=process.env.BLOG_ADMIN_URL;
const token=process.env.BLOG_BUILD_TOKEN;
if(!origin||!token)throw new Error('BLOG_ADMIN_URL and BLOG_BUILD_TOKEN must be configured in Pages.');
const response=await fetch(new URL('/internal/bundle',origin),{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60_000)});
if(!response.ok)throw new Error(`Content download failed (${response.status}).`);
const reader=response.body.getReader();const chunks=[];let size=0;
for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16_000_000){await reader.cancel();throw new Error('Content bundle is too large.');}chunks.push(value);}
const bundle=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(bundle.schema_version!==1||!bundle.id||!bundle.site||!bundle.markdown_posts||!Array.isArray(bundle.legacy_posts)||!bundle.assets)throw new Error('Invalid content bundle.');
const input=resolve(process.env.BLOG_CONTENT_ROOT||'build-work/content'),output=resolve(process.env.BLOG_OUTPUT_ROOT||'build-work/public');
if(input===output||!relative(resolve('build-work'),input)||!relative(resolve('build-work'),output)||relative(resolve('build-work'),input).startsWith('..')||relative(resolve('build-work'),output).startsWith('..'))throw new Error('Build directories must be children of build-work.');
await rm(input,{recursive:true,force:true});await rm(output,{recursive:true,force:true});await mkdir(resolve(input,'posts'),{recursive:true});await mkdir(output,{recursive:true});
function child(root,path){const target=resolve(root,path),rel=relative(root,target);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe content path.');return target;}
for(const [slug,source]of Object.entries(bundle.markdown_posts)){if(!/^[A-Za-z0-9_-]{1,100}$/.test(slug)||typeof source!=='string')throw new Error('Invalid article source.');await writeFile(child(resolve(input,'posts'),slug+'.md'),source);}
const allowed=['title','bigTitle','subtitle','author','description'];
const site=allowed.filter(k=>bundle.site[k]!==undefined).map(k=>{if(typeof bundle.site[k]!=='string')throw new Error('Invalid site configuration.');return `${k} = ${JSON.stringify(bundle.site[k])}`;}).join('\n');
await writeFile(resolve(input,'site.toml'),site);await writeFile(resolve(input,'legacy-posts.json'),JSON.stringify(bundle.legacy_posts));
if(bundle.about_html)await writeFile(resolve(input,'about.html'),bundle.about_html);
for(const [path,encoded]of Object.entries(bundle.assets)){if(typeof encoded!=='string')throw new Error('Invalid asset.');const target=child(resolve(input,'static'),path);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,Buffer.from(encoded,'base64'));}
await writeFile(resolve(output,'_release.json'),JSON.stringify({id:bundle.id,created_at:bundle.created_at}));
await writeFile(resolve('build-work/release-id.json'),JSON.stringify({id:bundle.id}));
console.log(`Downloaded published content: ${Object.keys(bundle.markdown_posts).length} Markdown articles and ${bundle.legacy_posts.length} archived articles.`);

import { zipSync, strToU8 } from 'fflate';
import hljs from 'highlight.js/lib/common';

const $=id=>document.getElementById(id);
const fields=['title','description','date','slug','body'];
let csrf='',posts=[],site=null,doc=null,legacySlug='',dirty=0,savedVersion=0,conflict=false,savePromise=null,autosaveTimer=null,previewTimer=null,previewVersion=0,wasmPromise=null,settingsEtag=null;
let setupToken=new URLSearchParams(location.hash.slice(1)).get('setup')||'';
if(setupToken) history.replaceState(null,'',location.pathname);
const imageCache=new Map();
let noticeTimer;
function notice(message){$('notice').textContent=message;$('notice').classList.add('visible');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').classList.remove('visible'),6500);}
async function api(path,options={}){
  const headers=new Headers(options.headers);
  if(options.body && !(options.body instanceof FormData)){headers.set('Content-Type','application/json');options.body=JSON.stringify(options.body);}
  if(options.method && options.method!=='GET')headers.set('X-CSRF-Token',csrf);
  const response=await fetch(path,{...options,headers,credentials:'same-origin'});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'操作未完成。');error.status=response.status;if(response.status===401&&path!=='/api/login')showLogin();throw error;}
  return data;
}
function showLogin(){clearTimeout(autosaveTimer);$('app-view').hidden=true;$('login-view').hidden=false;csrf='';imageCache.clear();}
function view(name){for(const id of ['home','editor','legacy','settings'])$(`${id}-view`).hidden=id!==name;$('workspace-title').textContent={home:'文章管理',editor:'写作与预览',legacy:'导入文章原稿',settings:'网站设置'}[name];}
async function signedIn(session){csrf=session.csrf;setupToken='';$('login-view').hidden=true;$('app-view').hidden=false;$('account-email').textContent=session.email;await refresh();view('home');}
if(setupToken){$('login-title').textContent='设置你的登录密码';$('login-description').textContent='为你的写作空间设置一个至少 12 个字符的密码。';$('login-submit').textContent='设置密码并进入后台';$('confirm-row').hidden=false;$('login-form').elements.email.readOnly=true;$('login-form').elements.password.autocomplete='new-password';$('login-form').elements.password.minLength=12;}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;$('login-error').textContent='';if(setupToken&&form.elements.password.value!==form.elements.confirm.value){$('login-error').textContent='两次输入的密码不一致。';return;}$('login-submit').disabled=true;try{await signedIn(await api(setupToken?'/api/setup':'/api/login',{method:'POST',headers:setupToken?{Authorization:`Bearer ${setupToken}`}:{},body:{email:form.elements.email.value,password:form.elements.password.value}}));form.reset();}catch(error){$('login-error').textContent=error.message;}finally{$('login-submit').disabled=false;}});
if(!setupToken)api('/api/session').then(signedIn).catch(()=>{});

function badge(post){return post.legacy?'待导入原稿':post.published?(post.changed?'有未发布修改':'已发布'):'草稿';}
function renderLists(){
  const query=$('search').value.trim().toLowerCase();const sorted=[...posts].sort((a,b)=>b.date.localeCompare(a.date));
  $('post-count').textContent=posts.length;$('summary').textContent=`${posts.filter(p=>p.published).length} 篇已发布 · ${posts.filter(p=>!p.published).length} 篇草稿`;
  $('post-list').replaceChildren();$('article-grid').replaceChildren();
  for(const post of sorted){
    if(query&&!`${post.title} ${post.description} ${post.slug}`.toLowerCase().includes(query))continue;
    const button=document.createElement('button');button.className='post-item'+(doc?.front_matter.slug===post.slug?' active':'');
    const title=document.createElement('span');title.textContent=post.title;const small=document.createElement('small');small.textContent=`${post.date} · ${badge(post)}`;button.append(title,small);button.addEventListener('click',()=>openPost(post.slug).catch(error=>notice(error.message)));$('post-list').append(button);
    const card=document.createElement('button');card.className='article-card';const tag=document.createElement('span');tag.className='badge'+(post.legacy?' legacy':post.changed||!post.published?' draft':'');tag.textContent=badge(post);const h=document.createElement('h3');h.textContent=post.title;const p=document.createElement('p');p.textContent=post.description||'没有摘要';const date=document.createElement('small');date.textContent=post.date;card.append(tag,h,p,date);card.addEventListener('click',()=>openPost(post.slug).catch(error=>notice(error.message)));$('article-grid').append(card);
  }
  if(!posts.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='还没有文章，从新建或导入原稿开始。';$('article-grid').append(empty);}
}
async function refresh(){const data=await api('/api/posts');posts=data.posts;site=data.site;renderLists();showPublishing(data.publishing);$('deployment-state').textContent=data.deployment.configured?'发布连接已配置。':'尚未连接发布服务，请完成下面的首次设置。';$('deployment-help').open=!data.deployment.configured;}
function currentDraft(){return {front_matter:{title:$('title').value,slug:$('slug').value,date:$('date').value,description:$('description').value,draft:true,...(doc?.front_matter.updated?{updated:doc.front_matter.updated}:{})},body_markdown:$('body').value};}
async function engine(){if(!wasmPromise)wasmPromise=import('/blog_wasm.js').then(async m=>{await m.default({module_or_path:'/blog_wasm_bg.wasm'});return m;});return wasmPromise;}
function markdownSource(draft){const f=draft.front_matter;const quote=s=>JSON.stringify(s);return `+++\ntitle = ${quote(f.title)}\nslug = ${quote(f.slug)}\ndate = ${quote(f.date)}\ndescription = ${quote(f.description)}\ndraft = ${!!f.draft}\n${f.updated?`updated = ${quote(f.updated)}\n`:''}+++\n\n${draft.body_markdown}`;}
async function preview(){
  if(!doc||$('editor-view').hidden)return;const version=++previewVersion;
  try{
    const wasm=await engine();const draft=currentDraft();draft.front_matter.title ||= '未命名文章';draft.front_matter.slug ||= 'preview';
    const html=wasm.render_preview(JSON.stringify({config:site,draft}));
    const page=new DOMParser().parseFromString(html,'text/html');
    page.querySelectorAll('script,base,iframe,object,embed,form,meta[http-equiv]').forEach(n=>n.remove());
    page.querySelectorAll('link[href^="/styles.css"]').forEach(n=>n.remove());
    const style=page.createElement('style');style.textContent=wasm.stylesheet();page.head.append(style);
    const highlight=page.createElement('link');highlight.rel='stylesheet';highlight.href='https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css';page.head.append(highlight);
    page.querySelectorAll('pre code').forEach(node=>{try{hljs.highlightElement(node);}catch{}});
    const previewStyle=page.createElement('style');previewStyle.textContent='header nav,footer,.share-container{display:none!important}body .site{max-width:100%!important;padding:0 22px!important}.article-shell{padding-top:18px!important}';page.head.append(previewStyle);
    const images=[...page.querySelectorAll('img')];
    await Promise.all(images.map(async image=>{const src=image.getAttribute('src')||'';if(src.startsWith('https://img.forimagine.eu.org/')){const key=decodeURIComponent(src.slice('https://img.forimagine.eu.org/'.length));try{if(!imageCache.has(key)){const response=await fetch(`/api/image?key=${encodeURIComponent(key)}`);if(!response.ok)throw new Error('image');const blob=await response.blob();if(blob.size>10*1024*1024)throw new Error('image');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});if(imageCache.size>=20)imageCache.delete(imageCache.keys().next().value);imageCache.set(key,data);}image.src=imageCache.get(key);}catch{image.alt=`图片暂时无法预览：${image.alt}`;image.removeAttribute('src');}}else if(src.startsWith('/'))image.src='https://forimagine.eu.org'+src;}));
    page.querySelectorAll('a').forEach(a=>{a.removeAttribute('href');a.style.cursor='default';});
    if(version!==previewVersion)return;$('preview-frame').srcdoc='<!doctype html>'+page.documentElement.outerHTML;$('preview-loading').hidden=true;
  }catch(error){if(version===previewVersion){$('preview-loading').hidden=false;$('preview-loading').textContent='预览未完成：'+String(error);}}
}
function fillEditor(draft,etag){doc={...draft,etag};dirty=0;savedVersion=0;conflict=false;$('title').value=draft.front_matter.title;$('description').value=draft.front_matter.description;$('date').value=draft.front_matter.date;$('slug').value=draft.front_matter.slug;$('slug').readOnly=!!etag||posts.some(p=>p.slug===draft.front_matter.slug&&p.published);$('body').value=draft.body_markdown;$('save-state').textContent=etag?'草稿已保存':'尚未保存草稿';const published=posts.some(p=>p.slug===draft.front_matter.slug&&p.published);$('unpublish-post').hidden=!published;$('delete-post').hidden=published;view('editor');renderLists();wordCount();void preview();}
function wordCount(){$('word-count').textContent=`${$('body').value.replace(/\s/g,'').length.toLocaleString()} 个字符`;} 
function changed(){if(!doc)return;dirty++;$('save-state').textContent='有未保存的修改';wordCount();clearTimeout(autosaveTimer);if(!conflict)autosaveTimer=setTimeout(()=>saveCurrent().catch(error=>notice(error.message)),1500);clearTimeout(previewTimer);previewTimer=setTimeout(()=>void preview(),350);}
fields.forEach(id=>$(id).addEventListener('input',changed));
async function saveCurrent(){
  clearTimeout(autosaveTimer);if(!doc||$('editor-view').hidden)return;
  if(conflict)throw new Error('当前内容与云端冲突，请先下载原稿，再重新打开文章。');
  if(savePromise){await savePromise;if(dirty>savedVersion)return saveCurrent();return;}
  if(dirty===savedVersion&&doc.etag)return;
  const captured=currentDraft();if(!captured.front_matter.title.trim()){ $('save-state').textContent='填写标题后自动保存';return; }
  const version=dirty;const slug=captured.front_matter.slug;$('save-state').textContent='正在保存到云端…';
  savePromise=api(`/api/posts/${encodeURIComponent(slug)}`,{method:'PUT',body:{draft:captured,etag:doc.etag||null}}).then(async result=>{doc.etag=result.etag;doc.front_matter.slug=slug;$('slug').readOnly=true;savedVersion=version;$('save-state').textContent=dirty===version?'已保存到云端':'正在等待保存最新修改…';if(dirty!==version)autosaveTimer=setTimeout(()=>saveCurrent().catch(error=>notice(error.message)),500);await refresh();}).catch(error=>{if(error.status===409)conflict=true;$('save-state').textContent=error.status===409?'版本冲突，请下载原稿后重新打开':'保存失败，请重试';throw error;}).finally(()=>{savePromise=null;});
  await savePromise;
}
async function flush(){if(doc&&!$('editor-view').hidden){await saveCurrent();if(dirty>savedVersion)throw new Error('请先填写文章标题并保存，或下载当前原稿。');}}
async function openPost(slug){await flush();clearTimeout(autosaveTimer);const data=await api(`/api/posts/${slug}`);if(data.legacy){doc=null;legacySlug=slug;view('legacy');$('legacy-title').textContent=data.front_matter.title;$('legacy-link').href=`https://forimagine.eu.org/posts/${slug}/`;renderLists();}else fillEditor(data.draft,data.etag);}
async function newPost(){await flush();const today=new Date().toISOString().slice(0,10);fillEditor({front_matter:{title:'',slug:`post-${today.replaceAll('-','')}-${crypto.randomUUID().slice(0,8)}`,date:today,description:'',draft:true},body_markdown:''},null);$('title').focus();}
for(const id of ['new-post','home-new'])$(id).addEventListener('click',()=>newPost().catch(error=>notice(error.message)));
$('search').addEventListener('input',renderLists);
document.querySelector('.brand').addEventListener('click',async e=>{e.preventDefault();try{await flush();doc=null;view('home');renderLists();}catch(error){notice(error.message);}});
$('save-post').addEventListener('click',()=>saveCurrent().catch(error=>notice(error.message)));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void saveCurrent().catch(error=>notice(error.message));}});
window.addEventListener('beforeunload',e=>{if(dirty>savedVersion&&doc){e.preventDefault();e.returnValue='';}});
$('show-preview').addEventListener('click',()=>{$('editor-panes').classList.add('preview-only');$('show-preview').classList.add('active');$('show-writing').classList.remove('active');});
$('show-writing').addEventListener('click',()=>{$('editor-panes').classList.remove('preview-only');$('show-writing').classList.add('active');$('show-preview').classList.remove('active');});
function download(data,name,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([data],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download-post').addEventListener('click',()=>{if(doc)download(markdownSource(currentDraft()),`${$('slug').value}.md`,'text/markdown');});
function showPublishing(state){const banner=$('publish-banner');banner.hidden=!state;if(!state)return;banner.classList.toggle('failed',state.status==='failed');banner.textContent={queued:'发布已提交，正在等待 Cloudflare 构建。草稿仍可继续编辑。',building:'正在生成网站，完成部署后这里会显示“已上线”。',built:'网页已生成，正在等待 Cloudflare 部署上线。',deployed:'最新发布已上线。',failed:state.error||'发布失败，草稿已保留，可以重试。'}[state.status]||'发布进行中';const busy=['queued','building','built'].includes(state.status);$('publish-post').disabled=busy;$('publish-settings').disabled=busy;}
async function startPublish(data){const result=await api('/api/publish',{method:'POST',body:data});showPublishing(result);notice('发布已提交，完成后会自动显示状态。');}
$('publish-post').addEventListener('click',async()=>{if(!doc)return;const inputs=fields.map($);inputs.forEach(x=>x.readOnly=true);$('publish-post').disabled=true;try{await saveCurrent();if(!doc.etag||dirty>savedVersion||!$('title').value.trim())throw new Error('请先填写文章标题并保存最新内容。');await startPublish({slug:doc.front_matter.slug,etag:doc.etag});}catch(error){notice(error.message);$('publish-post').disabled=false;}finally{inputs.forEach(x=>x.readOnly=false);$('slug').readOnly=true;}});
async function unpublish(slug){if(!confirm('取消发布后，这篇文章将从网站移除。已有原稿和历史版本会保留。继续吗？'))return;await startPublish({unpublish:slug});}
$('unpublish-post').addEventListener('click',()=>unpublish(doc.front_matter.slug).catch(error=>notice(error.message)));
$('legacy-unpublish').addEventListener('click',()=>unpublish(legacySlug).catch(error=>notice(error.message)));
$('delete-post').addEventListener('click',async()=>{if(!doc||!confirm('删除这份草稿？历史版本仍会保留。'))return;try{await flush();await api(`/api/posts/${doc.front_matter.slug}`,{method:'DELETE',body:{etag:doc.etag}});doc=null;dirty=0;savedVersion=0;view('home');await refresh();}catch(error){notice(error.message);}});
setInterval(async()=>{if(!csrf)return;try{const state=await api('/api/publish/status');showPublishing(state);if(state?.status==='deployed'&&posts.some(p=>p.changed))await refresh();}catch{}},6000);

async function upload(file){const form=new FormData();form.append('file',file);const result=await api('/api/upload',{method:'POST',body:form});const textarea=$('body');const name=file.name.replace(/[\[\]\\\n\r]/g,'');const text=`\n![${name}](${result.url})\n`;const start=textarea.selectionStart,end=textarea.selectionEnd;textarea.setRangeText(text,start,end,'end');textarea.focus();changed();}
$('upload-image').addEventListener('click',()=>$('image-files').click());
$('image-files').addEventListener('change',async e=>{const files=[...e.target.files];$('upload-image').disabled=true;try{for(const file of files)await upload(file);}catch(error){notice(error.message);}finally{e.target.value='';$('upload-image').disabled=false;}});
$('body').addEventListener('paste',async e=>{const images=[...e.clipboardData.items].filter(x=>x.kind==='file'&&x.type.startsWith('image/'));if(!images.length)return;e.preventDefault();try{for(const item of images){const file=item.getAsFile();if(file)await upload(file);}}catch(error){notice(error.message);}});
$('body').addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
$('body').addEventListener('drop',async e=>{const images=[...e.dataTransfer.files].filter(x=>x.type.startsWith('image/'));if(!images.length)return;e.preventDefault();try{for(const file of images)await upload(file);}catch(error){notice(error.message);}});
for(const id of ['import-posts','legacy-import'])$(id).addEventListener('click',()=>$('import-files').click());
$('import-files').addEventListener('change',async e=>{try{await flush();const wasm=await engine();let count=0;for(const file of e.target.files){const source=await file.text(),draft=JSON.parse(wasm.parse_markdown(source));const existing=posts.find(p=>p.slug===draft.front_matter.slug);if(existing?.has_draft&&!confirm(`“${draft.front_matter.title}”已经有在线草稿。用这个文件替换吗？`))continue;const old=existing?.has_draft?await api(`/api/posts/${draft.front_matter.slug}`):null;await api(`/api/posts/${draft.front_matter.slug}`,{method:'PUT',body:{source,etag:old?.etag||null}});count++;}await refresh();notice(`已导入 ${count} 篇原稿，作为草稿保存。需要点击发布才能更新线上内容。`);}catch(error){notice(error.message);}finally{e.target.value='';}});
$('export-posts').addEventListener('click',async()=>{try{await flush();const backup=await api('/api/export'),files={};for(const [path,source]of Object.entries(backup.files))files[path==='site.toml'?'site.json':path]=strToU8(source);files['archived-pages.json']=strToU8(JSON.stringify(backup.legacy_posts,null,2));download(zipSync(files),`r-blog-backup-${new Date().toISOString().slice(0,10)}.zip`,'application/zip');notice('原稿和已归档页面已导出。图片保存在 R2 图片桶。');}catch(error){notice(error.message);}});
$('settings').addEventListener('click',async()=>{try{await flush();const data=await api('/api/settings');settingsEtag=data.etag;for(const [key,value]of Object.entries(data.site))if($('site-form').elements[key])$('site-form').elements[key].value=value;for(const key of ['bigTitle'])if(!data.site[key])$('site-form').elements[key].value='';$('deployment-state').textContent=data.deployment.configured?'发布连接已配置，可随时替换。':'尚未连接发布服务，请完成首次设置。';$('deployment-help').open=!data.deployment.configured;view('settings');}catch(error){notice(error.message);}});
$('site-form').addEventListener('submit',async e=>{e.preventDefault();try{const values=Object.fromEntries(new FormData(e.currentTarget));const data=await api('/api/settings',{method:'PUT',body:{site:values,etag:settingsEtag}});settingsEtag=data.etag;notice('网站信息已保存，点击发布后上线。');}catch(error){notice(error.message);}});
$('publish-settings').addEventListener('click',async()=>{try{const values=Object.fromEntries(new FormData($('site-form')));const saved=await api('/api/settings',{method:'PUT',body:{site:values,etag:settingsEtag}});settingsEtag=saved.etag;await startPublish({settings:true});}catch(error){notice(error.message);}});
$('deployment-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/settings/deployment',{method:'PUT',body:{url:e.currentTarget.elements.url.value}});e.currentTarget.reset();$('deployment-state').textContent='发布连接已配置。';$('deployment-help').open=false;notice('发布连接已保存。');}catch(error){notice(error.message);}});
$('password-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;if(form.elements.password.value!==form.elements.confirm.value){notice('两次新密码不一致。');return;}try{const data=await api('/api/password',{method:'POST',body:{current_password:form.elements.current_password.value,password:form.elements.password.value}});csrf=data.csrf;form.reset();notice('密码已更新，其他设备需要重新登录。');}catch(error){notice(error.message);}});
$('logout').addEventListener('click',async()=>{try{await flush();await api('/api/logout',{method:'POST',body:{}});doc=null;dirty=0;savedVersion=0;showLogin();}catch(error){notice(error.message);}});
$('history-post').addEventListener('click',async()=>{try{await flush();const versions=await api(`/api/history/${doc.front_matter.slug}`);$('history-list').replaceChildren();for(const item of versions){const button=document.createElement('button');button.textContent=new Date(item.saved_at).toLocaleString();const span=document.createElement('span');span.textContent='恢复为草稿';button.append(span);button.addEventListener('click',async()=>{if(!confirm('将此历史版本恢复为草稿？当前版本也已保存在历史记录中。'))return;try{const previous=await api(`/api/history/${doc.front_matter.slug}?key=${encodeURIComponent(item.key)}`);const etag=doc.etag;fillEditor(previous.draft,etag);changed();await saveCurrent();$('history-dialog').close();notice('已恢复为草稿，线上内容未改变。');}catch(error){notice(error.message);}});$('history-list').append(button);}if(!versions.length)$('history-list').textContent='还没有保存过的历史版本。';$('history-dialog').showModal();}catch(error){notice(error.message);}});
$('close-history').addEventListener('click',()=>$('history-dialog').close());

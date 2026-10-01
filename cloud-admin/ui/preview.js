const frame=document.getElementById('preview-frame');
const loading=document.getElementById('preview-loading');
const imageCache=new Map();
let worker=null,nextId=0,generation=0,desired=null,running=false;
const tasks=new Map();
let siteURL='',imageOrigin='';
export function configurePreview(config){siteURL=new URL(config.siteUrl).origin;imageOrigin=new URL(config.imageOrigin).origin;}
function resetWorker(error){worker?.terminate();worker=null;for(const {reject,timer}of tasks.values()){clearTimeout(timer);reject(error);}tasks.clear();}
export function engineTask(type,payload={}){
  if(!worker){worker=new Worker('/preview.worker.js',{type:'module'});worker.onmessage=({data})=>{const task=tasks.get(data.id);if(!task)return;tasks.delete(data.id);clearTimeout(task.timer);data.error?task.reject(new Error(data.error)):task.resolve(data.result);};worker.onerror=()=>resetWorker(new Error('预览引擎未能加载，请重试。'));}
  return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>resetWorker(new Error('预览处理超时，请缩短内容后重试。')),45000);tasks.set(id,{resolve,reject,timer});worker.postMessage({id,type,...payload});});
}
export function invalidatePreview(clear=false){generation++;desired=null;if(clear){frame.onload=null;frame.srcdoc='';loading.hidden=false;loading.textContent='正在准备预览…';}}
export function disposePreview(){invalidatePreview(true);resetWorker(new Error('已退出登录'));for(const value of imageCache.values())value.then(url=>URL.revokeObjectURL(url)).catch(()=>{});imageCache.clear();}
async function imageURL(key){
  if(!imageCache.has(key)){
    const promise=(async()=>{const response=await fetch(`/api/image?key=${encodeURIComponent(key)}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('图片读取失败');const blob=await response.blob();if(blob.size>10*1024*1024)throw new Error('图片太大');return URL.createObjectURL(blob);})();
    imageCache.set(key,promise);promise.catch(()=>{if(imageCache.get(key)===promise)imageCache.delete(key);});
    if(imageCache.size>20){const oldest=imageCache.keys().next().value;imageCache.get(oldest).then(url=>URL.revokeObjectURL(url)).catch(()=>{});imageCache.delete(oldest);}
  }
  return imageCache.get(key);
}
async function hydrateImages(version){
  const images=[...frame.contentDocument.querySelectorAll('img[data-r2-key]')];
  // Only three downloads at a time, and never block displaying the article text.
  await Promise.all(Array.from({length:Math.min(3,images.length)},async()=>{
    while(images.length&&version===generation){const image=images.shift();try{const url=await imageURL(image.dataset.r2Key);if(version===generation&&image.isConnected){image.src=url;image.removeAttribute('data-r2-key');}}catch{if(version===generation){image.alt=`图片暂时无法预览：${image.alt}`;image.classList.add('image-error');}}}
  }));
}
export function renderPreview(draft,config){desired={draft,config,version:++generation};void pump();}
async function pump(){
  if(running||!desired)return;
  const job=desired;desired=null;running=true;
  try{
    const {html,css}=await engineTask('render',job);
    if(job.version!==generation)return;
    const page=new DOMParser().parseFromString(html,'text/html');
    page.querySelectorAll('script,base,iframe,object,embed,form,meta[http-equiv]').forEach(n=>n.remove());
    page.querySelectorAll('*').forEach(node=>{for(const attr of [...node.attributes])if(attr.name.startsWith('on'))node.removeAttribute(attr.name);});
    page.querySelectorAll('link[href^="/styles.css"]').forEach(n=>n.remove());
    const style=page.createElement('style');style.textContent=css+'\nheader nav,footer,.share-container{display:none!important}body .site{max-width:100%!important;padding:0 22px!important}.article-shell{padding-top:18px!important}img[data-r2-key]{display:block;min-height:60px;background:#e8e6dd}';page.head.append(style);
    const highlight=page.createElement('link');highlight.rel='stylesheet';highlight.href='https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css';page.head.append(highlight);
    page.querySelectorAll('img').forEach(image=>{const src=image.getAttribute('src')||'';let url;try{url=new URL(src,siteURL);}catch{return;}if(url.origin===imageOrigin){try{image.dataset.r2Key=decodeURIComponent(url.pathname.slice(1));}catch{image.alt='图片地址无效';}image.removeAttribute('src');image.removeAttribute('srcset');}else if(src.startsWith('/'))image.src=url.href;});
    page.querySelectorAll('a').forEach(a=>{a.removeAttribute('href');a.style.cursor='default';});
    // Scripts stay disabled by the sandbox. Same-origin lets the parent insert
    // authenticated images after the text is visible, without reloading the frame.
    frame.onload=()=>{if(job.version===generation){loading.hidden=true;void hydrateImages(job.version);}};
    frame.srcdoc='<!doctype html>'+page.documentElement.outerHTML;
    loading.hidden=true;
  }catch(error){if(job.version===generation){loading.hidden=false;loading.textContent='预览未完成：'+error.message;}}
  finally{running=false;if(desired)void pump();}
}

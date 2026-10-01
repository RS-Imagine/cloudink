import hljs from 'highlight.js/lib/common';
let engine;
async function wasm(){
  if(!engine) engine=import('/blog_wasm.js').then(async m=>{await m.default({module_or_path:'/blog_wasm_bg.wasm'});return m;}).catch(error=>{engine=null;throw error;});
  return engine;
}
function unescapeCode(text){return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",'#x27':"'"}[key]));}
self.onmessage=async({data})=>{
  try{
    const m=await wasm();let result;
    if(data.type==='parse') result=JSON.parse(m.parse_markdown(data.source));
    else if(data.type==='warm') result=true;
    else {
      let html=m.render_preview(JSON.stringify({config:data.config,draft:data.draft}));
      html=html.replace(/<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,(original,language,code)=>{
        if(!language||!hljs.getLanguage(language))return original;
        try{return `<pre><code class="hljs language-${language}">${hljs.highlight(unescapeCode(code),{language,ignoreIllegals:true}).value}</code></pre>`;}catch{return original;}
      });
      result={html,css:m.stylesheet()};
    }
    self.postMessage({id:data.id,result});
  }catch(error){self.postMessage({id:data.id,error:String(error)});}
};

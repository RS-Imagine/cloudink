let engine;
let highlighter;
const CODE_BLOCK_RE = /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;
async function wasm() {
  if (!engine)
    engine = import('/blog_wasm.js')
      .then(async (m) => {
        await m.default({ module_or_path: '/blog_wasm_bg.wasm' });
        return m;
      })
      .catch((error) => {
        engine = null;
        throw error;
      });
  return engine;
}
async function loadHighlighter() {
  if (!highlighter)
    highlighter = import('/preview-highlight.js')
      .then((m) => m.default || m)
      .catch((error) => {
        highlighter = null;
        throw error;
      });
  return highlighter;
}
function unescapeCode(text) {
  return text.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[key],
  );
}
async function highlightPreviewHtml(html) {
  if (!/<pre><code class="language-[^"]+">/.test(html)) return html;
  let hljs;
  try {
    hljs = await loadHighlighter();
  } catch {
    return html;
  }
  return html.replace(CODE_BLOCK_RE, (original, language, code) => {
    if (!language || !hljs.getLanguage(language)) return original;
    try {
      return `<pre><code class="hljs language-${language}">${hljs.highlight(unescapeCode(code), { language, ignoreIllegals: true }).value}</code></pre>`;
    } catch {
      return original;
    }
  });
}
self.onmessage = async ({ data }) => {
  try {
    const m = await wasm();
    let result;
    if (data.type === 'import') result = JSON.parse(m.import_markdown(JSON.stringify(data)));
    else if (data.type === 'parse') result = JSON.parse(m.parse_markdown(data.source));
    else if (data.type === 'site')
      result = JSON.parse(
        m.render_release(JSON.stringify({ ...data.release, render_paths: data.paths })),
      );
    else if (data.type === 'warm') result = true;
    else {
      const rendered = m.render_preview(JSON.stringify({ config: data.config, draft: data.draft }));
      const html = await highlightPreviewHtml(rendered);
      result = { html, css: m.stylesheet() };
    }
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};

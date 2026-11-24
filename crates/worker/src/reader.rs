use std::cell::RefCell;
use std::rc::Rc;
use worker::js_sys::{Array, JSON, JsString, Object, Reflect, RegExp};
use worker::wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Headers, Response, ResponseInit, Url};

use crate::html_rewriter::{Element, HtmlRewriter, JsResult, string_response};

thread_local! {
    static ENTITY: RegExp = RegExp::new(r"&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);", "gi");
    static ESCAPE: RegExp = RegExp::new(r#"[&<>"']"#, "g");
    static SPACE: RegExp = RegExp::new(r"\s+", "");
    static LEGACY_SCRIPT: RegExp = RegExp::new(
        r"^https://cdn\.jsdelivr\.net/gh/highlightjs/cdn-release@[^/]+/build/highlight(?:\.min)?\.js(?:[?#]|$)", "",
    );
    static LEGACY_STYLE: RegExp = RegExp::new(
        r"^https://cdn\.jsdelivr\.net/(?:npm/katex@[^/]+/dist/katex(?:\.min)?\.css|gh/highlightjs/cdn-release@[^/]+/build/styles/github(?:-dark)?(?:\.min)?\.css)(?:[?#]|$)", "",
    );
    static DECODE_ENTITY: Closure<dyn FnMut(JsString, JsString) -> JsString> =
        Closure::new(decode_entity);
    static ESCAPE_CHAR: Closure<dyn FnMut(JsString) -> JsString> = Closure::new(escape_char);
}

struct Metadata {
    title: JsString,
    description: JsString,
    author: JsString,
    site: JsString,
    image: String,
    image_alt: JsString,
    images: usize,
    has_math: bool,
    has_code: bool,
}

impl Metadata {
    fn new() -> Self {
        Self {
            title: "".into(),
            description: "".into(),
            author: "".into(),
            site: "".into(),
            image: String::new(),
            image_alt: "".into(),
            images: 0,
            has_math: false,
            has_code: false,
        }
    }

    fn tags(
        &self,
        canonical: &str,
        is_post: bool,
        status: u16,
        apple_icon: Option<&str>,
        fallback_image: Option<&str>,
    ) -> JsResult<JsString> {
        let title = decode(&self.title).trim();
        let description = decode(&self.description);
        let author = decode(&self.author);
        let site = decode(&self.site).trim();
        let has_article_image = !self.image.is_empty();
        let share_image: JsString = if has_article_image {
            self.image.as_str()
        } else {
            fallback_image.unwrap_or_default()
        }
        .into();
        let share_alt = if has_article_image {
            decode(&self.image_alt)
        } else if site.length() != 0 {
            site.clone()
        } else {
            title.clone()
        };
        let canonical: JsString = canonical.into();
        let tags = Array::new();
        if self.has_math {
            tags.push(&r#"<link rel="stylesheet" data-reader-style="math" href="/reader-assets/katex.css">"#.into());
        }
        if self.has_code {
            tags.push(&r#"<link rel="stylesheet" media="print" data-reader-style="code" data-reader-async="style" href="/reader-assets/code.css">"#.into());
        }
        if let Some(apple) = apple_icon {
            push_tag(
                &tags,
                r#"<link rel="apple-touch-icon" sizes="180x180" href=""#,
                &apple.into(),
            );
        }
        let og_type: JsString = if is_post { "article" } else { "website" }.into();
        let twitter_card: JsString = if has_article_image {
            "summary_large_image"
        } else {
            "summary"
        }
        .into();
        for (prefix, value) in [
            (r#"<link rel="canonical" href=""#, &canonical),
            (r#"<meta property="og:url" content=""#, &canonical),
            (r#"<meta property="og:title" content=""#, &title),
            (r#"<meta property="og:description" content=""#, &description),
            (r#"<meta property="og:site_name" content=""#, &site),
            (r#"<meta property="og:type" content=""#, &og_type),
            (r#"<meta name="twitter:card" content=""#, &twitter_card),
            (r#"<meta name="twitter:title" content=""#, &title),
            (
                r#"<meta name="twitter:description" content=""#,
                &description,
            ),
        ] {
            push_tag(&tags, prefix, value);
        }
        if share_image.length() != 0 {
            for (prefix, value) in [
                (r#"<meta property="og:image" content=""#, &share_image),
                (r#"<meta property="og:image:alt" content=""#, &share_alt),
                (r#"<meta name="twitter:image" content=""#, &share_image),
                (r#"<meta name="twitter:image:alt" content=""#, &share_alt),
            ] {
                push_tag(&tags, prefix, value);
            }
        }
        if status == 200 {
            let data = Object::new();
            let schema_type: JsString = if is_post { "BlogPosting" } else { "WebPage" }.into();
            for (key, value) in [
                ("@context", &"https://schema.org".into()),
                ("@type", &schema_type),
                ("url", &canonical),
                ("name", &title),
                ("headline", &title),
                ("description", &description),
            ] {
                Reflect::set(&data, &key.into(), value.as_ref())?;
            }
            if author.length() != 0 {
                let person = Object::new();
                Reflect::set(&person, &"@type".into(), &"Person".into())?;
                Reflect::set(&person, &"name".into(), author.as_ref())?;
                Reflect::set(&data, &"author".into(), person.as_ref())?;
            }
            if share_image.length() != 0 {
                Reflect::set(
                    &data,
                    &"image".into(),
                    Array::of1(share_image.as_ref()).as_ref(),
                )?;
            }
            Reflect::set(&data, &"mainEntityOfPage".into(), canonical.as_ref())?;
            // Keep markup such as </script> in author data from ending this element.
            let data = JSON::stringify(&data)?.replace_all("<", "\\u003c");
            let script = JsString::from(r#"<script type="application/ld+json">"#)
                .concat(data.as_ref())
                .concat(&"</script>".into());
            tags.push(script.as_ref());
        } else {
            tags.push(&r#"<meta name="robots" content="noindex">"#.into());
        }
        Ok(tags.join("\n"))
    }
}

pub async fn render(
    response: Response,
    url: Url,
    analytics: bool,
    apple_icon: Option<String>,
    fallback_icon: Option<String>,
) -> JsResult<Response> {
    let status = response.status();
    let origin = url.origin();
    let path = url.pathname();
    let path = path
        .strip_suffix("/index.html")
        .map_or(path.clone(), |prefix| format!("{prefix}/"));
    let canonical = Url::new_with_base(&path, &origin)?;
    if RegExp::new(
        r"^/(about|archive|post|post/page/[1-9]\d*|posts/[A-Za-z0-9_-]+)$",
        "",
    )
    .test(&path)
    {
        canonical.set_pathname(&format!("{}/", canonical.pathname()));
    }
    let is_post = RegExp::new(r"^/posts/[A-Za-z0-9_-]+/$", "").test(&canonical.pathname());

    let meta = Rc::new(RefCell::new(Metadata::new()));
    let rewriter = HtmlRewriter::new();
    let page = url.href();
    let image_origin = origin.clone();
    rewriter.on_element("img, source", move |el| {
        normalize_image_urls(el, &image_origin)
    })?;
    rewriter.on_element(r#"script[src="/analytics.js"]"#, move |el| {
        if !analytics {
            el.remove()?;
        }
        Ok(())
    })?;
    rewriter.on_element("script[src]", |el| {
        let src = attribute(&el, "src").as_string().unwrap_or_default();
        if LEGACY_SCRIPT.with(|pattern| pattern.test(&src)) {
            el.remove()?;
        }
        Ok(())
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_element(".article-body .katex", move |_| {
        state.borrow_mut().has_math = true;
        Ok(())
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_element(".article-body pre code, #swup pre code", move |_| {
        state.borrow_mut().has_code = true;
        Ok(())
    })?;
    rewriter.on_element("head link", rewrite_styles)?;
    let state = Rc::clone(&meta);
    rewriter.on_text("head title", move |text| {
        let mut data = state.borrow_mut();
        data.title = data.title.concat(text.text().as_ref());
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_element(r#"head meta[name="description"]"#, move |el| {
        state.borrow_mut().description = attribute(&el, "content");
        Ok(())
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_element(r#"head meta[name="author"]"#, move |el| {
        state.borrow_mut().author = attribute(&el, "content");
        Ok(())
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_text(".site-brand .site-title, .site-brand h1", move |text| {
        let mut data = state.borrow_mut();
        data.site = data.site.concat(text.text().as_ref());
    })?;
    let state = Rc::clone(&meta);
    rewriter.on_element(".article-body img", move |el| {
        reader_image(el, &page, &mut state.borrow_mut())
    })?;
    rewriter.on_element(
        r#"head link[rel="canonical"],head link[rel="apple-touch-icon"],head meta[property^="og:"],head meta[name^="twitter:"],head script[type="application/ld+json"]"#,
        |el| el.remove(),
    )?;

    // Keep the full HTML document in the runtime. Only attributes and metadata cross into Rust.
    let html: JsString = JsFuture::from(rewriter.transform(&response)?.text()?)
        .await?
        .unchecked_into();
    let fallback_image = fallback_icon
        .map(|path| Url::new_with_base(&path, &origin).map(|url| url.href()))
        .transpose()?;
    let injected = meta.borrow().tags(
        &canonical.href(),
        is_post,
        status,
        apple_icon.as_deref(),
        fallback_image.as_deref(),
    )?;
    let headers = Headers::new_with_headers(&response.headers())?;
    headers.delete("Content-Length")?;
    if status != 200 {
        headers.set("X-Robots-Tag", "noindex")?;
    }
    let init = ResponseInit::new();
    init.set_status(status);
    init.set_headers_headers(&headers);

    let closing = RegExp::new(r"</head\s*>", "gi");
    let single_closing = html
        .match_(&closing)
        .is_some_and(|matches| matches.unchecked_ref::<Array>().length() == 1);
    if single_closing {
        let replace = Closure::<dyn FnMut(JsString) -> JsString>::new(move |matched: JsString| {
            injected.concat(matched.as_ref())
        });
        let output =
            html.replace_by_pattern_with_function(&closing, replace.as_ref().unchecked_ref());
        return string_response(&output, &init);
    }
    let fallback = HtmlRewriter::new();
    let options = Object::new();
    Reflect::set(&options, &"html".into(), &JsValue::TRUE)?;
    fallback.on_element("head", move |el| el.append(&injected, &options))?;
    fallback.transform(&string_response(&html, &init)?)
}

fn rewrite_styles(el: Element) -> JsResult<()> {
    let href = attribute(&el, "href").as_string().unwrap_or_default();
    let id = el.attribute("id").and_then(|id| id.as_string());
    let rel = el.attribute("rel").and_then(|rel| rel.as_string());
    if id.as_deref() == Some("reader-font-styles")
        && href == "/reader-assets/editorial-font.css"
        && rel.as_deref() == Some("stylesheet")
    {
        el.set_attribute("media", &"print".into())?;
        el.set_attribute("data-reader-async", &"style".into())?;
        return Ok(());
    }
    if el.has_attribute("data-reader-style")
        || matches!(id.as_deref(), Some("hljs-light" | "hljs-dark"))
        || LEGACY_STYLE.with(|pattern| pattern.test(&href))
        || (rel.as_deref() == Some("preconnect") && href == "https://cdn.jsdelivr.net")
    {
        el.remove()?;
    }
    Ok(())
}

fn reader_image(el: Element, page: &str, meta: &mut Metadata) -> JsResult<()> {
    meta.images += 1;
    el.set_attribute("decoding", &"async".into())?;
    if meta.images == 1 {
        el.set_attribute("loading", &"eager".into())?;
        el.set_attribute("fetchpriority", &"high".into())?;
    } else {
        el.set_attribute("loading", &"lazy".into())?;
        el.remove_attribute("fetchpriority")?;
    }
    if meta.image.is_empty()
        && let Some(src) = el.attribute("src").filter(|src| src.length() != 0)
        && let Some(src) = decode(&src).as_string()
        && let Ok(candidate) = Url::new_with_base(&src, page)
        && matches!(candidate.protocol().as_str(), "http:" | "https:")
    {
        meta.image = candidate.href();
        meta.image_alt = el
            .attribute("alt")
            .filter(|alt| alt.length() != 0)
            .unwrap_or_else(|| meta.title.clone());
    }
    Ok(())
}

fn normalize_image_urls(el: Element, origin: &str) -> JsResult<()> {
    let rewrite = |src: &JsString| {
        crate::media::legacy_image_path(&decode(src).as_string()?, origin).map(JsString::from)
    };
    for name in ["src", "data-full-src"] {
        if let Some(path) = rewrite(&attribute(&el, name)) {
            el.set_attribute(name, &path)?;
        }
    }
    if let Some(srcset) = el.attribute("srcset").filter(|srcset| srcset.length() != 0) {
        let normalized = Array::new();
        for candidate in srcset.split(",").iter() {
            let candidate: JsString = candidate.unchecked_into();
            let parts = SPACE.with(|space| candidate.trim().split_by_pattern(space));
            if let Some(path) = rewrite(&parts.get(0).unchecked_into()) {
                parts.set(0, path.into());
                normalized.push(parts.join(" ").as_ref());
            } else {
                normalized.push(candidate.as_ref());
            }
        }
        let normalized = normalized.join(",");
        if srcset != normalized {
            el.set_attribute("srcset", &normalized)?;
        }
    }
    Ok(())
}

fn attribute(el: &Element, name: &str) -> JsString {
    el.attribute(name).unwrap_or_else(|| "".into())
}

fn push_tag(tags: &Array, prefix: &str, value: &JsString) {
    let escaped = ESCAPE.with(|pattern| {
        ESCAPE_CHAR.with(|replace| {
            value.replace_by_pattern_with_function(pattern, replace.as_ref().unchecked_ref())
        })
    });
    tags.push(
        JsString::from(prefix)
            .concat(escaped.as_ref())
            .concat(&"\">".into())
            .as_ref(),
    );
}

fn escape_char(value: JsString) -> JsString {
    match value.as_string().as_deref() {
        Some("&") => "&amp;".into(),
        Some("<") => "&lt;".into(),
        Some(">") => "&gt;".into(),
        Some("\"") => "&quot;".into(),
        Some("'") => "&#39;".into(),
        _ => value,
    }
}

fn decode(value: &JsString) -> JsString {
    ENTITY.with(|pattern| {
        DECODE_ENTITY.with(|replace| {
            value.replace_by_pattern_with_function(pattern, replace.as_ref().unchecked_ref())
        })
    })
}

fn decode_entity(entity: JsString, name: JsString) -> JsString {
    let name = name.as_string().unwrap_or_default().to_ascii_lowercase();
    let numeric = name
        .strip_prefix("#x")
        .map(|digits| (digits, 16))
        .or_else(|| name.strip_prefix('#').map(|digits| (digits, 10)));
    if let Some((digits, base)) = numeric {
        return u32::from_str_radix(digits, base)
            .ok()
            .filter(|code| (1..=0x10ffff).contains(code))
            .and_then(|code| JsString::from_code_point1(code).ok())
            .unwrap_or(entity);
    }
    match name.as_str() {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        _ => entity,
    }
}

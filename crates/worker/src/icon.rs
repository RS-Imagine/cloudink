use std::borrow::Cow;
use std::cell::Cell;
use std::rc::Rc;

use worker::js_sys::{Array, JsString, Object, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Blob, FormData, Headers, ResponseInit};
use xml::reader::{ParserConfig, XmlEvent};

use crate::html_rewriter::{Element, HtmlRewriter, JsResult, string_response};
use crate::icon_raster::{validate_derived_png, validate_ico};
use crate::image_header::{image_info, image_type};
use crate::runtime::{property, set, sha256_hex};
use crate::site::Hooks;

pub const PREFIX: &str = "uploads/icons/";
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
    "title",
    "desc",
    "use",
    "symbol",
];
const SHAPES: &[&str] = &[
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use",
];
const ATTRIBUTES: &[&str] = &[
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "transform",
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "id",
    "gradientUnits",
    "gradientTransform",
    "offset",
    "stop-color",
    "stop-opacity",
    "clip-path",
    "clip-rule",
    "clipPathUnits",
    "mask",
    "maskUnits",
    "maskContentUnits",
    "preserveAspectRatio",
    "spreadMethod",
    "fx",
    "fy",
    "fr",
];
const STYLE_PROPERTIES: &[&str] = &[
    "fill",
    "stroke",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "stroke-width",
    "stop-color",
    "stop-opacity",
];
const COMPLEX_SVG: IconError = IconError {
    status: 413,
    message: Cow::Borrowed("SVG 图标过于复杂，请简化后上传。"),
};

pub struct IconError {
    pub status: u16,
    pub message: Cow<'static, str>,
}

impl IconError {
    pub const fn bad(message: &'static str) -> Self {
        Self {
            status: 400,
            message: Cow::Borrowed(message),
        }
    }

    pub fn message(status: u16, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn as_js(&self, hooks: &Hooks) -> JsValue {
        hooks.error(self.status, &self.message)
    }
}

pub async fn inspect(mut bytes: Uint8Array, hooks: &Hooks) -> JsResult<JsValue> {
    if bytes.length() == 0 {
        return Err(hooks.error(400, "请选择有效的网站图标文件。"));
    }
    let (ext, mime) = if bytes.subarray(0, 4).to_vec() == [0, 0, 1, 0] {
        validate_ico(&bytes.to_vec()).map_err(|error| error.as_js(hooks))?;
        ("ico", "image/x-icon")
    } else if let Some(format) = image_type(&bytes) {
        if format.ext != "avif" && image_info(&bytes).is_none() {
            return Err(hooks.error(400, "图片文件已损坏或无法读取尺寸，请重新选择图片。"));
        }
        (format.ext, format.mime)
    } else {
        let sample = bytes.subarray(0, 512).to_vec();
        if !String::from_utf8_lossy(&sample)
            .trim_start_matches(js_whitespace)
            .starts_with('<')
        {
            return Err(hooks.error(
                400,
                "不支持的文件格式，请上传有效的 PNG、JPG、WebP、GIF、AVIF、SVG 或 ICO 图片。",
            ));
        }
        bytes = sanitize_svg(bytes.to_vec(), hooks).await?;
        ("svg", "image/svg+xml")
    };
    let hash = sha256_hex(&bytes).await?;
    let icon = Object::new();
    set(&icon, "bytes", bytes)?;
    set(&icon, "key", format!("{PREFIX}{hash}.{ext}"))?;
    set(&icon, "hash", hash)?;
    set(&icon, "ext", ext)?;
    set(&icon, "type", mime)?;
    Ok(icon.into())
}

pub async fn derivatives(form: &FormData, key: &str, hooks: &Hooks) -> JsResult<Array> {
    let keys = hooks.derived_keys(key)?;
    if !keys.is_truthy() {
        return Err(hooks.error(400, "网站图标地址不正确。"));
    }
    let prepared = Array::new();
    for (field, name, size, label) in [
        ("derived_180", "apple", 180, "Apple 主屏 180×180"),
        ("derived_192", "icon192", 192, "PWA 192×192"),
        ("derived_512", "icon512", 512, "PWA 512×512"),
        (
            "derived_512_maskable",
            "maskable512",
            512,
            "PWA 512×512 Maskable",
        ),
    ] {
        let bytes = form_bytes(form, field, label, hooks).await?;
        validate_derived_png(&bytes.to_vec(), size).map_err(|error| error.as_js(hooks))?;
        prepared.push(&prepared_icon(property(&keys, name), bytes, "image/png")?);
    }
    if property(&keys, "ext").as_string().as_deref() != Some("ico") {
        let bytes = form_bytes(form, "derived_ico", "favicon.ico", hooks).await?;
        validate_ico(&bytes.to_vec()).map_err(|error| error.as_js(hooks))?;
        prepared.push(&prepared_icon(
            property(&keys, "faviconIco"),
            bytes,
            "image/x-icon",
        )?);
    }
    Ok(prepared)
}

async fn form_bytes(
    form: &FormData,
    field: &str,
    label: &str,
    hooks: &Hooks,
) -> JsResult<Uint8Array> {
    let part = form.get(field);
    if !part.is_truthy() || part.is_string() {
        return Err(hooks.error(400, &format!("缺少{label}派生图标。")));
    }
    let blob: Blob = part.unchecked_into();
    let bytes = Uint8Array::new(&JsFuture::from(blob.array_buffer()).await?);
    if bytes.length() == 0 {
        return Err(hooks.error(400, &format!("{label}派生图标为空。")));
    }
    Ok(bytes)
}

fn prepared_icon(key: JsValue, bytes: Uint8Array, mime: &str) -> JsResult<JsValue> {
    let icon = Object::new();
    set(&icon, "key", key)?;
    set(&icon, "bytes", bytes)?;
    set(&icon, "type", mime)?;
    Ok(icon.into())
}

async fn sanitize_svg(bytes: Vec<u8>, hooks: &Hooks) -> JsResult<Uint8Array> {
    let source =
        std::str::from_utf8(&bytes).map_err(|_| hooks.error(400, "SVG 必须使用 UTF-8 编码。"))?;
    let source = remove_xml_declaration(source.trim_matches(js_whitespace));
    validate_svg(source).map_err(|error| error.as_js(hooks))?;
    let headers = Headers::new()?;
    headers.set("Content-Type", "text/html; charset=utf-8")?;
    let init = ResponseInit::new();
    init.set_headers(headers.as_ref());
    let response = string_response(&JsString::from(source), &init)?;
    let counts = Rc::new(SvgElements::default());
    let rewriter = HtmlRewriter::new();
    let observed = Rc::clone(&counts);
    let error_hook: &JsValue = hooks.as_ref();
    let error_hook = error_hook.clone();
    rewriter.on_element("*", move |element| {
        observed.rewrite(&element, error_hook.unchecked_ref())
    })?;
    rewriter.on_comments("*", |comment| comment.remove_comment())?;
    let response = rewriter.transform(&response)?;
    let output = JsFuture::from(response.text()?)
        .await?
        .as_string()
        .unwrap_or_default();
    validate_svg(&output).map_err(|error| error.as_js(hooks))?;
    if counts.roots.get() != 1 || counts.shapes.get() == 0 {
        return Err(hooks.error(400, "SVG 需要一个根元素和可显示的图形。"));
    }
    Ok(Uint8Array::from(output.as_bytes()))
}

fn remove_xml_declaration(source: &str) -> &str {
    if source
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<?xml"))
        && let Some(end) = source[5..].find('?').map(|offset| offset + 5)
        && source[end..].starts_with("?>")
    {
        return source[end + 2..].trim_start_matches(js_whitespace);
    }
    source
}

fn validate_svg(source: &str) -> Result<(), IconError> {
    const INVALID: IconError = IconError::bad("SVG 不是完整有效的 XML 文档，请重新导出。");
    let parser = ParserConfig::new()
        .allow_multiple_root_elements(false)
        .create_reader(source.as_bytes());
    let mut depth = 0;
    let mut elements = 0;
    for event in parser {
        match event.map_err(|_| INVALID)? {
            XmlEvent::Doctype { .. } | XmlEvent::ProcessingInstruction { .. } => {
                return Err(IconError::bad(
                    "SVG 不支持文档声明或处理指令，请重新导出静态图标。",
                ));
            }
            XmlEvent::StartElement { name, .. } => {
                depth += 1;
                elements += 1;
                if depth > 128 || elements > 5000 {
                    return Err(COMPLEX_SVG);
                }
                if depth == 1 && (name.local_name != "svg" || name.prefix.is_some()) {
                    return Err(IconError::bad("SVG 需要一个完整的根元素。"));
                }
            }
            XmlEvent::EndElement { .. } => depth -= 1,
            _ => {}
        }
    }
    if elements == 0 || depth != 0 {
        return Err(INVALID);
    }
    Ok(())
}

#[derive(Default)]
struct SvgElements {
    roots: Cell<u32>,
    shapes: Cell<u32>,
    nodes: Cell<u32>,
}

impl SvgElements {
    fn rewrite(&self, element: &Element, hooks: &Hooks) -> JsResult<()> {
        self.nodes.set(self.nodes.get() + 1);
        if self.nodes.get() > 5000 {
            return Err(COMPLEX_SVG.as_js(hooks));
        }
        let tag = element.tag_name().to_lowercase();
        if !ELEMENTS.contains(&tag.as_str()) {
            return element.remove();
        }
        if tag == "svg" {
            self.roots.set(self.roots.get() + 1);
        }
        if SHAPES.contains(&tag.as_str()) {
            self.shapes.set(self.shapes.get() + 1);
        }
        let original: Vec<_> = Array::from(&element.attributes())
            .iter()
            .map(|pair| {
                let pair: Array = pair.unchecked_into();
                (
                    pair.get(0).as_string().unwrap_or_default(),
                    pair.get(1).as_string().unwrap_or_default(),
                )
            })
            .collect();
        for (name, _) in &original {
            element.remove_attribute(name)?;
        }
        for (name, value) in original {
            let name = name.to_lowercase();
            if name == "style" {
                for declaration in value.split(';') {
                    if let Some((name, content)) = declaration.split_once(':') {
                        let name = name.trim_matches(js_whitespace).to_lowercase();
                        let content = content.trim_matches(js_whitespace);
                        if STYLE_PROPERTIES.contains(&name.as_str()) && safe_value(&name, content) {
                            element.set_attribute(&name, &JsString::from(content))?;
                        }
                    }
                }
            } else if matches!(name.as_str(), "href" | "xlink:href")
                && value.strip_prefix('#').is_some_and(valid_id)
            {
                element.set_attribute("href", &JsString::from(value))?;
            } else if let Some(canonical) = ATTRIBUTES
                .iter()
                .find(|attr| attr.eq_ignore_ascii_case(&name))
                && safe_value(&name, &value)
            {
                element.set_attribute(canonical, &JsString::from(value))?;
            }
        }
        if tag == "svg" {
            element.set_attribute("xmlns", &JsString::from("http://www.w3.org/2000/svg"))?;
        }
        Ok(())
    }
}

fn safe_value(name: &str, value: &str) -> bool {
    if value.encode_utf16().count() > 200_000 || value.contains(['<', '>', '&', '\\']) {
        return false;
    }
    let local_paint = || {
        value
            .strip_prefix("url(#")
            .and_then(|text| text.strip_suffix(')'))
            .is_some_and(valid_id)
    };
    match name {
        "id" => valid_id(value),
        "clip-path" | "mask" => value == "none" || local_paint(),
        "fill" | "stroke" | "stop-color" => {
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
                || value.strip_prefix('#').is_some_and(|hex| {
                    (3..=8).contains(&hex.len()) && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                || value.split_once('(').is_some_and(|(name, body)| {
                    matches!(name, "rgb" | "rgba" | "hsl" | "hsla")
                        && body.strip_suffix(')').is_some_and(|body| {
                            !body.is_empty()
                                && body.chars().all(|ch| {
                                    ch.is_ascii_digit()
                                        || matches!(ch, '.' | ',' | '%' | '+' | '-' | '/')
                                        || js_whitespace(ch)
                                })
                        })
                })
                || local_paint()
        }
        _ => value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '.' | ',' | '%' | '(' | ')' | '+' | ':' | '-')
                || js_whitespace(ch)
        }),
    }
}

fn valid_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    id.len() <= 100
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000D}' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

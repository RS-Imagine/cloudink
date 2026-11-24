use std::collections::HashSet;
use std::fmt::Write;

use chrono::NaiveDate;
use worker::js_sys::{Array, JSON, JsString, Object, RegExp};
use worker::wasm_bindgen::{JsCast, JsValue};

use crate::browser_publish::{entries, nonnegative_integer};
use crate::drafts::Kind;
use crate::html_rewriter::JsResult;
use crate::http::error;
use crate::media::{valid_image_key, valid_site_icon_key};
use crate::page_rendering::valid_slug;
use crate::runtime::{js_number, object, property, set, set_own};

thread_local! {
    static FRONT_MATTER: RegExp = RegExp::new(r"^\uFEFF?\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+(?:\r?\n|$)([\s\S]*)$", "");
    static LEADING_NEWLINE: RegExp = RegExp::new(r"^\r?\n", "");
}

fn text(value: JsValue, label: &str, max: u32, required: bool) -> JsResult<JsString> {
    if !value.is_string() {
        return Err(error(400, &format!("{label}为空或超过长度限制。")));
    }
    let value: JsString = value.unchecked_into();
    if value.length() > max || (required && value.trim().length() == 0) {
        return Err(error(400, &format!("{label}为空或超过长度限制。")));
    }
    Ok(value)
}

fn date(value: JsValue) -> JsResult<JsString> {
    let value = text(value, "日期", 10, true)?;
    let date = value.as_string().unwrap_or_default();
    if date_parts(&date).is_none() {
        return Err(error(400, "日期需要是有效的 YYYY-MM-DD。"));
    }
    Ok(value)
}

fn date_parts(date: &str) -> Option<i32> {
    let date = date.as_bytes();
    if date.len() != 10 || date[4] != b'-' || date[7] != b'-' {
        return None;
    }
    let year = digits(&date[..4])? as i32;
    NaiveDate::from_ymd_opt(year, digits(&date[5..7])?, digits(&date[8..10])?).map(|_| year)
}

fn digits(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0, |value, &byte| {
        byte.is_ascii_digit()
            .then(|| value * 10 + u32::from(byte - b'0'))
    })
}

fn short_date(value: JsValue) -> JsResult<JsString> {
    let value = text(value, "发布时间", 16, true)?;
    let input = value.as_string().unwrap_or_default();
    let input = input.as_bytes();
    let valid = input.len() == 16
        && input[10] == b' '
        && input[13] == b':'
        && std::str::from_utf8(&input[..10])
            .ok()
            .and_then(date_parts)
            .is_some_and(|year| year >= 100)
        && digits(&input[11..13]).is_some_and(|hour| hour <= 23)
        && digits(&input[14..16]).is_some_and(|minute| minute <= 59);
    if !valid {
        return Err(error(
            400,
            "发布时间需要是有效的 YYYY-MM-DD HH:MM（24 小时制）。",
        ));
    }
    Ok(value)
}

fn aliases(input: &JsValue, kind: Kind) -> JsResult<Array> {
    let aliases = property(input, "aliases");
    if aliases.is_undefined() {
        return Ok(Array::new());
    }
    let invalid = || {
        error(
            400,
            if kind == Kind::Post {
                "旧文章地址格式不正确或超过 100 个。"
            } else {
                "旧短记地址格式不正确或超过 100 个。"
            },
        )
    };
    if !Array::is_array(&aliases) {
        return Err(invalid());
    }
    let aliases: Array = aliases.unchecked_into();
    if aliases.length() > 100 {
        return Err(invalid());
    }
    let slug = property(input, "slug");
    let mut seen = HashSet::new();
    let result = Array::new();
    for alias in aliases.iter() {
        let name = alias
            .as_string()
            .filter(|name| valid_slug(name))
            .ok_or_else(invalid)?;
        if alias != slug && seen.insert(name) {
            result.push(&alias);
        }
    }
    Ok(result)
}

pub fn validate_draft(input: &JsValue, kind: Kind) -> JsResult<JsValue> {
    let front = property(input, "front_matter");
    let body = property(input, "body_markdown");
    if !input.is_object() || front.is_undefined() || body.is_undefined() {
        return Err(error(
            400,
            if kind == Kind::Post {
                "文章格式不正确。"
            } else {
                "短记格式不正确。"
            },
        ));
    }
    if !front.is_object() {
        return Err(error(
            400,
            if kind == Kind::Post {
                "文章信息不完整。"
            } else {
                "短记信息不完整。"
            },
        ));
    }
    let aliases = aliases(&front, kind)?;
    let normalized = Object::new();
    if kind == Kind::Post {
        set(
            &normalized,
            "title",
            text(property(&front, "title"), "标题", 300, true)?,
        )?;
    } else {
        set(&normalized, "date", short_date(property(&front, "date"))?)?;
    }
    let slug = text(
        property(&front, "slug"),
        if kind == Kind::Post {
            "文章地址"
        } else {
            "短记地址"
        },
        100,
        true,
    )?;
    if !slug.as_string().is_some_and(|slug| valid_slug(&slug)) {
        return Err(error(
            400,
            "文章地址只能使用英文字母、数字、短横线和下划线（最多 100 个字符）。",
        ));
    }
    set(&normalized, "slug", slug)?;
    if aliases.length() != 0 {
        set(&normalized, "aliases", aliases)?;
    }
    if kind == Kind::Post {
        set(&normalized, "date", date(property(&front, "date"))?)?;
        let updated = property(&front, "updated");
        if updated.is_truthy() {
            set(&normalized, "updated", date(updated)?)?;
        }
        let description = property(&front, "description");
        set(
            &normalized,
            "description",
            text(
                if description.is_null() || description.is_undefined() {
                    "".into()
                } else {
                    description
                },
                "摘要",
                2000,
                false,
            )?,
        )?;
    }
    set(
        &normalized,
        "draft",
        property(&front, "draft") == JsValue::TRUE,
    )?;
    let body = text(
        body,
        "正文",
        if kind == Kind::Post {
            1_000_000
        } else {
            200_000
        },
        false,
    )?;
    Ok(object(&[
        ("front_matter", normalized.into()),
        ("body_markdown", body.into()),
    ])?
    .into())
}

pub fn parse_source(source: &JsString, kind: Kind) -> JsResult<JsValue> {
    let parts: Array = FRONT_MATTER
        .with(|pattern| source.match_(pattern))
        .ok_or_else(|| {
            error(
                400,
                if kind == Kind::Post {
                    "Markdown 需要包含 +++ 包围的 TOML 文章信息。"
                } else {
                    "Markdown 需要包含 +++ 包围的 TOML 短记信息。"
                },
            )
        })?
        .unchecked_into();
    let front = parts.get(1).as_string().unwrap_or_default();
    let body: JsString = parts.get(2).unchecked_into();
    let front = front.parse::<toml::Table>().map_err(|_| {
        error(
            400,
            if kind == Kind::Post {
                "无法解析 Markdown 的 TOML 文章信息。"
            } else {
                "无法解析 Markdown 的 TOML 短记信息。"
            },
        )
    })?;
    let value = toml_value(toml::Value::Table(front))?;
    let body = LEADING_NEWLINE.with(|pattern| body.replace_by_pattern(pattern, ""));
    let draft = object(&[("front_matter", value), ("body_markdown", body.into())])?;
    validate_draft(&draft, kind)
}

fn toml_value(value: toml::Value) -> JsResult<JsValue> {
    Ok(match value {
        toml::Value::String(value) => value.into(),
        toml::Value::Boolean(value) => value.into(),
        toml::Value::Integer(value) => (value as f64).into(),
        toml::Value::Float(value) => value.into(),
        toml::Value::Datetime(_) => Object::new().into(),
        toml::Value::Array(values) => {
            let result = Array::new();
            for value in values {
                result.push(&toml_value(value)?);
            }
            result.into()
        }
        toml::Value::Table(values) => {
            let result = Object::new();
            for (key, value) in values {
                set_own(&result, &key, toml_value(value)?)?;
            }
            result.into()
        }
    })
}

pub fn serialize(draft: &JsValue) -> JsResult<JsString> {
    let mut header = String::from("+++\n");
    let fields = property(draft, "front_matter");
    let mut written = false;
    for (key, value) in entries(&fields) {
        if value.is_undefined() || value.is_null() {
            continue;
        }
        let value = toml_scalar(&value)?;
        writeln!(header, "{key} = {value}").expect("writing to String cannot fail");
        written = true;
    }
    if !written {
        header.push('\n');
    }
    header.push_str("+++\n\n");
    Ok(JsString::from(header).concat(&property(draft, "body_markdown")))
}

fn toml_scalar(value: &JsValue) -> JsResult<String> {
    if Array::is_array(value) {
        let values: &Array = value.unchecked_ref();
        if values.length() == 0 {
            return Ok("[]".to_owned());
        }
        let parts = values
            .iter()
            .map(|value| toml_scalar(&value))
            .collect::<JsResult<Vec<_>>>()?;
        return Ok(format!("[ {} ]", parts.join(", ")));
    }
    let canonical = if value.is_string() {
        value.unchecked_ref::<JsString>().to_well_formed().into()
    } else {
        value.clone()
    };
    Ok(JSON::stringify(&canonical)?
        .as_string()
        .unwrap_or_default()
        .replace('\u{7f}', "\\u007f"))
}

pub fn validate_site(input: &JsValue) -> JsResult<JsValue> {
    if !input.is_object() {
        return Err(error(400, "网站信息格式不正确。"));
    }
    let appearance = Object::new();
    let footer = property(input, "footer");
    if !footer.is_undefined() {
        set(&appearance, "footer", text(footer, "页脚", 2000, false)?)?;
    }
    let clarity = property(input, "clarityId");
    if !clarity.is_undefined() {
        let clarity = text(clarity, "统计项目", 64, false)?;
        if !clarity
            .as_string()
            .is_some_and(|value| value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        {
            return Err(error(400, "统计项目格式不正确。"));
        }
        set(&appearance, "clarityId", clarity)?;
    }
    let palette = property(input, "themePalette");
    if !palette.is_undefined() {
        if !palette.as_string().is_some_and(|value| {
            matches!(
                value.as_str(),
                "ink" | "neutral" | "brown" | "blue" | "violet" | "rose"
            )
        }) {
            return Err(error(400, "请选择支持的主题色。"));
        }
        set(&appearance, "themePalette", palette)?;
    }
    let font = property(input, "readingFont");
    if !font.is_undefined() {
        if font != "serif" && font != "sans" {
            return Err(error(400, "请选择支持的阅读字体。"));
        }
        set(&appearance, "readingFont", font)?;
    }
    let illustration = property(input, "homeIllustration");
    if !illustration.is_undefined() {
        if !illustration
            .as_string()
            .is_some_and(|key| valid_home_illustration(&key))
        {
            return Err(error(
                400,
                "首页插画需要选择默认、关闭或图片库中的有效图片。",
            ));
        }
        set(&appearance, "homeIllustration", illustration)?;
    }
    let icon = property(input, "siteIcon");
    if !icon.is_undefined() {
        if !icon
            .as_string()
            .is_some_and(|value| value.is_empty() || valid_site_icon_key(&value))
        {
            return Err(error(400, "网站图标地址不正确。"));
        }
        set(&appearance, "siteIcon", icon.clone())?;
    }
    let size = property(input, "siteIconSize");
    if !size.is_undefined() && !size.is_null() && size != "" {
        let size = if size.is_string() {
            Some(js_number(&size))
        } else {
            size.as_f64()
        };
        let size = size
            .filter(|&size| nonnegative_integer(size))
            .ok_or_else(|| error(400, "网站图标大小不正确。"))?;
        if icon.is_truthy() && size > 0.0 {
            set(&appearance, "siteIconSize", size)?;
        }
    }
    let site = object(&[
        (
            "title",
            text(property(input, "title"), "网站标题", 300, true)?.into(),
        ),
        (
            "subtitle",
            text(property(input, "subtitle"), "副标题", 1000, false)?.into(),
        ),
        (
            "author",
            text(property(input, "author"), "作者", 300, true)?.into(),
        ),
        (
            "description",
            text(property(input, "description"), "网站描述", 2000, false)?.into(),
        ),
    ])?;
    let title = property(input, "bigTitle");
    if title.is_truthy() {
        set(&site, "bigTitle", text(title, "首页大标题", 300, true)?)?;
    }
    Object::assign(&site, &appearance);
    let about = property(input, "about");
    if !about.is_undefined() {
        set(&site, "about", text(about, "关于页面", 100_000, false)?)?;
    }
    Ok(site.into())
}

pub fn valid_home_illustration(key: &str) -> bool {
    matches!(key, "" | "default") || (valid_image_key(key) && !key.ends_with(".ico"))
}

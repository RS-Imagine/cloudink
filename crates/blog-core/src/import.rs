//! Lenient upload conversion only; stored originals and backups keep their strict parser.
use anyhow::{bail, Context, Result};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use crate::models::{FrontMatter, PostDraft};

fn text(table: &toml::Table, key: &str) -> Result<Option<String>> {
    match table.get(key) {
        None => Ok(None),
        Some(toml::Value::String(value)) => Ok(Some(value.clone())),
        Some(toml::Value::Datetime(value)) if key == "date" || key == "updated" => Ok(Some(value.to_string())),
        _ => bail!("文章信息 {key} 的格式不正确。"),
    }
}
fn date(value: &str) -> Result<String> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2
        || !value.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
        bail!("日期需要是有效的 YYYY-MM-DD。");
    }
    let y: u32 = parts[0].parse()?;
    let m: usize = parts[1].parse()?;
    let d: u32 = parts[2].parse()?;
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = [31, if leap {29} else {28}, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if y == 0 || !(1..=12).contains(&m) || d == 0 || d > days[m - 1] {
        bail!("日期需要是有效的 YYYY-MM-DD。");
    }
    Ok(value.to_string())
}
fn heading(body: &str) -> Option<(String, usize)> {
    let mut events = Parser::new_ext(body, Options::all()).into_offset_iter();
    let (first, span) = events.next()?;
    if !body[..span.start].trim().is_empty()
        || !matches!(first, Event::Start(Tag::Heading { level: HeadingLevel::H1, .. })) {
        return None;
    }
    let mut title = String::new();
    for (event, range) in events {
        match event {
            Event::Text(value) | Event::Code(value) => title.push_str(&value),
            Event::SoftBreak | Event::HardBreak => title.push(' '),
            Event::Start(Tag::Image { .. } | Tag::Link { .. }) | Event::InlineHtml(_) | Event::Html(_) | Event::InlineMath(_) | Event::DisplayMath(_) => return None,
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                let title = title.trim().to_string();
                return (!title.is_empty()).then_some((title, range.end));
            }
            _ => {}
        }
    }
    None
}
fn shortened(value: &str, limit: usize) -> String {
    let mut used = 0;
    value.chars().take_while(|c| {
        used += c.len_utf16();
        used <= limit
    }).collect()
}
/// Converts ordinary Markdown or optional TOML metadata into a NEW draft.
/// The caller supplies a fresh address; imported slugs are never overwrite instructions.
pub fn import_markdown(raw: &str, filename: &str, today: &str, slug: &str) -> Result<PostDraft> {
    if raw.len() > 1_000_000 { bail!("Markdown 文件最多 1 MB。"); }
    let source = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if source.trim().is_empty() { bail!("文件没有可导入的内容。"); }
    crate::content::validate_slug(slug)?;
    let mut table = toml::Table::new();
    let mut body = source;
    let mut lines = source.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    if first.trim() == "+++" {
        let mut offset = first.len();
        let mut closed = false;
        for line in lines {
            if line.trim() == "+++" {
                table = source[first.len()..offset].parse()
                    .context("无法解析 +++ 文章信息，请检查 TOML 格式。")?;
                body = &source[offset + line.len()..];
                body = body.strip_prefix("\r\n").or_else(|| body.strip_prefix('\n')).unwrap_or(body);
                closed = true;
                break;
            }
            offset += line.len();
        }
        if !closed { bail!("+++ 文章信息缺少结尾的 +++。"); }
    }
    let explicit = text(&table, "title")?.filter(|s| !s.trim().is_empty());
    let inferred = if explicit.is_none() { heading(body) } else { None };
    let filename = filename.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let stem = filename.rsplit_once('.').filter(|(_, ext)| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .map(|(stem, _)| stem).unwrap_or(filename).trim();
    let title = if let Some(value) = explicit {
        if value.encode_utf16().count() > 300 { bail!("标题最多 300 个字符。"); }
        value
    } else if let Some((value, end)) = inferred {
        if value.encode_utf16().count() <= 300 {
            body = &body[end..];
            value
        } else {
            shortened(if stem.is_empty() { "未命名文章" } else { stem }, 300)
        }
    } else {
        shortened(if stem.is_empty() { "未命名文章" } else { stem }, 300)
    };
    let published = text(&table, "date")?.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| today.to_string());
    let updated = text(&table, "updated")?.filter(|s| !s.trim().is_empty()).map(|s| date(&s)).transpose()?;
    let description = text(&table, "description")?.unwrap_or_default();
    if description.encode_utf16().count() > 2000 { bail!("摘要最多 2000 个字符。"); }
    Ok(PostDraft {
        front_matter: FrontMatter { title, date: date(&published)?, updated, slug: slug.to_string(), description, draft: true },
        body_markdown: body.to_string(),
    })
}

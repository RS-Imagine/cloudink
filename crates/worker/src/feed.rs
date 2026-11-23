use chrono::NaiveDate;
use serde_json::Value;
use worker::{Bucket, Error, Result};

pub async fn read_json(storage: &Bucket, key: &str) -> Result<Option<Value>> {
    let Some(object) = storage.get(key).execute().await? else {
        return Ok(None);
    };
    let body = object
        .body()
        .ok_or_else(|| Error::RustError("Published object has no body".into()))?;
    Ok(Some(serde_json::from_slice(&body.bytes().await?)?))
}

pub async fn fill_legacy_icon(storage: &Bucket, pointer: &mut Value) -> Result<()> {
    let Some(fields) = pointer.as_object_mut() else {
        return Ok(());
    };
    let Some(id) = fields
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(());
    };
    if fields.contains_key("siteIcon") {
        return Ok(());
    }

    let legacy = storage
        .get(format!("releases/{id}.posts.json"))
        .execute()
        .await?;
    let legacy = match legacy.as_ref().and_then(|object| object.body()) {
        Some(body) => body
            .bytes()
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default(),
        None => Value::Null,
    };
    let site = &legacy["site"];
    let icon = site["siteIcon"].as_str().unwrap_or_default();
    fields.insert("siteIcon".into(), Value::from(icon));
    if let Some(size) = site["siteIconSize"].as_u64().filter(|size| *size != 0) {
        fields.insert("siteIconSize".into(), Value::from(size));
    }
    Ok(())
}

pub async fn render(
    storage: &Bucket,
    origin: &str,
    id: Option<&str>,
    pages: &Value,
) -> Result<FeedXml> {
    let (site, index) = match id {
        Some(id) => (
            read_json(storage, &object_key(id, pages, "site.json"))
                .await?
                .unwrap_or_default(),
            read_json(storage, &object_key(id, pages, "search_index.json")).await?,
        ),
        None => (Value::Null, None),
    };
    let entries = match index.as_ref() {
        Some(index) => index
            .as_array()
            .ok_or_else(|| Error::RustError("Published feed index is invalid".into()))?
            .as_slice(),
        None => &[],
    };
    let title = site["title"]
        .as_str()
        .filter(|title| !title.is_empty())
        .unwrap_or("Blog");
    let description = site["description"].as_str().unwrap_or_default();
    Ok(render_xml(origin, title, description, entries))
}

fn object_key(id: &str, pages: &Value, path: &str) -> String {
    match pages[path].as_str().filter(|key| !key.is_empty()) {
        Some(key) => format!("public/content/{key}"),
        None => format!("public/{id}/{path}"),
    }
}

pub struct FeedXml {
    pub text: String,
    split_surrogates: Vec<(usize, u16)>,
}

impl FeedXml {
    fn append_bounded(&mut self, name: &str, value: &str, limit: usize) {
        let prefix: Vec<_> = value.encode_utf16().take(limit).collect();
        let end = append_element(&mut self.text, name, &String::from_utf16_lossy(&prefix));
        if let Some(&unit) = prefix
            .last()
            .filter(|unit| (0xd800..=0xdbff).contains(*unit))
        {
            self.split_surrogates.push((end - 3, unit));
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        let mut bytes = self.text.into_bytes();
        // TextEncoder normalized split UTF-16 for the old ETag calculation. The
        // Worker sent the original code unit in the RSS body.
        for (offset, unit) in self.split_surrogates {
            bytes[offset..offset + 3].copy_from_slice(&[
                0xe0 | (unit >> 12) as u8,
                0x80 | ((unit >> 6) & 0x3f) as u8,
                0x80 | (unit & 0x3f) as u8,
            ]);
        }
        bytes
    }
}

fn render_xml(origin: &str, title: &str, description: &str, entries: &[Value]) -> FeedXml {
    let feed = entries
        .iter()
        .filter_map(FeedItem::parse)
        .take(50)
        .collect::<Vec<_>>();
    let last_build = feed.iter().filter_map(|item| item.last_update).max();
    let mut feed_xml = FeedXml {
        text: String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><rss version=\"2.0\"><channel>",
        ),
        split_surrogates: Vec::new(),
    };
    feed_xml.append_bounded("title", title, 300);
    append_element(&mut feed_xml.text, "link", &format!("{origin}/"));
    feed_xml.append_bounded("description", description, 2000);
    let xml = &mut feed_xml.text;
    if let Some(date) = last_build {
        append_date(xml, "lastBuildDate", date);
    }
    for item in feed {
        let link = format!("{origin}/posts/{}/", item.slug);
        xml.push_str("<item>");
        append_element(xml, "title", item.title);
        append_element(xml, "link", &link);
        append_element(xml, "guid", &link);
        if let Some(date) = item.date {
            append_date(xml, "pubDate", date);
        }
        append_element(xml, "description", item.description);
        xml.push_str("</item>");
    }
    xml.push_str("</channel></rss>");
    feed_xml
}

struct FeedItem<'a> {
    title: &'a str,
    slug: &'a str,
    description: &'a str,
    date: Option<NaiveDate>,
    last_update: Option<NaiveDate>,
}

impl<'a> FeedItem<'a> {
    fn parse(item: &'a Value) -> Option<Self> {
        let title = item["title"].as_str()?;
        let slug = item["slug"].as_str()?;
        if title.encode_utf16().count() > 300
            || !(1..=100).contains(&slug.len())
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return None;
        }
        let description = match item.get("description") {
            Some(value) => value.as_str()?,
            None => "",
        };
        if description.encode_utf16().count() > 2000 {
            return None;
        }
        let date = match item.get("date") {
            Some(value) => value.as_str()?,
            None => "",
        };
        let updated = match item.get("updated") {
            Some(value) if !value.is_null() => value.as_str()?,
            _ => "",
        };
        let last_update = if updated.is_empty() { date } else { updated };
        Some(Self {
            title,
            slug,
            description,
            date: iso_date(date),
            last_update: iso_date(last_update),
        })
    }
}

fn iso_date(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|date| date.format("%Y-%m-%d").to_string() == value)
}

fn append_date(xml: &mut String, name: &str, value: NaiveDate) {
    append_element(
        xml,
        name,
        &value.format("%a, %d %b %Y 00:00:00 GMT").to_string(),
    );
}

fn append_element(xml: &mut String, name: &str, value: &str) -> usize {
    xml.push('<');
    xml.push_str(name);
    xml.push('>');
    for character in value.chars() {
        match character {
            '&' => xml.push_str("&amp;"),
            '<' => xml.push_str("&lt;"),
            '>' => xml.push_str("&gt;"),
            '"' => xml.push_str("&quot;"),
            '\'' => xml.push_str("&#39;"),
            '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{fffe}'
            | '\u{ffff}' => {}
            _ => xml.push(character),
        }
    }
    let end = xml.len();
    xml.push_str("</");
    xml.push_str(name);
    xml.push('>');
    end
}

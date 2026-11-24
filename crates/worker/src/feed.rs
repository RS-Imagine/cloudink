use chrono::NaiveDate;
use worker::js_sys::{Array, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::{Bucket, Error, Response, Result, web_sys};

async fn read_json(storage: &Bucket, key: &str) -> Result<JsValue> {
    let Some(object) = storage.get(key).execute().await? else {
        return Ok(JsValue::UNDEFINED);
    };
    let body = object
        .body()
        .ok_or_else(|| Error::RustError("Published object has no body".into()))?;
    // Decode the stream in the Worker runtime. The full search index can contain
    // several megabytes of article text that the feed never reads into Wasm.
    let response = web_sys::Response::from(Response::from_body(body.response_body()?)?);
    Ok(JsFuture::from(response.json()?).await?)
}

pub async fn render(
    storage: &Bucket,
    origin: &str,
    id: Option<&str>,
    pages: &JsValue,
) -> Result<FeedXml> {
    let (site, index) = match id {
        Some(id) => (
            read_json(storage, &object_key(id, pages, "site.json")).await?,
            read_json(storage, &object_key(id, pages, "search_index.json")).await?,
        ),
        None => (JsValue::UNDEFINED, JsValue::UNDEFINED),
    };
    let entries: Vec<_> = if index.is_undefined() {
        Vec::new()
    } else if Array::is_array(&index) {
        index
            .unchecked_into::<Array>()
            .iter()
            .filter_map(|row| FeedItem::parse(&row))
            .take(50)
            .collect()
    } else {
        return Err(Error::RustError("Published feed index is invalid".into()));
    };
    let title = property(&site, "title")
        .as_string()
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Blog".into());
    let description = property(&site, "description")
        .as_string()
        .unwrap_or_default();
    Ok(render_xml(origin, &title, &description, &entries))
}

fn object_key(id: &str, pages: &JsValue, path: &str) -> String {
    match property(pages, path)
        .as_string()
        .filter(|key| !key.is_empty())
    {
        Some(key) => format!("public/content/{key}"),
        None => format!("public/{id}/{path}"),
    }
}

fn property(object: &JsValue, key: &str) -> JsValue {
    if object.is_object() {
        return Reflect::get(object, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED);
    }
    JsValue::UNDEFINED
}

fn optional_string(object: &JsValue, key: &str) -> Option<String> {
    let value = property(object, key);
    if value.is_undefined() {
        return Some(String::new());
    }
    value.as_string()
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

fn render_xml(origin: &str, title: &str, description: &str, feed: &[FeedItem]) -> FeedXml {
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
        append_element(xml, "title", &item.title);
        append_element(xml, "link", &link);
        append_element(xml, "guid", &link);
        if let Some(date) = item.date {
            append_date(xml, "pubDate", date);
        }
        append_element(xml, "description", &item.description);
        xml.push_str("</item>");
    }
    xml.push_str("</channel></rss>");
    feed_xml
}

struct FeedItem {
    title: String,
    slug: String,
    description: String,
    date: Option<NaiveDate>,
    last_update: Option<NaiveDate>,
}

impl FeedItem {
    fn parse(item: &JsValue) -> Option<Self> {
        let title = property(item, "title").as_string()?;
        let slug = property(item, "slug").as_string()?;
        if title.encode_utf16().count() > 300
            || !(1..=100).contains(&slug.len())
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return None;
        }
        let description = optional_string(item, "description")?;
        if description.encode_utf16().count() > 2000 {
            return None;
        }
        let date = iso_date(&optional_string(item, "date")?);
        let updated = property(item, "updated");
        let last_update = if updated.is_null() || updated.is_undefined() {
            date
        } else {
            let updated = updated.as_string()?;
            if updated.is_empty() {
                date
            } else {
                iso_date(&updated)
            }
        };
        Some(Self {
            title,
            slug,
            description,
            date,
            last_update,
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

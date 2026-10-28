/// Escapes special HTML characters to prevent XSS.
///
/// This is the **single canonical implementation** shared across all rendering
/// modules (`render`, `content`, `admin`).  Previously each module had its own
/// copy; this eliminates that duplication.
pub fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Converts an arbitrary string into a URL-safe ASCII slug.
///
/// Non-ASCII-alphanumeric characters are collapsed into single hyphens.
/// Leading and trailing hyphens are trimmed.  An empty result falls back to
/// `"post"`.
pub fn slugify(input: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "post".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_html_encodes_special_chars() {
        assert_eq!(
            escape_html("<b>\"hi\" & 'you'</b>"),
            "&lt;b&gt;&quot;hi&quot; &amp; &#39;you&#39;&lt;/b&gt;"
        );
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World!"), "hello-world");
    }

    #[test]
    fn slugify_consecutive_specials() {
        assert_eq!(slugify("A--B  C"), "a-b-c");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify("!!!"), "post");
    }
}

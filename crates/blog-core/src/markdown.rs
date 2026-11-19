use std::collections::VecDeque;

use pulldown_cmark::{html, CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};

use crate::math::{preprocess_math, render_math_expr};

/// Converts Markdown source to an HTML string.
///
/// The pipeline is:
/// 1. Pre-process math fences (`$`, `$$`) → replace with placeholders.
/// 2. Run pulldown-cmark with all extensions enabled.
/// 3. Substitute placeholders with KaTeX-rendered HTML.
pub(crate) fn markdown_to_html(markdown: &str) -> String {
    render_markdown(markdown, false)
}

pub(crate) fn page_markdown_to_html(markdown: &str) -> String {
    render_markdown(markdown, true)
}

fn render_markdown(markdown: &str, link_contact_addresses: bool) -> String {
    let (processed, math_segments) = preprocess_math(markdown);
    // Math is already handled above. A second math pass could consume a
    // literal dollar inside code after an unmatched dollar in ordinary text.
    let mut parser = Parser::new_ext(&processed, Options::all() & !Options::ENABLE_MATH);
    let mut pending = VecDeque::new();
    let events = std::iter::from_fn(|| {
        if let Some(event) = pending.pop_front() {
            return Some(event);
        }
        let event = parser.next()?;
        match event {
            Event::Start(Tag::Table(_)) => {
                pending = table_events(event, parser.by_ref());
                pending.pop_front()
            }
            Event::Start(Tag::Paragraph) if link_contact_addresses => {
                let paragraph = parser
                    .by_ref()
                    .take_while(|event| *event != Event::End(TagEnd::Paragraph))
                    .collect::<Vec<_>>();
                contact_events(paragraph, &mut pending);
                pending.push_back(Event::End(TagEnd::Paragraph));
                Some(event)
            }
            _ => Some(event),
        }
    });
    let mut html_output = String::new();
    html::push_html(&mut html_output, events);

    for segment in math_segments {
        let rendered = render_math_expr(&segment.math, segment.display_mode);

        if segment.display_mode {
            // Replace the `<p><placeholder></p>` wrapper that cmark generates
            // for block-level elements with a proper `<div class="math-block">`.
            let wrapped = format!("<p>{}</p>", segment.placeholder);
            if html_output.contains(&wrapped) {
                html_output = html_output.replace(
                    &wrapped,
                    &format!(r#"<div class="math-block">{rendered}</div>"#),
                );
            } else {
                html_output = html_output.replace(&segment.placeholder, &rendered);
            }
        } else {
            html_output = html_output.replace(&segment.placeholder, &rendered);
        }
    }

    html_output
}

fn table_events<'a>(
    start: Event<'a>,
    parser: &mut impl Iterator<Item = Event<'a>>,
) -> VecDeque<Event<'a>> {
    let mut table = VecDeque::from([
        Event::Html(
            "<div class=\"table-scroll\" role=\"region\" tabindex=\"0\" aria-label=\"表格\">\n"
                .into(),
        ),
        start,
    ]);
    let mut shortcut_columns = Vec::new();
    let mut heading = false;
    let mut column = 0;
    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::TableHead) => heading = true,
            Event::End(TagEnd::TableHead) => heading = false,
            Event::Start(Tag::TableRow) => column = 0,
            Event::Start(Tag::TableCell) => {
                let cell = parser
                    .by_ref()
                    .take_while(|event| *event != Event::End(TagEnd::TableCell))
                    .collect::<Vec<_>>();
                table.push_back(event);
                let plain = match cell.as_slice() {
                    [Event::Text(text) | Event::Code(text)] => Some(text),
                    _ => None,
                };
                if heading {
                    shortcut_columns.push(plain.is_some_and(|text| {
                        matches!(
                            text.trim().to_ascii_lowercase().as_str(),
                            "按键"
                                | "快捷键"
                                | "键盘快捷键"
                                | "shortcut"
                                | "shortcuts"
                                | "keyboard shortcut"
                                | "keyboard shortcuts"
                        )
                    }));
                }
                let shortcut = !heading && shortcut_columns.get(column) == Some(&true);
                if let Some(text) = plain.filter(|text| shortcut && !text.trim().is_empty()) {
                    table.extend([
                        Event::InlineHtml("<kbd>".into()),
                        Event::Text(text.clone()),
                        Event::InlineHtml("</kbd>".into()),
                    ]);
                } else {
                    table.extend(cell);
                }
                table.push_back(Event::End(TagEnd::TableCell));
                column += 1;
                continue;
            }
            Event::End(TagEnd::Table) => {
                table.extend([event, Event::Html("</div>\n".into())]);
                break;
            }
            _ => {}
        }
        table.push_back(event);
    }
    table
}

fn contact_events<'a>(paragraph: Vec<Event<'a>>, output: &mut VecDeque<Event<'a>>) {
    if paragraph
        .iter()
        .any(|event| matches!(event, Event::InlineHtml(_) | Event::Html(_)))
    {
        output.extend(paragraph);
        return;
    }
    let mut link_depth = 0;
    for event in paragraph {
        match event {
            Event::Start(Tag::Link { .. } | Tag::Image { .. }) => link_depth += 1,
            Event::End(TagEnd::Link | TagEnd::Image) => link_depth -= 1,
            Event::Text(text) if link_depth == 0 && text.contains('@') => {
                link_emails(text, output);
                continue;
            }
            _ => {}
        }
        output.push_back(event);
    }
}

fn link_emails<'a>(text: CowStr<'a>, output: &mut VecDeque<Event<'a>>) {
    let mut cursor = 0;
    for (at, _) in text.match_indices('@') {
        let mailbox = text[cursor..at]
            .as_bytes()
            .iter()
            .rev()
            .take_while(|b| b.is_ascii_alphanumeric() || b"._+-".contains(b))
            .count();
        let start = at - mailbox;
        let suffix = &text[at + 1..];
        let host_end = suffix
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .unwrap_or(suffix.len());
        let domain = suffix[..host_end].trim_end_matches('.');
        let end = at + 1 + domain.len();
        let prefix = &text[..start];
        let local = &text[start..at];
        if local.is_empty()
            || local.starts_with('.')
            || local.ends_with('.')
            || local.contains("..")
            || prefix.ends_with(['@', '/'])
            || prefix.ends_with("mailto:")
            || text[end..].starts_with(['@', '/', '_'])
            || !domain.contains('.')
            || domain
                .split('.')
                .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
            || !domain
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_alphabetic()))
        {
            continue;
        }
        let address = &text[start..end];
        if start > cursor {
            output.push_back(Event::Text(text[cursor..start].to_owned().into()));
        }
        output.extend([
            Event::Start(Tag::Link {
                link_type: LinkType::Email,
                dest_url: address.to_owned().into(),
                title: "".into(),
                id: "".into(),
            }),
            Event::Text(address.to_owned().into()),
            Event::End(TagEnd::Link),
        ]);
        cursor = end;
    }
    if cursor == 0 {
        output.push_back(Event::Text(text));
    } else if cursor < text.len() {
        output.push_back(Event::Text(text[cursor..].to_owned().into()));
    }
}

/// Strips all Markdown/math syntax from `markdown` and returns plain text.
///
/// Used to build the client-side search index (`search_index.json`).
pub(crate) fn markdown_to_plain_text(markdown: &str) -> String {
    let (processed, _) = preprocess_math(markdown);
    let parser = Parser::new_ext(&processed, Options::all() & !Options::ENABLE_MATH);
    let mut text = String::new();

    for event in parser {
        match event {
            pulldown_cmark::Event::Text(t) | pulldown_cmark::Event::Code(t) => {
                text.push_str(&t);
                text.push(' ');
            }
            pulldown_cmark::Event::SoftBreak | pulldown_cmark::Event::HardBreak => {
                text.push(' ');
            }
            _ => {}
        }
    }

    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{markdown_to_html, markdown_to_plain_text, page_markdown_to_html};

    #[test]
    fn table_scroll_and_keyboard_markup_keep_cells_and_markdown_text() {
        let input = "| 功能 | 快捷键 |\n| --- | --- |\n| 打开终端 | Super + T |\n| 帮助 | `F1` |\n\n| Key | Value |\n| --- | --- |\n| Name | plain |\n";
        let html = markdown_to_html(input);
        assert_eq!(html.matches("class=\"table-scroll\"").count(), 2);
        assert_eq!(html.matches("</table>\n</div>").count(), 2);
        assert!(html.contains("<td>打开终端</td><td><kbd>Super + T</kbd></td>"));
        assert!(html.contains("<td>帮助</td><td><kbd>F1</kbd></td>"));
        assert!(html.contains("<td>Name</td><td>plain</td>"));
        assert!(markdown_to_plain_text(input).contains("Super + T"));
    }

    #[test]
    fn standalone_contact_addresses_keep_punctuation_and_explicit_links() {
        let input = "邮箱:hi+notes@example.org，或 mail@example.net.\n\n[already@example.net](https://example.net) 和 `code@example.net`\n\n<code>raw@example.net</code>";
        let html = page_markdown_to_html(input);
        assert_eq!(html.matches("href=\"mailto:").count(), 2, "{html}");
        assert!(html.contains("href=\"mailto:hi+notes@example.org\">hi+notes@example.org</a>，"));
        assert!(html.contains("href=\"mailto:mail@example.net\">mail@example.net</a>."));
        assert!(html.contains("href=\"https://example.net\">already@example.net</a>"));
        assert!(html.contains("<code>code@example.net</code>"));
        assert!(html.contains("<code>raw@example.net</code>"));
        assert!(!markdown_to_html(input).contains("mailto:"));
    }

    #[test]
    fn math_preserves_code_blocks_and_searchable_examples() {
        for source in [
            "````markdown\n```\n$x$\n```\n````\n",
            "~~~~markdown\n```\n$x$\n~~~\n~~~~\n",
            "    $x$\n\n    $$y$$\n",
            "> ````markdown\n> ```\n> $x$\n> ````\n",
            "- example\n\n      $x$\n",
            "```text\n$x$\n",
            "中文\n\n    $x$\n",
            "中文\r\n\r\n````markdown\r\n```\r\n$x$\r\n````\r\n",
        ] {
            let html = markdown_to_html(source);
            assert!(html.contains("<pre><code"), "{source:?}: {html}");
            assert!(html.contains("$x$"), "{source:?}: {html}");
            assert!(!html.contains("katex"), "{source:?}: {html}");
            assert!(markdown_to_plain_text(source).contains("$x$"), "{source:?}");
        }
    }

    #[test]
    fn math_preserves_multiline_and_variable_length_inline_code() {
        for (source, literal) in [
            ("`$x$`", "$x$"),
            ("``a ` $x$``", "a ` $x$"),
            ("`line\n$x$`", "line $x$"),
            ("`line\n$$\nline`", "line $$ line"),
        ] {
            assert_eq!(
                markdown_to_html(source),
                format!("<p><code>{literal}</code></p>\n"),
            );
            assert_eq!(markdown_to_plain_text(source), literal);
        }
        let html = markdown_to_html("``a ` $x$`` and $y^2$");
        assert!(html.contains("<code>a ` $x$</code>"));
        assert!(html.contains("class=\"katex\""));
        assert!(!html.contains("data-math-placeholder"));
        let html = markdown_to_html("`line\n$x$` and $y^2$");
        assert!(html.contains("<code>line $x$</code>"));
        assert_eq!(html.matches("class=\"katex\"").count(), 1);
        let html = markdown_to_html("Price $5 then `$x$`");
        assert!(html.contains("<code>$x$</code>"));
        assert!(!html.contains("katex"));
    }

    #[test]
    fn math_renders_inline_and_display_formulas() {
        let html = markdown_to_html("中文 $x^2$ 与 $ x^2 $\n\n$$y^2$$\n\n$$\nz^2\n$$\n");
        assert_eq!(html.matches("class=\"katex\"").count(), 4);
        assert_eq!(html.matches("class=\"katex-display\"").count(), 2);
        assert!(!html.contains("data-math-placeholder"));
        assert_eq!(
            markdown_to_plain_text("Find `$x$` and $y^2$"),
            "Find $x$ and"
        );
    }

    #[test]
    fn escaped_currency_and_unclosed_math_remain_literal() {
        for (source, expected) in [
            (r"Price \$5 and \$10", "<p>Price $5 and $10</p>\n"),
            ("Price $5", "<p>Price $5</p>\n"),
            ("$$\nx + y", "<p>$$\nx + y</p>\n"),
        ] {
            assert_eq!(markdown_to_html(source), expected);
        }
    }

    #[test]
    fn backticks_inside_an_open_formula_remain_latex() {
        let html = markdown_to_html(r"$\text{`hello`}$");
        assert_eq!(html.matches("class=\"katex\"").count(), 1, "{html}");
        assert!(!html.contains("<code>"), "{html}");
        let html = markdown_to_html(r"`$literal$` then $\text{`hello`}$ and $ x $");
        assert_eq!(html.matches("class=\"katex\"").count(), 2, "{html}");
        assert!(html.contains("<code>$literal$</code>"), "{html}");
    }
}

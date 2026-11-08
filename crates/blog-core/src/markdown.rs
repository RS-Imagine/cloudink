use pulldown_cmark::{html, Options, Parser};

use crate::math::{preprocess_math, render_math_expr};

/// Converts Markdown source to an HTML string.
///
/// The pipeline is:
/// 1. Pre-process math fences (`$`, `$$`) → replace with placeholders.
/// 2. Run pulldown-cmark with all extensions enabled.
/// 3. Substitute placeholders with KaTeX-rendered HTML.
pub(crate) fn markdown_to_html(markdown: &str) -> String {
    let (processed, math_segments) = preprocess_math(markdown);
    // Math is already handled above. A second math pass could consume a
    // literal dollar inside code after an unmatched dollar in ordinary text.
    let parser = Parser::new_ext(&processed, Options::all() & !Options::ENABLE_MATH);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);

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
    use super::{markdown_to_html, markdown_to_plain_text};

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

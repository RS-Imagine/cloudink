use katex::{render_to_string, KatexContext, Settings};
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::ops::Range;

use crate::utils::escape_html;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// A parsed math expression together with its placeholder token.
///
/// During pre-processing every `$...$` / `$$...$$` span is replaced by a
/// unique placeholder string so that pulldown-cmark does not interpret the
/// dollar signs.  After HTML is generated the placeholders are substituted
/// back with the rendered KaTeX output.
#[derive(Debug, Clone)]
pub(crate) struct MathSegment {
    /// The placeholder string embedded in the Markdown before cmark runs.
    pub placeholder: String,
    /// The raw LaTeX source of the expression.
    pub math: String,
    /// `true` for display-mode (`$$...$$`), `false` for inline (`$...$`).
    pub display_mode: bool,
}

// ---------------------------------------------------------------------------
// Public pre-processor
// ---------------------------------------------------------------------------

/// Scans `markdown` for math fences (`$`, `$$`) and replaces every expression
/// with a unique HTML placeholder.
///
/// Returns the transformed Markdown string and the list of [`MathSegment`]s
/// needed to restore rendered KaTeX HTML after cmark finishes.
pub(crate) fn preprocess_math(markdown: &str) -> (String, Vec<MathSegment>) {
    let mut output = String::new();
    // Use the same Markdown grammar as rendering, including nested/indented
    // blocks and multiline code spans. Keep the existing formula syntax.
    // Disable math in this boundary pass so an unmatched dollar before code
    // cannot make the parser consume a literal dollar inside that code.
    let code: Vec<(Range<usize>, bool)> =
        Parser::new_ext(markdown, Options::all() & !Options::ENABLE_MATH)
            .into_offset_iter()
            .filter_map(|(event, range)| match event {
                Event::Start(Tag::CodeBlock(_)) => Some((range, true)),
                Event::Code(_) => Some((range, false)),
                _ => None,
            })
            .collect();
    let mut code_index = 0;
    let mut offset = 0;
    let mut in_block_math = false;
    let mut block_math = String::new();
    let mut math_segments = Vec::new();
    let mut math_counter = 0usize;

    for raw_line in markdown.split_inclusive('\n') {
        let line_offset = offset;
        offset += raw_line.len();
        let line = raw_line
            .strip_suffix('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .unwrap_or(raw_line);
        let trimmed = line.trim();
        while code_index < code.len() && code[code_index].0.end <= line_offset {
            code_index += 1;
        }
        let code = &code[code_index..];
        if !in_block_math
            && code
                .first()
                .is_some_and(|(r, block)| *block && r.start < offset)
        {
            output.push_str(line);
            output.push('\n');
            continue;
        }

        // Block math delimiter `$$` on its own line.
        let delimiter_offset = line_offset + line.len() - line.trim_start().len();
        let delimiter_in_code = code
            .first()
            .is_some_and(|(r, _)| r.contains(&delimiter_offset));
        if trimmed == "$$" && (in_block_math || !delimiter_in_code) {
            if in_block_math {
                let placeholder = block_placeholder(math_counter);
                math_segments.push(MathSegment {
                    placeholder: placeholder.clone(),
                    math: block_math.trim().to_string(),
                    display_mode: true,
                });
                math_counter += 1;
                output.push_str(&placeholder);
                output.push('\n');
                block_math.clear();
                in_block_math = false;
            } else {
                in_block_math = true;
            }
            continue;
        }

        if in_block_math {
            block_math.push_str(line);
            block_math.push('\n');
            continue;
        }

        // Single-line block math `$$...$$` (longer than 4 chars).
        if !delimiter_in_code
            && trimmed.starts_with("$$")
            && trimmed.ends_with("$$")
            && trimmed.len() > 4
        {
            let inner = trimmed
                .trim_start_matches("$$")
                .trim_end_matches("$$")
                .trim();
            let placeholder = block_placeholder(math_counter);
            math_segments.push(MathSegment {
                placeholder: placeholder.clone(),
                math: inner.to_string(),
                display_mode: true,
            });
            math_counter += 1;
            output.push_str(&placeholder);
            output.push('\n');
            continue;
        }

        // Inline math `$...$` anywhere on the line.
        output.push_str(&render_inline_math(
            line,
            line_offset,
            code,
            &mut math_segments,
            &mut math_counter,
        ));
        output.push('\n');
    }

    // Unclosed block-math fence: emit as-is so the user sees the raw text.
    if in_block_math {
        output.push_str("$$\n");
        output.push_str(&block_math);
    }

    (output, math_segments)
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/// Renders a single LaTeX expression to HTML via KaTeX.
///
/// On KaTeX error the expression is returned as an HTML `<code>` block so
/// the page still renders rather than panicking.
pub(crate) fn render_math_expr(math: &str, display_mode: bool) -> String {
    let ctx = KatexContext::default();
    let mut settings = Settings::default();
    settings.display_mode = display_mode;
    settings.throw_on_error = false;

    render_to_string(&ctx, math, &settings)
        .unwrap_or_else(|_| format!("<code>{}</code>", escape_html(math)))
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn block_placeholder(n: usize) -> String {
    format!(
        r#"<div class="math-block" data-math-placeholder="{}"></div>"#,
        n
    )
}

/// Scans a single line for inline `$...$` spans and replaces each with a
/// placeholder, collecting the corresponding [`MathSegment`].
fn render_inline_math(
    line: &str,
    line_offset: usize,
    code: &[(Range<usize>, bool)],
    math_segments: &mut Vec<MathSegment>,
    math_counter: &mut usize,
) -> String {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut output = String::new();
    let mut index = 0;
    let mut code_index = 0;

    while index < chars.len() {
        let (offset, ch) = chars[index];
        let position = line_offset + offset;
        while code_index < code.len() && code[code_index].0.end <= position {
            code_index += 1;
        }
        if code
            .get(code_index)
            .is_some_and(|(r, _)| r.contains(&position))
        {
            output.push(ch);
            index += 1;
            continue;
        }

        // Pass through escaped characters verbatim.
        if ch == '\\' {
            output.push(ch);
            if let Some((_, next)) = chars.get(index + 1) {
                output.push(*next);
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        if ch == '$' {
            // `$$` at this position means a block-math delimiter; pass through.
            if chars.get(index + 1).map(|(_, next)| *next) == Some('$') {
                output.push_str("$$");
                index += 2;
                continue;
            }

            // Try to find the closing `$`.
            let mut math = String::new();
            let mut lookahead = index + 1;
            let mut code_lookahead = code_index;
            let mut found_closing = false;

            while lookahead < chars.len() {
                let (next_offset, next_ch) = chars[lookahead];
                let next_position = line_offset + next_offset;
                while code_lookahead < code.len() && code[code_lookahead].0.end <= next_position {
                    code_lookahead += 1;
                }

                if next_ch == '\\' {
                    math.push(next_ch);
                    if let Some((_, escaped)) = chars.get(lookahead + 1) {
                        math.push(*escaped);
                        lookahead += 2;
                    } else {
                        lookahead += 1;
                    }
                    continue;
                }

                // A formula opened before backticks may contain them as TeX.
                // Only a dollar outside code can close it, so an unmatched
                // dollar in ordinary text cannot consume a code span's dollar.
                if next_ch == '$'
                    && !code
                        .get(code_lookahead)
                        .is_some_and(|(r, _)| r.contains(&next_position))
                {
                    found_closing = true;
                    break;
                }

                math.push(next_ch);
                lookahead += 1;
            }

            if found_closing {
                let placeholder = format!(
                    r#"<span class="math math-inline" data-math-placeholder="{}"></span>"#,
                    *math_counter
                );
                math_segments.push(MathSegment {
                    placeholder: placeholder.clone(),
                    math,
                    display_mode: false,
                });
                *math_counter += 1;
                output.push_str(&placeholder);
                index = lookahead + 1;
                continue;
            }
        }

        output.push(ch);
        index += 1;
    }

    output
}

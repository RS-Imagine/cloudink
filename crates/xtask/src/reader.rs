use crate::bundle::{Bundler, Source, gzip_size};
use anyhow::{Context, Result, ensure};
use regex::{Captures, Regex};
use serde_json::{Value, json};
use std::fmt::Write;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

const BROWSER_TARGETS: &str = "chrome100,firefox100,safari15";

const HEADERS: &str = concat!(
    "/client.js\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=0, must-revalidate\n",
    "/theme.js\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=0, must-revalidate\n",
    "/styles.css\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=0, must-revalidate\n",
    "/favicon.svg\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: sandbox; default-src 'none'\n",
    "/manifest.webmanifest\n  X-Content-Type-Options: nosniff\n  Content-Type: application/manifest+json; charset=utf-8\n",
    "/sw.js\n  X-Content-Type-Options: nosniff\n  Content-Type: application/javascript; charset=utf-8\n  Cache-Control: public, max-age=0, must-revalidate\n",
    "/reader-assets/*\n  X-Content-Type-Options: nosniff\n",
);

pub fn seed(content: &Path, output: &Path) -> Result<()> {
    // The template build uses a synthetic site in its own working directory.
    for path in [content, output] {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != ErrorKind::NotFound
        {
            return Err(error).with_context(|| format!("clear {}", path.display()));
        }
    }
    fs::create_dir_all(content)?;
    fs::write(
        content.join("site.toml"),
        concat!(
            "title = \"CloudInk\"\nsubtitle = \"记录所见，整理所想\"\nauthor = \"CloudInk\"\n",
            "description = \"使用后台设置你的博客，开始第一篇文章。\"\n",
        ),
    )?;
    fs::write(
        content.join("about.md"),
        "+++\ntitle = \"About\"\n+++\n\nWelcome to my blog.",
    )?;
    Ok(())
}

pub fn bundle(
    root: &Path,
    output: &Path,
    worker_assets: &Path,
    vendor: &Path,
    bundler: &Bundler,
) -> Result<()> {
    let site: Value = serde_json::from_slice(&fs::read(output.join("site.json"))?)?;
    let version = site["template_version"]
        .as_str()
        .context("missing Rust template fingerprint")?;
    ensure!(
        version.len() == 64
            && version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid Rust template fingerprint"
    );
    fs::write(worker_assets.join("template-version"), version)?;

    let motion = fs::read_to_string(root.join("assets/motion.js"))?;
    let mobile = fs::read_to_string(root.join("assets/mobile.js"))?;
    let runtime = fs::read_to_string(root.join("assets/reader-runtime.js"))?;
    let client = fs::read_to_string(root.join("crates/blog-core/src/assets/client.js"))?;
    let source = format!(
        "import Swup from 'swup';\nwindow.Swup = Swup;\n{motion}\n{mobile}\n{runtime}\n{client}"
    );
    bundler.js(
        ".",
        Source::Inline {
            body: &source,
            name: "public-client.js",
        },
        &output.join("client.js"),
        "iife",
        &[],
    )?;

    styles(root, output, bundler)?;
    let reader = output.join("reader-assets");
    fs::create_dir_all(reader.join("fonts"))?;
    bundler.js(
        ".",
        Source::Inline {
            body: "import hljs from '../node_modules/highlight.js/lib/common'; window.CloudInkHighlighter = hljs;",
            name: "<stdin>",
        },
        &reader.join("highlight.js"),
        "iife",
        &[],
    )?;
    bundler.js(
        ".",
        Source::File("assets/reader-share-card.js"),
        &reader.join("share-card.js"),
        "esm",
        &[],
    )?;
    let modules = vendor.join("node_modules");
    editorial_fonts(&modules, &reader)?;
    code_assets(&modules, &reader, bundler)?;

    for name in ["theme.js", "manifest.webmanifest", "sw.js"] {
        fs::copy(root.join("assets").join(name), output.join(name))?;
    }
    fs::write(output.join("_headers"), HEADERS)?;
    Ok(())
}

fn styles(root: &Path, output: &Path, bundler: &Bundler) -> Result<()> {
    let path = output.join("styles.css");
    let source = fs::read_to_string(&path)?;
    fs::write(root.join("build-work/web-styles.source.css"), &source)?;
    let mut remaining = source.as_str();
    let mut parts = Vec::new();
    for file in ["assets/design-tokens.css", "assets/design-foundation.css"] {
        let shared = fs::read_to_string(root.join(file))?;
        let (before, after) = remaining
            .split_once(shared.as_str())
            .with_context(|| format!("missing shared stylesheet {file}"))?;
        if !before.is_empty() {
            parts.push(bundler.css(before, BROWSER_TARGETS)?);
        }
        parts.push(shared);
        remaining = after;
    }
    if !remaining.is_empty() {
        parts.push(bundler.css(remaining, BROWSER_TARGETS)?);
    }
    let output = parts.join("\n");
    fs::write(path, &output)?;
    println!(
        "{}",
        json!({
            "asset": "public/styles.css",
            "gzip": gzip_size(output.as_bytes())?,
            "sourceGzip": gzip_size(source.as_bytes())?,
        })
    );
    Ok(())
}

fn editorial_fonts(modules: &Path, reader: &Path) -> Result<()> {
    let sc = modules.join("@fontsource/noto-serif-sc");
    let latin = modules.join("@fontsource/noto-serif");
    let fonts = reader.join("fonts");
    let face = Regex::new(r"@font-face\s*\{[^}]+\}")?;
    let unicode = Regex::new(r"unicode-range:\s*([^;]+);")?;
    let filename = Regex::new(r"url\(\./files/([a-z0-9-]+\.woff2)\)")?;
    let declaration = Regex::new(r"src:[^;]+;")?;
    let mut stylesheet = String::new();

    for weight in [400, 600] {
        let source = fs::read_to_string(sc.join(format!("{weight}.css")))?;
        let filtered = replace(&face, &source, |captures| {
            let rule = &captures[0];
            let ranges = unicode
                .captures(rule)
                .map(|capture| retained_ranges(&capture[1]))
                .unwrap_or_default();
            if ranges.is_empty() {
                Ok(String::new())
            } else {
                Ok(unicode
                    .replace(rule, format!("unicode-range:{};", ranges.join(",")))
                    .into_owned())
            }
        })?;
        let mut any = false;
        for capture in filename.captures_iter(&filtered) {
            let file = &capture[1];
            fs::copy(sc.join("files").join(file), fonts.join(file))?;
            any = true;
        }
        ensure!(any, "missing editorial WOFF2 slices");
        stylesheet.push_str(&replace(&declaration, &filtered, |capture| {
            let file = filename
                .captures(&capture[0])
                .context("missing editorial font source")?;
            Ok(format!(
                "src:url(/reader-assets/fonts/{}) format(\"woff2\");",
                &file[1]
            ))
        })?);
    }

    let latin_face = Regex::new(
        r"/\*\s*(noto-serif-(?:latin|latin-ext)-(?:400|600)-(?:normal|italic))\s*\*/\s*(@font-face\s*\{[^}]+\})",
    )?;
    for sheet in ["400.css", "400-italic.css", "600.css", "600-italic.css"] {
        let css = fs::read_to_string(latin.join(sheet))?;
        let matches = latin_face.captures_iter(&css).collect::<Vec<_>>();
        ensure!(
            matches.len() == 2,
            "expected Latin and Latin Extended slices in {sheet}"
        );
        for capture in matches {
            let label = &capture[1];
            let rule = &capture[2];
            let file = filename
                .captures(rule)
                .with_context(|| format!("missing font source in {label}"))?;
            let file = &file[1];
            fs::copy(latin.join("files").join(file), fonts.join(file))?;
            let replacement = format!("src:url(/reader-assets/fonts/{file}) format(\"woff2\");");
            write!(
                stylesheet,
                "\n/* {label} */\n{}\n",
                declaration.replace_all(rule, replacement)
            )?;
        }
    }
    fs::write(reader.join("editorial-font.css"), stylesheet)?;
    let sc_license = fs::read_to_string(sc.join("LICENSE"))?;
    let latin_license = fs::read_to_string(latin.join("LICENSE"))?;
    fs::write(
        reader.join("editorial-font-LICENSE.txt"),
        format!(
            "=== Noto Serif SC (@fontsource/noto-serif-sc) ===\n{}\n\n=== Noto Serif (@fontsource/noto-serif) ===\n{}\n",
            sc_license.trim(),
            latin_license.trim()
        ),
    )?;
    Ok(())
}

fn retained_ranges(ranges: &str) -> Vec<String> {
    let mut output = Vec::new();
    for range in ranges.split(',') {
        let range = range.trim();
        let range = range
            .strip_prefix("U+")
            .or_else(|| range.strip_prefix("u+"))
            .unwrap_or(range);
        let (first, last) = range.split_once('-').unwrap_or((range, range));
        if let (Ok(first), Ok(last)) = (
            u32::from_str_radix(first, 16),
            u32::from_str_radix(last, 16),
        ) {
            for (lower, upper) in [
                (0x2e80, 0x9fff),
                (0xf900, 0xfaff),
                (0xff00, 0xffef),
                (0x20000, 0x323af),
            ] {
                let (start, end) = (first.max(lower), last.min(upper));
                if start <= end {
                    output.push(if start == end {
                        format!("U+{start:x}")
                    } else {
                        format!("U+{start:x}-{end:x}")
                    });
                }
            }
        }
    }
    output
}

fn code_assets(modules: &Path, reader: &Path, bundler: &Bundler) -> Result<()> {
    let highlight = modules.join("highlight.js");
    let light = fs::read_to_string(highlight.join("styles/github.min.css"))?;
    let dark = fs::read_to_string(highlight.join("styles/github-dark.min.css"))?;
    let themed = bundler.css(
        &format!(
            ":root:not([data-theme=\"dark\"]) {{{light}}}\n:root[data-theme=\"dark\"] {{{dark}}}"
        ),
        BROWSER_TARGETS,
    )?;
    fs::write(reader.join("code.css"), themed)?;
    fs::copy(
        highlight.join("LICENSE"),
        reader.join("highlight-LICENSE.txt"),
    )?;

    let math = modules.join("katex");
    let source = fs::read_to_string(math.join("dist/katex.min.css"))?;
    let declaration = Regex::new(r"src:[^;}]+([;}]|$)")?;
    let font = Regex::new(r"url\(([^)]+\.woff2)\)")?;
    let css = replace(&declaration, &source, |capture| {
        let file = font
            .captures(&capture[0])
            .context("KaTeX font has no WOFF2 source")?;
        Ok(format!(
            "src:url({}) format(\"woff2\"){}",
            &file[1], &capture[1]
        ))
    })?;
    fs::write(reader.join("katex.css"), css)?;
    for entry in fs::read_dir(math.join("dist/fonts"))? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|ext| ext == "woff2") {
            fs::copy(entry.path(), reader.join("fonts").join(entry.file_name()))?;
        }
    }
    fs::copy(math.join("LICENSE"), reader.join("katex-LICENSE.txt"))?;
    Ok(())
}

fn replace(
    pattern: &Regex,
    source: &str,
    convert: impl Fn(&Captures<'_>) -> Result<String>,
) -> Result<String> {
    let mut output = String::new();
    let mut cursor = 0;
    for capture in pattern.captures_iter(source) {
        let matched = capture.get(0).expect("full match");
        output.push_str(&source[cursor..matched.start()]);
        output.push_str(&convert(&capture)?);
        cursor = matched.end();
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

use anyhow::Result;
use blog_core::build_site;
use std::env;

fn main() -> Result<()> {
    let command = env::args().nth(1).unwrap_or_else(|| "build".to_string());

    match command.as_str() {
        "build" => {
            let content = env::var("BLOG_CONTENT_ROOT").unwrap_or_else(|_| "content".to_owned());
            let output = env::var("BLOG_OUTPUT_ROOT").unwrap_or_else(|_| "public".to_owned());
            build_site(&content, &output)?;
            println!("Built static site into {output}");
            Ok(())
        }
        other => {
            eprintln!("Unknown command: {other}");
            eprintln!("Usage: cargo run -p sitegen -- build");
            std::process::exit(1);
        }
    }
}

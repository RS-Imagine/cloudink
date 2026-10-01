use anyhow::{Context, Result};
use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{Html, Redirect},
    routing::{get, post},
    Form, Json, Router,
};
use blog_core::content::{self, PostDraft};
use blog_core::models::FrontMatter;
use blog_core::utils::escape_html;
use chrono::Local;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    content_root: PathBuf,
    output_root: PathBuf,
}

// ---------------------------------------------------------------------------
// Form types
// ---------------------------------------------------------------------------

/// Raw form data received from the post editor HTML form.
#[derive(Debug, Deserialize)]
struct PostForm {
    title: String,
    slug: Option<String>,
    description: String,
    body_markdown: String,
    /// Present when the "Save as draft" checkbox is checked; absent otherwise.
    draft: Option<String>,
    date: Option<String>,
}

/// Validated, normalised form data ready for display in the editor template.
#[derive(Debug, Clone)]
struct PostFormData {
    title: String,
    slug: String,
    description: String,
    body_markdown: String,
    date: String,
    draft: bool,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let state = AppState {
        content_root: PathBuf::from("content"),
        output_root: PathBuf::from("public"),
    };

    let app = Router::new()
        .route("/", get(dashboard))
        .route("/posts/new", get(new_post_form).post(create_post))
        .route("/posts/{slug}/edit", get(edit_post_form).post(update_post))
        .route("/posts/{slug}/delete", post(delete_post_handler))
        .route("/build", post(rebuild_site))
        .route("/api/posts", get(list_posts))
        .route("/api/upload", post(upload_image))
        .route("/api/cleanup-images", post(cleanup_images))
        .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024))
        .with_state(state);

    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("valid local address");
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;

    println!("Admin app listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn dashboard(
    State(state): State<AppState>,
) -> Result<Html<String>, (StatusCode, String)> {
    let posts = content::load_posts(&state.content_root).map_err(internal_error)?;
    Ok(Html(render_dashboard(&posts)))
}

async fn new_post_form() -> Html<String> {
    Html(render_post_form(
        "New Post",
        "/posts/new",
        "Create Post",
        &PostFormData {
            title: String::new(),
            slug: String::new(),
            description: String::new(),
            body_markdown: String::new(),
            date: today_string(),
            draft: false,
        },
    ))
}

async fn edit_post_form(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Html<String>, (StatusCode, String)> {
    let post = content::load_post_by_slug(&state.content_root, &slug)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("post {slug} not found")))?;

    let action = format!("/posts/{}/edit", escape_html(&slug));
    Ok(Html(render_post_form(
        &format!("Edit: {}", post.title()),
        &action,
        "Save Changes",
        &PostFormData {
            title: post.title().to_string(),
            slug: post.slug().to_string(),
            description: post.description().to_string(),
            body_markdown: post.body_markdown.clone(),
            date: post.date().to_string(),
            draft: post.draft(),
        },
    )))
}

async fn create_post(
    State(state): State<AppState>,
    Form(input): Form<PostForm>,
) -> Result<Redirect, (StatusCode, String)> {
    save_post_form(&state.content_root, input, None, false).map_err(internal_error)?;
    Ok(Redirect::to("/"))
}

async fn update_post(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Form(input): Form<PostForm>,
) -> Result<Redirect, (StatusCode, String)> {
    let final_slug =
        save_post_form(&state.content_root, input, Some(&slug), true).map_err(internal_error)?;
    // If the slug changed, delete the old file so we don't leave an orphan.
    if final_slug != slug {
        content::delete_post(&state.content_root, &slug).map_err(internal_error)?;
    }
    Ok(Redirect::to("/"))
}

async fn delete_post_handler(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Redirect, (StatusCode, String)> {
    content::delete_post(&state.content_root, &slug).map_err(internal_error)?;
    Ok(Redirect::to("/"))
}

async fn rebuild_site(
    State(state): State<AppState>,
) -> Result<Redirect, (StatusCode, String)> {
    blog_core::build_site(&state.content_root, &state.output_root).map_err(internal_error)?;
    Ok(Redirect::to("/"))
}

async fn cleanup_images(
    State(state): State<AppState>,
) -> Result<Html<String>, (StatusCode, String)> {
    let posts = content::load_posts(&state.content_root).map_err(internal_error)?;
    let mut referenced_images = HashSet::new();

    for post in &posts {
        let body = &post.body_markdown;
        let mut start_idx = 0;
        while let Some(idx) = body[start_idx..].find("/images/") {
            let actual_idx = start_idx + idx;
            let img_start = actual_idx + 8; // skip "/images/"

            let mut img_end = img_start;
            for ch in body[img_start..].chars() {
                if ch == ')' || ch == '"' || ch.is_whitespace() {
                    break;
                }
                img_end += ch.len_utf8();
            }

            let img_name = &body[img_start..img_end];
            if !img_name.is_empty() {
                referenced_images.insert(img_name.to_string());
            }
            start_idx = img_end;
        }
    }

    let images_dir = state.content_root.join("static").join("images");
    let mut deleted_count = 0u32;

    if images_dir.exists() {
        if let Ok(entries) = fs::read_dir(&images_dir) {
            for entry in entries.flatten() {
                if let Ok(ty) = entry.file_type() {
                    if ty.is_file() {
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        if !referenced_images.contains(&file_name) {
                            if fs::remove_file(entry.path()).is_ok() {
                                deleted_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(Html(render_page(
        "Cleanup Complete",
        &format!(
            r#"<article class="panel form-panel">
  <div class="panel-header">
    <div>
      <span class="badge">Cleanup complete</span>
      <h1>Cleaned up images</h1>
    </div>
  </div>
  <p>Deleted {} unused images.</p>
  <div class="form-actions" style="margin-top: 20px;">
    <a class="button primary" href="/">Back to Dashboard</a>
  </div>
</article>"#,
            deleted_count
        ),
    )))
}

async fn list_posts(
    State(state): State<AppState>,
) -> Result<Json<Vec<content::Post>>, (StatusCode, String)> {
    let posts = content::load_posts(&state.content_root).map_err(internal_error)?;
    Ok(Json(posts))
}

async fn upload_image(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let images_dir = state.content_root.join("static").join("images");
    fs::create_dir_all(&images_dir).map_err(internal_error)?;

    let mut url = String::new();

    while let Some(field) = multipart.next_field().await.map_err(internal_error)? {
        let name = field.name().unwrap_or("").to_string();
        if name == "image" || name == "file" {
            let file_name = field.file_name().unwrap_or("image.png").to_string();
            // Strip path separators to prevent directory traversal.
            let file_name = file_name.replace('/', "").replace('\\', "");
            let data = field.bytes().await.map_err(internal_error)?;
            let file_path = images_dir.join(&file_name);
            fs::write(&file_path, &data).map_err(internal_error)?;
            url = format!("/images/{}", file_name);
            break;
        }
    }

    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No file provided".to_string()));
    }

    Ok(Json(serde_json::json!({ "url": url })))
}

// ---------------------------------------------------------------------------
// Business logic helpers
// ---------------------------------------------------------------------------

/// Validates the incoming form, constructs a [`PostDraft`], and persists it.
/// Returns the final slug so the caller can detect slug changes.
fn save_post_form(
    content_root: &std::path::Path,
    input: PostForm,
    existing_slug: Option<&str>,
    is_update: bool,
) -> Result<String> {
    let slug = normalized_slug(&input, existing_slug);
    let date = input
        .date
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(today_string);

    // Only set `updated` when this is an explicit save of existing content,
    // not on initial creation.
    let updated = is_update.then(today_string);

    let draft = PostDraft {
        front_matter: FrontMatter {
            title: input.title,
            date,
            updated,
            slug: slug.clone(),
            description: input.description,
            draft: input.draft.is_some(),
        },
        body_markdown: input.body_markdown,
    };

    content::save_post(content_root, &draft)?;
    Ok(slug)
}

/// Returns the slug to use for the saved post.
///
/// Priority: explicit slug from form → existing slug (for edits) → auto-generated from title.
fn normalized_slug(input: &PostForm, existing_slug: Option<&str>) -> String {
    let slug = input.slug.as_deref().unwrap_or_default().trim();
    if !slug.is_empty() {
        return slug.to_string();
    }
    if let Some(existing) = existing_slug {
        return existing.to_string();
    }
    content::slugify(&input.title)
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

fn render_dashboard(posts: &[content::Post]) -> String {
    let rows: String = posts
        .iter()
        .map(|post| {
            let status = if post.draft() { "Draft" } else { "Published" };
            format!(
                r#"<article class="card">
  <div class="card-top">
    <div>
      <h3>{title}</h3>
      <p class="meta">{date} · <code>{slug}</code> · <span class="status">{status}</span></p>
      <p>{description}</p>
    </div>
    <div class="actions">
      <a class="button" href="/posts/{slug}/edit">Edit</a>
      <form method="post" action="/posts/{slug}/delete" onsubmit="return confirm('Delete this post?');">
        <button class="button danger" type="submit">Delete</button>
      </form>
    </div>
  </div>
</article>"#,
                title = escape_html(post.title()),
                date = escape_html(post.date()),
                slug = escape_html(post.slug()),
                status = status,
                description = escape_html(post.description()),
            )
        })
        .collect();

    render_page(
        "CloudInk admin",
        &format!(
            r#"<section class="hero">
  <div>
    <span class="badge">Local-only admin</span>
    <h1>Blog control panel</h1>
    <p>Manage Markdown posts on your machine, then rebuild the static site when you are ready to push to GitHub.</p>
  </div>
  <div class="hero-actions">
    <a class="button primary" href="/posts/new">New Post</a>
    <form method="post" action="/build">
      <button class="button" type="submit">Rebuild Site</button>
    </form>
    <form method="post" action="/api/cleanup-images">
      <button class="button danger" type="button" onclick="if(confirm('Are you sure you want to delete all unused images?')) this.form.submit();">Clean Up Images</button>
    </form>
  </div>
</section>
<section class="panel">
  <h2>Posts ({count})</h2>
  {rows}
</section>"#,
            count = posts.len(),
            rows = rows,
        ),
    )
}

fn render_post_form(title: &str, action: &str, submit_label: &str, data: &PostFormData) -> String {
    render_page(
        title,
        &format!(
            r#"<section class="panel form-panel">
  <div class="panel-header">
    <div>
      <span class="badge">Markdown editor</span>
      <h1>{title}</h1>
    </div>
    <a class="button" href="/">Back</a>
  </div>
  <form method="post" action="{action}" class="post-form">
    <label>
      <span>Title</span>
      <input name="title" value="{title_value}" required>
    </label>
    <label>
      <span>Slug</span>
      <input name="slug" value="{slug_value}" placeholder="optional if you want auto-generated slug">
    </label>
    <label>
      <span>Date</span>
      <input name="date" value="{date_value}" placeholder="YYYY-MM-DD">
    </label>
    <label>
      <span>Description</span>
      <input name="description" value="{description_value}" required>
    </label>
    <label class="checkbox-row">
      <input type="checkbox" name="draft" value="true" {draft_checked}>
      <span>Save as draft</span>
    </label>
    <label>
      <div style="display: flex; justify-content: space-between; align-items: baseline;">
        <span>Body</span>
        <label for="image-upload" style="cursor: pointer; color: var(--accent); font-size: 0.9em; font-weight: normal;">Upload Image...</label>
        <input type="file" id="image-upload" accept="image/*" style="display: none;" onchange="uploadImage(this)">
      </div>
      <textarea id="body_markdown" name="body_markdown" rows="18" required>{body_value}</textarea>
    </label>
    <div class="form-actions">
      <button class="button primary" type="submit">{submit_label}</button>
      <a class="button" href="/">Cancel</a>
    </div>
  </form>
  <script>
  async function uploadImage(input) {{
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {{
      const res = await fetch('/api/upload', {{ method: 'POST', body: formData }});
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.url) {{
        const textarea = document.getElementById('body_markdown');
        const textToInsert = `\n![${{file.name}}](${{data.url}})\n`;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + textToInsert + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
        textarea.focus();
      }}
    }} catch (e) {{
      alert('Upload failed: ' + e);
    }}
    input.value = '';
  }}

  document.getElementById('body_markdown').addEventListener('paste', async (e) => {{
    const items = (e.clipboardData || window.clipboardData).items;
    for (let index in items) {{
      const item = items[index];
      if (item.kind === 'file' && item.type.startsWith('image/')) {{
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const formData = new FormData();
        formData.append('file', file, file.name || 'pasted-image.png');
        try {{
          const res = await fetch('/api/upload', {{ method: 'POST', body: formData }});
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          if (data.url) {{
            const textarea = document.getElementById('body_markdown');
            const textToInsert = `\n![${{file.name || 'image'}}](${{data.url}})\n`;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + textToInsert + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
            textarea.focus();
          }}
        }} catch (err) {{
          alert('Upload pasted image failed: ' + err);
        }}
        break;
      }}
    }}
  }});
  </script>
</section>"#,
            title = escape_html(title),
            action = escape_html(action),
            submit_label = escape_html(submit_label),
            title_value = escape_html(&data.title),
            slug_value = escape_html(&data.slug),
            date_value = escape_html(&data.date),
            description_value = escape_html(&data.description),
            draft_checked = if data.draft { "checked" } else { "" },
            body_value = escape_html(&data.body_markdown),
        ),
    )
}

/// Assembles a complete admin HTML page with inline styles.
fn render_page(title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f4efe7;
      --panel: rgba(255, 253, 248, 0.9);
      --panel-solid: #fffdf8;
      --text: #1f2328;
      --muted: #5c6670;
      --border: #ded4c7;
      --accent: #0f766e;
      --accent-strong: #115e59;
      --danger: #b42318;
      --shadow: 0 20px 60px rgba(31, 35, 40, 0.08);
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font-family: Inter, system-ui, sans-serif; background:
      radial-gradient(circle at top left, rgba(15,118,110,0.1), transparent 28%),
      linear-gradient(180deg, #f9f6f0 0%, var(--bg) 100%); color: var(--text); }}
    a {{ color: inherit; text-decoration: none; }}
    main {{ max-width: 1100px; margin: 0 auto; padding: 32px 20px 56px; }}
    .hero, .panel, .card, .form-panel {{
      background: var(--panel);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
    }}
    .hero {{ display: flex; justify-content: space-between; gap: 20px; padding: 28px; margin-bottom: 24px; align-items: center; }}
    .hero h1, .panel h2, .panel-header h1, .card h3 {{ margin: 0; }}
    .hero p, .card p, .meta {{ color: var(--muted); }}
    .badge {{ display: inline-flex; padding: 4px 10px; border-radius: 999px; background: rgba(15,118,110,0.12); color: var(--accent); font-size: 0.8rem; font-weight: 700; margin-bottom: 12px; }}
    .hero-actions, .actions, .form-actions {{ display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }}
    .panel {{ padding: 24px; margin-bottom: 20px; }}
    .card {{ padding: 18px 20px; margin-top: 16px; }}
    .card-top {{ display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }}
    .meta code, code {{ background: rgba(15,118,110,0.1); padding: 0.15rem 0.35rem; border-radius: 6px; }}
    .status {{ color: var(--accent-strong); font-weight: 700; }}
    .button {{ display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel-solid); cursor: pointer; font: inherit; }}
    .button:hover {{ border-color: #c8baab; }}
    .button.primary {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
    .button.primary:hover {{ background: var(--accent-strong); }}
    .button.danger {{ color: var(--danger); }}
    .post-form {{ display: grid; gap: 16px; margin-top: 18px; }}
    label {{ display: grid; gap: 8px; font-weight: 600; }}
    input, textarea {{ width: 100%; border-radius: 14px; border: 1px solid var(--border); background: var(--panel-solid); padding: 12px 14px; font: inherit; color: var(--text); }}
    textarea {{ resize: vertical; min-height: 260px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.6; }}
    .checkbox-row {{ display: flex; align-items: center; gap: 10px; font-weight: 500; }}
    .checkbox-row input {{ width: auto; }}
    .panel-header {{ display: flex; justify-content: space-between; gap: 16px; align-items: center; }}
    @media (max-width: 760px) {{
      main {{ padding: 16px 12px 36px; }}
      .hero, .panel {{ padding: 18px; }}
      .card-top, .panel-header, .hero {{ flex-direction: column; align-items: stretch; }}
      .hero-actions, .actions {{ width: 100%; }}
      .button {{ width: 100%; }}
    }}
  </style>
</head>
<body>
  <main>
    {body}
  </main>
</body>
</html>"#,
        title = escape_html(title),
        body = body,
    )
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

fn today_string() -> String {
    Local::now().date_naive().format("%F").to_string()
}

fn internal_error<E: std::fmt::Display>(error: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

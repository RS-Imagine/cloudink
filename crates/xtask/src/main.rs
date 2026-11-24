mod admin;
mod bundle;
mod reader;
mod vendor;

use anyhow::{Context, Result, bail, ensure};
use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments != ["build"] {
        bail!("Usage: cargo xtask build");
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    build(&root)
}

fn build(root: &Path) -> Result<()> {
    let work = root.join("build-work");
    fs::create_dir_all(&work)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(work.join(".build.lock"))?;
    lock.lock().context("lock CloudInk build outputs")?;

    let tools = vendor::prepare(&work)?;
    let sources = tempfile::tempdir_in(&tools.vendor)?;
    bundle::snapshot_sources(root, sources.path())?;
    let bundler = bundle::Bundler {
        program: &tools.esbuild,
        sources: sources.path(),
    };
    run(Command::new("rustup").current_dir(root).args([
        "target",
        "add",
        "wasm32-unknown-unknown",
    ]))?;
    run(Command::new(tools.wasm_pack)
        .current_dir(root)
        .args([
            "build",
            "crates/blog-wasm",
            "--target",
            "web",
            "--out-dir",
            "../../cloud-admin/ui/wasm",
            "--no-typescript",
        ])
        .env("CARGO_PROFILE_RELEASE_OPT_LEVEL", "s")
        .env("CARGO_PROFILE_RELEASE_LTO", "thin")
        .env("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "1"))?;

    let worker_assets = work.join("worker-assets");
    fs::create_dir_all(&worker_assets)?;
    admin::build(root, &worker_assets, &bundler)?;
    let content = work.join("web-content");
    let output = work.join("web-public");
    reader::seed(&content, &output)?;
    run(cargo()
        .current_dir(root)
        .args([
            "run",
            "--locked",
            "--release",
            "-p",
            "sitegen",
            "--",
            "build",
        ])
        .env("BLOG_CONTENT_ROOT", &content)
        .env("BLOG_OUTPUT_ROOT", &output))?;
    reader::bundle(root, &output, &worker_assets, &tools.vendor, &bundler)?;

    let worker_build = worker_build(root, &work)?;
    run(Command::new(worker_build).current_dir(root).args([
        "--release",
        "--out-dir",
        "../../build-work/reader-worker",
        "crates/worker",
        "--",
        "--locked",
    ]))
}

fn cargo() -> Command {
    Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
}

fn worker_build(root: &Path, work: &Path) -> Result<PathBuf> {
    const VERSION: &str = "0.9.0";
    let location = work.join("worker-tools");
    let executable = location
        .join("bin")
        .join(format!("worker-build{}", env::consts::EXE_SUFFIX));
    let installed = Command::new(&executable).arg("--version").output().ok();
    if !installed.is_some_and(|output| {
        output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == VERSION
    }) {
        run(cargo()
            .current_dir(root)
            .args(["install", "--locked", "--root"])
            .arg(&location)
            .args(["--version", VERSION, "worker-build"]))?;
    }
    Ok(executable)
}

fn run(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .with_context(|| format!("start {command:?}"))?;
    ensure!(status.success(), "{command:?} exited with {status}");
    Ok(())
}

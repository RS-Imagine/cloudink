mod admin;
mod bundle;
mod cache;
mod reader;
mod vendor;

use anyhow::{Context, Result, bail, ensure};
use cache::{Artifact, Cache};
use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    match arguments.as_slice() {
        [command] if command == "build" => build(&root, None),
        [command] if command == "build-deploy" => build(&root, Cache::configured().as_ref()),
        [command] if command == "dev" => dev(&root),
        _ => bail!("Usage: cargo xtask build | cargo xtask build-deploy | cargo xtask dev"),
    }
}

fn dev(root: &Path) -> Result<()> {
    let host = env::var("HOST")
        .ok()
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "0.0.0.0".to_owned());
    let port = env::var("PORT")
        .ok()
        .filter(|port| !port.is_empty() && port != "0")
        .unwrap_or_else(|| "3000".to_owned());
    let port = port
        .parse::<u16>()
        .context("PORT must be between 1 and 65535")?;
    ensure!(port > 0, "PORT must be between 1 and 65535");
    build(root, None)?;
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let mut wrangler = Command::new(npm);
    wrangler
        .current_dir(root)
        .args(["exec", "--yes", "--package=wrangler@4.145.0", "--"])
        .args(["wrangler", "dev", "--local", "--ip", &host, "--port"])
        .arg(port.to_string());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        Err(wrangler.exec()).context("start local Wrangler")
    }
    #[cfg(not(unix))]
    run(&mut wrangler)
}

fn build(root: &Path, cache: Option<&Cache>) -> Result<()> {
    let work = root.join("build-work");
    fs::create_dir_all(&work)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(work.join(".build.lock"))?;
    lock.lock().context("lock CloudInk build outputs")?;

    run(Command::new("rustup").current_dir(root).args([
        "target",
        "add",
        "wasm32-unknown-unknown",
    ]))?;
    let frontend = cache.and_then(|cache| match cache::frontend_key(root) {
        Ok(key) => Some((cache, key)),
        Err(error) => {
            eprintln!("CloudInk frontend cache disabled: {error:#}");
            None
        }
    });
    let frontend_restored = frontend.as_ref().is_some_and(|(cache, key)| {
        cache.restore(Artifact::Frontend, key, &work)
            && admin::restore_generated(root, &work.join("worker-assets"))
                .inspect_err(|error| eprintln!("CloudInk frontend cache incomplete: {error:#}"))
                .is_ok()
    });
    if !frontend_restored {
        build_frontend(root, &work)?;
    }
    admin::write_versions(root, &work.join("worker-versions.rs"))?;

    let (worker_build, tool_to_save) = worker_build(root, &work, cache)?;
    run(Command::new(worker_build).current_dir(root).args([
        "--release",
        "--out-dir",
        "../../build-work/reader-worker",
        "crates/worker",
        "--",
        "--locked",
    ]))?;
    if let Some((cache, key)) = frontend.filter(|_| !frontend_restored) {
        cache.save(Artifact::Frontend, &key, &work);
    }
    if let (Some(cache), Some(key)) = (cache, tool_to_save) {
        cache.save(Artifact::WorkerBuild, &key, &work);
    }
    Ok(())
}

fn build_frontend(root: &Path, work: &Path) -> Result<()> {
    let tools = vendor::prepare(work)?;
    let sources = tempfile::tempdir_in(&tools.vendor)?;
    bundle::snapshot_sources(root, sources.path())?;
    let bundler = bundle::Bundler {
        program: &tools.esbuild,
        sources: sources.path(),
    };
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
    reader::bundle(root, &output, &worker_assets, &tools.vendor, &bundler)
}

fn cargo() -> Command {
    Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
}

fn worker_build(
    root: &Path,
    work: &Path,
    cache: Option<&Cache>,
) -> Result<(PathBuf, Option<String>)> {
    const VERSION: &str = "0.9.0";
    let location = work.join("worker-tools");
    let executable = location
        .join("bin")
        .join(format!("worker-build{}", env::consts::EXE_SUFFIX));
    let matches_version = || {
        Command::new(&executable)
            .arg("--version")
            .output()
            .is_ok_and(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == VERSION
            })
    };
    let key = cache.map(|_| {
        format!(
            "worker-build-{VERSION}-{}-{}-opt0-{}",
            env::consts::OS,
            env::consts::ARCH,
            vendor::sha256(include_bytes!("../../../rust-toolchain.toml"))
        )
    });
    let installed = matches_version();
    let restored = !installed
        && cache.zip(key.as_deref()).is_some_and(|(cache, key)| {
            cache.restore(Artifact::WorkerBuild, key, work) && matches_version()
        });
    if !installed && !restored {
        run(cargo()
            .current_dir(root)
            .env("CARGO_PROFILE_RELEASE_OPT_LEVEL", "0")
            .args(["install", "--locked", "--force", "--root"])
            .arg(&location)
            .args(["--version", VERSION, "worker-build"]))?;
        ensure!(
            matches_version(),
            "worker-build did not report version {VERSION}"
        );
    }
    Ok((executable, key.filter(|_| !installed && !restored)))
}

fn run(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .with_context(|| format!("start {command:?}"))?;
    ensure!(status.success(), "{command:?} exited with {status}");
    Ok(())
}

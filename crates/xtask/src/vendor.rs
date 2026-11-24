use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};
use std::collections::BTreeMap;
use std::env;
use std::fmt::Write;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Deserialize)]
struct Archive {
    url: String,
    integrity: String,
}

#[derive(Deserialize)]
struct Catalog {
    packages: BTreeMap<String, Archive>,
    esbuild: BTreeMap<String, Archive>,
    wasm_pack: BTreeMap<String, Archive>,
}

pub struct Tools {
    pub esbuild: PathBuf,
    pub wasm_pack: PathBuf,
    pub vendor: PathBuf,
}

pub fn prepare(work: &Path) -> Result<Tools> {
    let lock: Catalog = serde_json::from_str(include_str!("../vendor-lock.json"))?;
    let vendor = work.join("vendor");
    let modules = vendor.join("node_modules");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .try_proxy_from_env(true)
        .build();
    for (name, archive) in lock.packages {
        populate(&agent, &archive, &modules.join(name), "package")?;
    }

    let target = platform()?;
    let esbuild = lock
        .esbuild
        .get(&target)
        .context("missing esbuild archive")?;
    let esbuild_dir = vendor.join("esbuild").join(&target);
    populate(&agent, esbuild, &esbuild_dir, "package")?;
    let esbuild = esbuild_dir.join(if cfg!(windows) {
        "esbuild.exe"
    } else {
        "bin/esbuild"
    });

    let wasm = lock
        .wasm_pack
        .get(&target)
        .context("missing wasm-pack archive")?;
    let wasm_dir = vendor.join("wasm-pack").join(&target);
    let root = wasm
        .url
        .rsplit('/')
        .next()
        .and_then(|name| name.strip_suffix(".tar.gz"))
        .context("invalid wasm-pack archive name")?;
    populate(&agent, wasm, &wasm_dir, root)?;
    let wasm_pack = wasm_dir.join(format!("wasm-pack{}", env::consts::EXE_SUFFIX));

    Ok(Tools {
        esbuild,
        wasm_pack,
        vendor,
    })
}

fn platform() -> Result<String> {
    let platform = match env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "win32",
        other => bail!("Unsupported CloudInk build platform {other}"),
    };
    let arch = match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => bail!("Unsupported CloudInk build CPU {other}"),
    };
    Ok(format!("{platform}-{arch}"))
}

fn populate(agent: &ureq::Agent, archive: &Archive, target: &Path, root: &str) -> Result<()> {
    let marker = ".integrity";
    if fs::read_to_string(target.join(marker)).is_ok_and(|value| value == archive.integrity) {
        return Ok(());
    }
    let parent = target.parent().context("missing build cache directory")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::tempdir_in(parent)?;
    eprintln!("Fetching {}", archive.url);
    let response = agent
        .get(&archive.url)
        .call()
        .with_context(|| format!("fetch {}", archive.url))?;
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes)?;
    ensure!(
        matches_integrity(&bytes, &archive.integrity),
        "Checksum mismatch for {}",
        archive.url
    );
    tar::Archive::new(GzDecoder::new(bytes.as_slice())).unpack(temporary.path())?;
    let unpacked = temporary.path().join(root);
    fs::write(unpacked.join(marker), &archive.integrity)?;
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    fs::rename(unpacked, target).with_context(|| format!("install {}", target.display()))
}

fn matches_integrity(bytes: &[u8], expected: &str) -> bool {
    if let Some(expected) = expected.strip_prefix("sha512-") {
        return STANDARD.encode(Sha512::digest(bytes)) == expected;
    }
    if let Some(expected) = expected.strip_prefix("sha256:") {
        return sha256(bytes) == expected;
    }
    false
}

pub fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

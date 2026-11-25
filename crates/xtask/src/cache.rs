use crate::vendor::{hex, sha256};
use anyhow::{Context, Result, ensure};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::{env, io};

const MAX_COMPRESSED: u64 = 16 * 1024 * 1024;
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const KEY_HEADER: &str = "x-amz-meta-cloudink-key";
const HASH_HEADER: &str = "x-amz-meta-cloudink-sha256";

#[derive(Clone, Copy)]
pub enum Artifact {
    Frontend,
    WorkerBuild,
}

impl Artifact {
    fn object(self) -> &'static str {
        match self {
            Self::Frontend => "build-cache/frontend.tar.gz",
            Self::WorkerBuild => "build-cache/worker-build.tar.gz",
        }
    }

    fn directories(self) -> &'static [&'static str] {
        match self {
            Self::Frontend => &["web-public", "worker-assets"],
            Self::WorkerBuild => &["worker-tools/bin"],
        }
    }

    fn validate(self, directory: &Path) -> Result<()> {
        match self {
            Self::Frontend => {
                for file in [
                    "web-public/index.html",
                    "web-public/site.json",
                    "worker-assets/assets.rs",
                    "worker-assets/template-version",
                ] {
                    ensure!(directory.join(file).is_file(), "cache is missing {file}");
                }
            }
            Self::WorkerBuild => {
                for name in ["worker-build", "worker-codegen"] {
                    let file = format!("worker-tools/bin/{name}{}", env::consts::EXE_SUFFIX);
                    ensure!(directory.join(&file).is_file(), "cache is missing {file}");
                }
            }
        }
        Ok(())
    }
}

pub struct Cache {
    bucket_url: String,
    curl_credentials: String,
}

impl Cache {
    pub fn configured() -> Option<Self> {
        match Self::from_env() {
            Ok(cache) => cache,
            Err(error) => {
                eprintln!("CloudInk build cache disabled: {error:#}");
                None
            }
        }
    }

    fn from_env() -> Result<Option<Self>> {
        let Some(account) = env::var("CLOUDINK_CACHE_R2_ACCOUNT_ID").ok() else {
            return Ok(None);
        };
        ensure!(
            account.len() == 32 && account.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid R2 account ID"
        );
        let bucket = env::var("CLOUDINK_CACHE_R2_BUCKET").context("missing R2 bucket name")?;
        ensure!(
            (3..=63).contains(&bucket.len())
                && bucket
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "invalid R2 bucket name"
        );
        let access =
            env::var("CLOUDINK_CACHE_R2_ACCESS_KEY_ID").context("missing R2 access key")?;
        let secret =
            env::var("CLOUDINK_CACHE_R2_SECRET_ACCESS_KEY").context("missing R2 secret key")?;
        ensure!(
            !access.is_empty() && !access.contains(':'),
            "invalid R2 access key"
        );
        ensure!(!secret.is_empty(), "invalid R2 secret key");
        let mut curl_credentials = format!(
            "user = \"{}\"\n",
            curl_config_value(&format!("{access}:{secret}"))?
        );
        if let Ok(token) = env::var("CLOUDINK_CACHE_R2_SESSION_TOKEN") {
            curl_credentials.push_str(&format!(
                "header = \"x-amz-security-token: {}\"\n",
                curl_config_value(&token)?
            ));
        }
        Ok(Some(Self {
            bucket_url: format!("https://{account}.r2.cloudflarestorage.com/{bucket}"),
            curl_credentials,
        }))
    }

    pub fn restore(&self, artifact: Artifact, key: &str, work: &Path) -> bool {
        match self.download(artifact, key, work) {
            Ok(()) => {
                println!("CloudInk cache hit: {}", artifact.object());
                true
            }
            Err(error) => {
                eprintln!("CloudInk cache miss: {} ({error:#})", artifact.object());
                false
            }
        }
    }

    fn download(&self, artifact: Artifact, key: &str, work: &Path) -> Result<()> {
        let temporary = tempfile::tempdir_in(work)?;
        let archive = temporary.path().join("cache.tar.gz");
        let headers = temporary.path().join("headers");
        self.transfer(artifact, EMPTY_SHA256, |curl| {
            curl.arg("--max-filesize")
                .arg(MAX_COMPRESSED.to_string())
                .arg("--dump-header")
                .arg(&headers)
                .arg("--output")
                .arg(&archive);
        })?;
        let headers = fs::read_to_string(headers)?;
        ensure!(
            header(&headers, KEY_HEADER) == Some(key),
            "cache fingerprint differs"
        );
        let digest = archive_hash(&archive)?;
        ensure!(
            header(&headers, HASH_HEADER) == Some(digest.as_str()),
            "cache checksum differs"
        );
        let staging = temporary.path().join("unpacked");
        fs::create_dir(&staging)?;
        unpack(artifact, &archive, &staging)?;
        artifact.validate(&staging)?;
        for directory in artifact.directories() {
            let destination = work.join(directory);
            fs::create_dir_all(destination.parent().context("cache destination")?)?;
            match fs::remove_dir_all(&destination) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            fs::rename(staging.join(directory), &destination)?;
        }
        Ok(())
    }

    pub fn save(&self, artifact: Artifact, key: &str, work: &Path) {
        match self.upload(artifact, key, work) {
            Ok(()) => println!("CloudInk cache updated: {}", artifact.object()),
            Err(error) => {
                eprintln!(
                    "CloudInk cache update skipped: {} ({error:#})",
                    artifact.object()
                );
            }
        }
    }

    fn upload(&self, artifact: Artifact, key: &str, work: &Path) -> Result<()> {
        artifact.validate(work)?;
        let temporary = tempfile::tempdir_in(work)?;
        let path = temporary.path().join("cache.tar.gz");
        let encoder = GzEncoder::new(File::create(&path)?, Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        for directory in artifact.directories() {
            archive.append_dir_all(directory, work.join(directory))?;
        }
        archive.into_inner()?.finish()?;
        let digest = archive_hash(&path)?;
        self.transfer(artifact, &digest, |curl| {
            curl.arg("--upload-file")
                .arg(&path)
                .args(["--header", "content-type: application/gzip"])
                .arg("--header")
                .arg(format!("{KEY_HEADER}: {key}"))
                .arg("--header")
                .arg(format!("{HASH_HEADER}: {digest}"));
        })
    }

    fn transfer(
        &self,
        artifact: Artifact,
        digest: &str,
        options: impl FnOnce(&mut Command),
    ) -> Result<()> {
        let mut curl = Command::new("curl");
        curl.args([
            "--disable",
            "--silent",
            "--fail",
            "--proto",
            "=https",
            "--connect-timeout",
            "5",
            "--max-time",
            "25",
            "--aws-sigv4",
            "aws:amz:auto:s3",
            "--config",
            "-",
        ])
        .arg("--header")
        .arg(format!("x-amz-content-sha256: {digest}"));
        options(&mut curl);
        let mut child = curl
            .arg(format!("{}/{}", self.bucket_url, artifact.object()))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("start curl for R2 cache transfer")?;
        let credentials = child
            .stdin
            .take()
            .context("open curl configuration")?
            .write_all(self.curl_credentials.as_bytes());
        let status = child.wait()?;
        ensure!(status.success(), "R2 transfer failed ({status})");
        credentials?;
        Ok(())
    }
}

fn curl_config_value(value: &str) -> Result<String> {
    ensure!(
        !value.is_empty() && value.chars().all(|c| !c.is_control()),
        "invalid R2 credential"
    );
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn header<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().rev().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn archive_hash(path: &Path) -> Result<String> {
    ensure!(
        fs::metadata(path)?.len() <= MAX_COMPRESSED,
        "cache archive exceeds 16 MiB"
    );
    Ok(sha256(&fs::read(path)?))
}

fn unpack(artifact: Artifact, path: &Path, staging: &Path) -> Result<()> {
    let decoder = GzDecoder::new(File::open(path)?);
    let mut sum = 0;
    for entry in tar::Archive::new(decoder).entries()? {
        let mut entry = entry?;
        let file = entry.path()?;
        ensure!(
            file.components()
                .all(|part| matches!(part, Component::Normal(_)))
                && artifact
                    .directories()
                    .iter()
                    .any(|dir| file.starts_with(dir)),
            "file outside cache directories"
        );
        let kind = entry.header().entry_type();
        ensure!(kind.is_dir() || kind.is_file(), "invalid cache entry type");
        ensure!(
            entry.size() <= MAX_UNPACKED - sum,
            "expanded cache archive exceeds 64 MiB"
        );
        sum += entry.size();
        ensure!(entry.unpack_in(staging)?, "invalid cache entry path");
    }
    Ok(())
}

pub fn frontend_key(root: &Path) -> Result<String> {
    let mut files = Vec::new();
    for file in [
        ".cargo/config.toml",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "assets",
        "cloud-admin/src",
        "cloud-admin/ui",
        "cloud-admin/tsconfig.json",
        "crates/blog-core/build.rs",
        "crates/blog-core/Cargo.toml",
        "crates/blog-core/src",
        "crates/blog-wasm/Cargo.toml",
        "crates/blog-wasm/src",
        "crates/sitegen/Cargo.toml",
        "crates/sitegen/src",
        "crates/xtask/Cargo.toml",
        "crates/xtask/Cargo.lock",
        "crates/xtask/src",
        "crates/xtask/vendor-lock.json",
    ] {
        frontend_files(root, Path::new(file), &mut files)?;
    }
    files.sort_unstable();
    let mut digest = Sha256::new();
    digest.update(format!(
        "cloudink-frontend-v1-{}-{}",
        env::consts::OS,
        env::consts::ARCH
    ));
    for file in files {
        let name = file.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(root.join(file))?;
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(hex(&digest.finalize()))
}

fn frontend_files(root: &Path, path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if path.starts_with("cloud-admin")
        && (path.starts_with("cloud-admin/ui/wasm")
            || name.ends_with(".generated.js")
            || name.ends_with(".generated.ts"))
    {
        return Ok(());
    }
    let full = root.join(path);
    let kind = fs::symlink_metadata(&full)?.file_type();
    if kind.is_dir() {
        for entry in fs::read_dir(full)? {
            frontend_files(root, &path.join(entry?.file_name()), files)?;
        }
    } else {
        ensure!(kind.is_file(), "invalid frontend input {}", path.display());
        files.push(path.to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_restore_rejects_unrelated_files_and_links() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let file = temporary.path().join("cache.tar.gz");
        let output = temporary.path().join("unpacked");
        fs::create_dir(&output)?;

        for (path, kind) in [
            ("state/published.json", tar::EntryType::Regular),
            ("worker-assets/link", tar::EntryType::Symlink),
        ] {
            let encoder = GzEncoder::new(File::create(&file)?, Compression::fast());
            let mut archive = tar::Builder::new(encoder);
            let mut entry = tar::Header::new_gnu();
            entry.set_entry_type(kind);
            entry.set_size(0);
            archive.append_data(&mut entry, path, io::empty())?;
            archive.into_inner()?.finish()?;
            assert!(unpack(Artifact::Frontend, &file, &output).is_err());
            assert!(!output.join(path).exists());
        }
        Ok(())
    }

    #[test]
    fn frontend_inputs_ignore_generated_editor_assets() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let ui = Path::new("cloud-admin/ui");
        for file in ["app.js", "app.generated.js", "wasm/blog_wasm.js"] {
            let path = temporary.path().join(ui).join(file);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, file)?;
        }
        let mut files = Vec::new();
        frontend_files(temporary.path(), ui, &mut files)?;
        assert_eq!(files, [ui.join("app.js")]);
        Ok(())
    }
}

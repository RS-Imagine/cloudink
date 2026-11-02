use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn collect(root: &Path, path: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_dir() {
        for entry in fs::read_dir(path).expect("read template directory") {
            collect(root, &entry.expect("read template entry").path(), files);
        }
    } else {
        files.push(path.strip_prefix(root).expect("template path").to_owned());
    }
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("crate directory"));
    let root = manifest
        .parent()
        .and_then(Path::parent)
        .expect("workspace root");
    let mut files = Vec::new();
    for path in [
        "crates/blog-core/src",
        "crates/blog-core/Cargo.toml",
        "crates/blog-core/build.rs",
        "assets",
        "Cargo.lock",
        "package-lock.json",
        "scripts/web-assets.mjs",
    ] {
        collect(root, &root.join(path), &mut files);
    }
    files.sort();
    let mut hash = blake3::Hasher::new();
    for file in files {
        let name = file.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(root.join(&file)).expect("read template input");
        hash.update(&(name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update(&(bytes.len() as u64).to_le_bytes());
        hash.update(&bytes);
    }
    println!(
        "cargo:rustc-env=CLOUDINK_TEMPLATE_VERSION={}",
        hash.finalize().to_hex()
    );
}

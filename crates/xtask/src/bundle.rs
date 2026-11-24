use anyhow::{Context, Result, ensure};
use flate2::{Compression, write::GzEncoder};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub struct Bundler<'a> {
    pub program: &'a Path,
    pub sources: &'a Path,
}

pub enum Source<'a> {
    File(&'a str),
    Inline { body: &'a str, name: &'a str },
}

impl Bundler<'_> {
    pub fn js(
        &self,
        directory: &str,
        source: Source<'_>,
        output: &Path,
        format: &str,
        external: &[&str],
    ) -> Result<()> {
        let mut command = Command::new(self.program);
        command
            .current_dir(self.sources.join(directory))
            .args(["--bundle", "--minify", "--target=es2022"])
            .arg(format!("--format={format}"))
            .arg(format!("--outfile={}", output.display()));
        for path in external {
            command.arg(format!("--external:{path}"));
        }
        match source {
            Source::File(name) => {
                command.arg(name);
                crate::run(&mut command)
            }
            Source::Inline { body, name } => {
                command.arg(format!("--sourcefile={name}"));
                write_to_stdin(&mut command, body).map(drop)
            }
        }
    }

    pub fn css(&self, source: &str, target: &str) -> Result<String> {
        let mut command = Command::new(self.program);
        command
            .current_dir(self.sources)
            .args(["--loader=css", "--minify"])
            .arg(format!("--target={target}"));
        let output = write_to_stdin(&mut command, source)?;
        String::from_utf8(output).context("read esbuild stylesheet output")
    }
}

pub fn snapshot_sources(root: &Path, snapshot: &Path) -> Result<()> {
    for (folder, extension) in [
        ("cloud-admin/ui", "js"),
        ("cloud-admin/src", "ts"),
        ("assets", "js"),
    ] {
        let destination = snapshot.join(folder);
        fs::create_dir_all(&destination)?;
        for file in fs::read_dir(root.join(folder))? {
            let file = file?;
            let path = file.path();
            if path.extension().is_some_and(|value| value == extension)
                && !file
                    .file_name()
                    .to_string_lossy()
                    .ends_with(&format!(".generated.{extension}"))
            {
                fs::copy(&path, destination.join(file.file_name()))?;
            }
        }
    }
    fs::copy(
        root.join("cloud-admin/tsconfig.json"),
        snapshot.join("cloud-admin/tsconfig.json"),
    )?;
    Ok(())
}

fn write_to_stdin(command: &mut Command, text: &str) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {command:?}"))?;
    let mut stdin = child.stdin.take().context("open esbuild stdin")?;
    stdin.write_all(text.as_bytes())?;
    drop(stdin);
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "{command:?} exited with {}",
        output.status
    );
    Ok(output.stdout)
}

pub fn gzip_size(bytes: &[u8]) -> Result<usize> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(bytes)?;
    Ok(gzip.finish()?.len())
}

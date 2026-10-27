//! Canonical managed-runtime archive extraction and tree fingerprinting.
//!
//! Release tooling invokes the companion `runtime-fingerprint` example, so the
//! manifest is generated with the exact extraction and hashing implementation
//! that desktop installation uses.

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

const INSTALL_MARKER: &str = ".agentree-runtime-ok";
const CLAUDE_GENERATED_FILES: &[&str] = &["ai-label-prompt.txt", "claude-agent-sdk-adapter.mjs"];
const OPENCODE_GENERATED_FILES: &[&str] = &["opencode-agent-sdk-adapter.mjs"];

pub fn fingerprint_exclusions(component: &str) -> &'static [&'static str] {
    match component {
        "claude-sdk" => CLAUDE_GENERATED_FILES,
        "opencode" => OPENCODE_GENERATED_FILES,
        _ => &[],
    }
}

fn update_fingerprint_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

pub fn install_tree_sha256(install_dir: &Path, exclusions: &[&str]) -> Result<String, String> {
    let mut entries = WalkDir::new(install_dir)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .map(|entry| entry.map_err(|error| format!("Could not inspect runtime tree: {}", error)))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));

    let mut hasher = Sha256::new();
    for entry in entries {
        let relative = entry.path().strip_prefix(install_dir).map_err(|error| {
            format!(
                "Could not fingerprint runtime path {}: {}",
                entry.path().display(),
                error
            )
        })?;
        let relative = relative
            .to_str()
            .ok_or_else(|| {
                format!(
                    "Managed runtime path is not valid UTF-8: {}",
                    relative.display()
                )
            })?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if relative == INSTALL_MARKER || exclusions.contains(&relative.as_str()) {
            continue;
        }

        if entry.file_type().is_dir() {
            continue;
        }
        update_fingerprint_field(&mut hasher, relative.as_bytes());
        if entry.file_type().is_symlink() {
            hasher.update(b"symlink");
            let target = fs::read_link(entry.path()).map_err(|error| {
                format!(
                    "Could not read managed runtime symlink {}: {}",
                    entry.path().display(),
                    error
                )
            })?;
            update_fingerprint_field(&mut hasher, target.to_string_lossy().as_bytes());
        } else if entry.file_type().is_file() {
            hasher.update(b"file");
            let size = entry.metadata().map_err(|error| {
                format!(
                    "Could not inspect managed runtime file {}: {}",
                    entry.path().display(),
                    error
                )
            })?;
            hasher.update(size.len().to_be_bytes());
            let mut file = fs::File::open(entry.path()).map_err(|error| {
                format!(
                    "Could not open managed runtime file {}: {}",
                    entry.path().display(),
                    error
                )
            })?;
            let mut buffer = [0u8; 65536];
            loop {
                let count = file.read(&mut buffer).map_err(|error| {
                    format!(
                        "Could not fingerprint managed runtime file {}: {}",
                        entry.path().display(),
                        error
                    )
                })?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
        } else {
            return Err(format!(
                "Managed runtime contains unsupported entry type: {}",
                entry.path().display()
            ));
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_apple_metadata_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name.starts_with("._") || name == ".DS_Store"
    })
}

pub fn unpack_archive_skipping_apple_metadata<R: Read>(
    archive: &mut tar::Archive<R>,
    dest: &Path,
) -> Result<(), String> {
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not read runtime archive entries: {}", error))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Could not read runtime archive entry: {}", error))?;
        let path = entry
            .path()
            .map_err(|error| format!("Invalid path in runtime archive: {}", error))?
            .into_owned();
        if is_apple_metadata_path(&path) {
            continue;
        }
        entry
            .unpack_in(dest)
            .map_err(|error| format!("Could not unpack runtime archive: {}", error))?;
    }
    Ok(())
}

pub fn archive_tree_sha256(archive_path: &Path, component: &str) -> Result<String, String> {
    let archive_file = fs::File::open(archive_path).map_err(|error| {
        format!(
            "Could not open runtime archive {}: {}",
            archive_path.display(),
            error
        )
    })?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    let extracted = tempfile::tempdir()
        .map_err(|error| format!("Could not create runtime fingerprint directory: {}", error))?;
    unpack_archive_skipping_apple_metadata(&mut archive, extracted.path())?;
    install_tree_sha256(extracted.path(), fingerprint_exclusions(component))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_fingerprint_uses_the_desktop_extractor_and_exclusions() {
        let root = tempfile::tempdir().unwrap();
        let archive_path = root.path().join("runtime.tar.gz");
        let archive_file = fs::File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(archive_file, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(7);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "bin/opencode", b"runtime".as_slice())
            .unwrap();
        let mut generated_header = tar::Header::new_gnu();
        generated_header.set_size(9);
        generated_header.set_mode(0o644);
        generated_header.set_cksum();
        builder
            .append_data(
                &mut generated_header,
                "opencode-agent-sdk-adapter.mjs",
                b"generated".as_slice(),
            )
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let extracted = tempfile::tempdir().unwrap();
        fs::create_dir_all(extracted.path().join("bin")).unwrap();
        fs::write(extracted.path().join("bin/opencode"), b"runtime").unwrap();
        fs::write(
            extracted.path().join("opencode-agent-sdk-adapter.mjs"),
            b"different generated content",
        )
        .unwrap();

        assert_eq!(
            archive_tree_sha256(&archive_path, "opencode").unwrap(),
            install_tree_sha256(extracted.path(), fingerprint_exclusions("opencode")).unwrap(),
        );
    }
}

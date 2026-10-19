//! Managed provider runtimes.
//!
//! Packaged builds must not depend on whatever Node/codex the user's desktop
//! session PATH happens to contain. Each provider toolchain is published at
//! release time as a pinned, checksummed archive; this module downloads it on
//! first use into the app data dir and resolves binaries from there.

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const RUNTIME_MANIFEST_JSON: &str = include_str!("../../runtime-manifest.json");
const INSTALL_MARKER: &str = ".agentree-runtime-ok";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

pub const COMPONENT_NODE: &str = "node";
pub const COMPONENT_CLAUDE_SDK: &str = "claude-sdk";
pub const COMPONENT_CODEX: &str = "codex";

static MANIFEST: OnceCell<RuntimeManifest> = OnceCell::new();
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema: u32,
    pub components: HashMap<String, RuntimeComponentSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponentSpec {
    pub version: String,
    pub platforms: HashMap<String, RuntimePlatformArchive>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlatformArchive {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDownloadProgress {
    pub component: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
}

pub fn manifest() -> Result<&'static RuntimeManifest, String> {
    MANIFEST.get_or_try_init(|| {
        let parsed: RuntimeManifest = serde_json::from_str(RUNTIME_MANIFEST_JSON)
            .map_err(|error| format!("Invalid runtime manifest: {}", error))?;
        if parsed.schema != 1 {
            return Err(format!(
                "Unsupported runtime manifest schema: {}",
                parsed.schema
            ));
        }
        Ok(parsed)
    })
}

pub fn current_platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "darwin-aarch64",
        _ => "unsupported",
    }
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("runtime"))
        .map_err(|error| format!("Could not resolve app data dir: {}", error))
}

fn component_spec(component: &str) -> Result<&'static RuntimeComponentSpec, String> {
    manifest()?
        .components
        .get(component)
        .ok_or_else(|| format!("Unknown managed runtime component: {}", component))
}

pub fn component_install_dir(app: &AppHandle, component: &str) -> Result<PathBuf, String> {
    let spec = component_spec(component)?;
    Ok(runtime_root(app)?.join(component).join(&spec.version))
}

/// Returns the install dir when the pinned version of `component` is present
/// and its completion marker exists; never touches the network.
pub fn installed_component_dir(
    app: &AppHandle,
    component: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = component_install_dir(app, component)?;
    if dir.join(INSTALL_MARKER).is_file() && validate_component_install(component, &dir).is_ok() {
        Ok(Some(dir))
    } else {
        Ok(None)
    }
}

fn claude_native_executable_relative_path(platform: &str) -> Result<PathBuf, String> {
    let (package, executable) = match platform {
        "linux-x86_64" => ("claude-agent-sdk-linux-x64", "claude"),
        "darwin-aarch64" => ("claude-agent-sdk-darwin-arm64", "claude"),
        other => return Err(format!("Unsupported Claude runtime platform: {}", other)),
    };
    Ok(PathBuf::from("node_modules")
        .join("@anthropic-ai")
        .join(package)
        .join(executable))
}

pub fn claude_binary_path(install_dir: &Path) -> Result<PathBuf, String> {
    Ok(install_dir.join(claude_native_executable_relative_path(
        current_platform_key(),
    )?))
}

fn validate_component_install_for_platform(
    component: &str,
    install_dir: &Path,
    platform: &str,
) -> Result<(), String> {
    let required = match component {
        COMPONENT_NODE => vec![(node_binary_path(install_dir), true)],
        COMPONENT_CODEX => vec![(codex_binary_path(install_dir), true)],
        COMPONENT_CLAUDE_SDK => vec![
            (
                install_dir
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-agent-sdk")
                    .join("sdk.mjs"),
                false,
            ),
            (
                install_dir.join(claude_native_executable_relative_path(platform)?),
                true,
            ),
        ],
        other => return Err(format!("Unknown managed runtime component: {}", other)),
    };
    for (path, must_be_executable) in required {
        if !path.is_file() {
            return Err(format!(
                "Managed {} runtime is incomplete: required file {} is missing.",
                component,
                path.display()
            ));
        }
        #[cfg(unix)]
        if must_be_executable {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .map_err(|error| format!("Could not inspect {}: {}", path.display(), error))?
                .permissions()
                .mode();
            if mode & 0o111 == 0 {
                return Err(format!(
                    "Managed {} runtime is incomplete: required file {} is not executable.",
                    component,
                    path.display()
                ));
            }
        }
        #[cfg(not(unix))]
        let _ = must_be_executable;
    }
    Ok(())
}

pub fn validate_component_install(component: &str, install_dir: &Path) -> Result<(), String> {
    validate_component_install_for_platform(component, install_dir, current_platform_key())
}

pub fn component_install_validation_error(
    app: &AppHandle,
    component: &str,
) -> Result<Option<String>, String> {
    let dir = component_install_dir(app, component)?;
    if !dir.join(INSTALL_MARKER).is_file() {
        return Ok(None);
    }
    Ok(validate_component_install(component, &dir).err())
}

fn platform_archive(component: &str) -> Result<&'static RuntimePlatformArchive, String> {
    let spec = component_spec(component)?;
    let platform = current_platform_key();
    let archive = spec.platforms.get(platform).ok_or_else(|| {
        format!(
            "No managed {} runtime is published for {}.",
            component, platform
        )
    })?;
    if archive.sha256.trim().is_empty() {
        return Err(format!(
            "Managed {} runtime {} has not been published for {} yet (missing checksum in runtime manifest). Run the runtime archive build during release.",
            component, spec.version, platform
        ));
    }
    Ok(archive)
}

/// True when this component can be downloaded for the current platform —
/// i.e. the manifest carries a published checksum.
pub fn component_available_for_download(component: &str) -> bool {
    platform_archive(component).is_ok()
}

/// Ensures the pinned version of `component` is installed, downloading and
/// verifying it if needed. Emits `managed-runtime:download` progress events.
pub fn ensure_component(app: &AppHandle, component: &str) -> Result<PathBuf, String> {
    if let Some(dir) = installed_component_dir(app, component)? {
        return Ok(dir);
    }
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "runtime install lock poisoned".to_string())?;
    // Another thread may have finished the install while we waited.
    if let Some(dir) = installed_component_dir(app, component)? {
        return Ok(dir);
    }
    download_and_install(app, component)
}

/// Re-downloads a component even when a copy is installed. The existing
/// install stays in place until the replacement has been downloaded,
/// verified, and unpacked, so a failed repair never loses a working runtime.
pub fn reinstall_component(app: &AppHandle, component: &str) -> Result<PathBuf, String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| "runtime install lock poisoned".to_string())?;
    download_and_install(app, component)
}

fn download_and_install(app: &AppHandle, component: &str) -> Result<PathBuf, String> {
    let archive = platform_archive(component)?;
    let install_dir = component_install_dir(app, component)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| format!("Could not build download client: {}", error))?;
    let response = client
        .get(&archive.url)
        .send()
        .map_err(|error| format!("Download failed for {}: {}", archive.url, error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download failed for {}: HTTP {}",
            archive.url,
            response.status()
        ));
    }
    let total_bytes = response.content_length();
    let progress = |received_bytes: u64| {
        let _ = app.emit(
            "managed-runtime:download",
            RuntimeDownloadProgress {
                component: component.to_string(),
                received_bytes,
                total_bytes,
            },
        );
    };
    install_archive_from_reader_validated(
        response,
        &archive.sha256,
        &install_dir,
        &progress,
        &|staged| validate_component_install(component, staged),
    )?;
    Ok(install_dir)
}

/// Streams a gzipped tarball into place: spool to a temp file while hashing,
/// verify the checksum, unpack into a staging dir, then atomically rename to
/// the final install dir and write the completion marker. A failure at any
/// point leaves no half-installed component behind.
pub fn install_archive_from_reader(
    mut reader: impl Read,
    expected_sha256: &str,
    install_dir: &Path,
    progress: &dyn Fn(u64),
) -> Result<(), String> {
    install_archive_from_reader_validated(
        &mut reader,
        expected_sha256,
        install_dir,
        progress,
        &|_| Ok(()),
    )
}

fn install_archive_from_reader_validated(
    mut reader: impl Read,
    expected_sha256: &str,
    install_dir: &Path,
    progress: &dyn Fn(u64),
    validate: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = install_dir
        .parent()
        .ok_or_else(|| "Install dir has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {}", parent.display(), error))?;

    let mut spool = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Could not create download spool: {}", error))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Download read failed: {}", error))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        spool
            .write_all(&buffer[..count])
            .map_err(|error| format!("Download write failed: {}", error))?;
        received += count as u64;
        progress(received);
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(format!(
            "Checksum mismatch for downloaded runtime archive: expected {}, got {}.",
            expected_sha256, actual_sha256
        ));
    }

    let staging = tempfile::tempdir_in(parent)
        .map_err(|error| format!("Could not create staging dir: {}", error))?;
    let spool_file = spool
        .reopen()
        .map_err(|error| format!("Could not reopen download spool: {}", error))?;
    let decoder = flate2::read::GzDecoder::new(spool_file);
    let mut tar_archive = tar::Archive::new(decoder);
    unpack_archive_skipping_apple_metadata(&mut tar_archive, staging.path())?;

    validate(staging.path())?;

    let staged = staging.keep();
    // The marker travels inside the staged tree so the swap below is the
    // single step that makes the install valid — no window where the new
    // tree exists without its marker.
    if let Err(error) = fs::write(staged.join(INSTALL_MARKER), b"ok") {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("Could not write install marker: {}", error));
    }

    // Swap with rollback: park any existing install, move the staged tree
    // into place, and restore the original if that move fails.
    let backup = parent.join(format!(
        ".backup-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    ));
    let had_existing = install_dir.exists();
    if had_existing {
        if let Err(error) = fs::rename(install_dir, &backup) {
            let _ = fs::remove_dir_all(&staged);
            return Err(format!(
                "Could not set aside existing install {}: {}",
                install_dir.display(),
                error
            ));
        }
    }
    if let Err(error) = fs::rename(&staged, install_dir) {
        let _ = fs::remove_dir_all(&staged);
        if had_existing {
            let _ = fs::rename(&backup, install_dir);
        }
        return Err(format!(
            "Could not move runtime into {}: {}",
            install_dir.display(),
            error
        ));
    }
    if had_existing {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// Returns Agentree's verified Node runtime, installing or repairing it when
/// needed. A host-installed Node is deliberately never considered.
pub fn node_program(app: &AppHandle) -> Result<String, String> {
    ensure_component(app, COMPONENT_NODE)
        .map(|dir| node_binary_path(&dir).to_string_lossy().into_owned())
        .map_err(|error| managed_runtime_required_error("Node", error))
}

pub struct ClaudeAdapterInvocation {
    pub node_program: String,
    pub adapter_script: PathBuf,
}

/// Resolves how to run the Claude agent SDK adapter.
///
/// The managed SDK install is downloaded on first use, with the adapter script
/// staged inside the install dir so its
/// bare `import '@anthropic-ai/claude-agent-sdk'` resolves against the
/// managed `node_modules` — NODE_PATH does not apply to ES modules, so the
/// script must live next to them. Host Node and host SDK installations are
/// deliberately never considered.
pub fn claude_adapter_invocation(app: &AppHandle) -> Result<ClaudeAdapterInvocation, String> {
    let resource_script =
        crate::runtime_scripts::runtime_script_path(app, "claude-agent-sdk-adapter.mjs")?;
    let resource_ai_label_prompt =
        crate::runtime_scripts::runtime_script_path(app, "ai-label-prompt.txt")?;

    let sdk_dir = ensure_component(app, COMPONENT_CLAUDE_SDK)
        .map_err(|error| managed_runtime_required_error("Claude SDK", error))?;
    let staged_script = sdk_dir.join("claude-agent-sdk-adapter.mjs");
    let staged_ai_label_prompt = sdk_dir.join("ai-label-prompt.txt");
    fs::copy(&resource_script, &staged_script).map_err(|error| {
        format!(
            "Could not stage Claude adapter into {}: {}",
            sdk_dir.display(),
            error
        )
    })?;
    fs::copy(&resource_ai_label_prompt, &staged_ai_label_prompt).map_err(|error| {
        format!(
            "Could not stage Claude adapter prompt into {}: {}",
            sdk_dir.display(),
            error
        )
    })?;
    Ok(ClaudeAdapterInvocation {
        node_program: node_program(app)?,
        adapter_script: staged_script,
    })
}

fn managed_runtime_required_error(label: &str, error: String) -> String {
    format!(
        "Agentree's managed {} runtime could not be installed or repaired: {} Open Runtime Health and retry.",
        label, error
    )
}

pub fn node_binary_path(install_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        install_dir.join("bin").join("node.exe")
    } else {
        install_dir.join("bin").join("node")
    }
}

pub fn codex_binary_path(install_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        install_dir.join("bin").join("codex.exe")
    } else {
        install_dir.join("bin").join("codex")
    }
}

/// True for macOS AppleDouble sidecar files (`._name`) and `.DS_Store`. Runtime
/// tarballs packed on macOS smuggle these in; on Linux they are dead weight and
/// a footgun for any code that globs a `bin/` dir (a stray `._node` must never be
/// mistaken for the real `node` binary).
fn is_apple_metadata_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name.starts_with("._") || name == ".DS_Store"
    })
}

/// Unpack a tar archive into `dest`, skipping macOS AppleDouble / `.DS_Store`
/// entries. Behaves like `Archive::unpack` for everything else.
fn unpack_archive_skipping_apple_metadata<R: Read>(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn build_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            for (path, contents) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(contents.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, path, *contents).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        tar_bytes
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn embedded_manifest_parses_and_pins_all_components() {
        let manifest = manifest().expect("manifest should parse");
        for component in [COMPONENT_NODE, COMPONENT_CLAUDE_SDK, COMPONENT_CODEX] {
            let spec = manifest
                .components
                .get(component)
                .unwrap_or_else(|| panic!("manifest missing {component}"));
            assert!(!spec.version.trim().is_empty());
            assert!(spec.platforms.contains_key("linux-x86_64"));
            assert!(spec.platforms.contains_key("darwin-aarch64"));
        }
    }

    #[test]
    fn install_archive_unpacks_and_writes_marker() {
        let archive = build_archive(&[("bin/codex", b"#!fake".as_slice())]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("codex").join("0.139.0");

        install_archive_from_reader(archive.as_slice(), &checksum, &install_dir, &|_| {})
            .expect("install should succeed");

        assert!(install_dir.join("bin").join("codex").is_file());
        assert!(install_dir.join(INSTALL_MARKER).is_file());
    }

    #[test]
    fn install_archive_skips_apple_double_files() {
        let archive = build_archive(&[
            ("bin/node", b"#!real".as_slice()),
            ("bin/._node", b"applemeta".as_slice()),
            ("._codex-resources", b"applemeta".as_slice()),
            (".DS_Store", b"finder".as_slice()),
        ]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("node").join("22.21.1");

        install_archive_from_reader(archive.as_slice(), &checksum, &install_dir, &|_| {})
            .expect("install should succeed");

        assert!(install_dir.join("bin").join("node").is_file());
        assert!(!install_dir.join("bin").join("._node").exists());
        assert!(!install_dir.join("._codex-resources").exists());
        assert!(!install_dir.join(".DS_Store").exists());
    }

    #[test]
    fn install_archive_replaces_existing_install_without_leaving_backups() {
        let first = build_archive(&[("bin/codex", b"old".as_slice())]);
        let second = build_archive(&[("bin/codex", b"new".as_slice())]);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("codex").join("0.139.0");

        install_archive_from_reader(first.as_slice(), &sha256_hex(&first), &install_dir, &|_| {})
            .expect("first install should succeed");
        install_archive_from_reader(
            second.as_slice(),
            &sha256_hex(&second),
            &install_dir,
            &|_| {},
        )
        .expect("reinstall should succeed");

        assert_eq!(
            std::fs::read(install_dir.join("bin").join("codex")).unwrap(),
            b"new"
        );
        assert!(install_dir.join(INSTALL_MARKER).is_file());
        let leftovers = std::fs::read_dir(install_dir.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".backup-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn install_archive_rejects_checksum_mismatch_without_leaving_files() {
        let archive = build_archive(&[("bin/node", b"node".as_slice())]);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("node").join("22.21.1");

        let error =
            install_archive_from_reader(archive.as_slice(), "deadbeef", &install_dir, &|_| {})
                .expect_err("checksum mismatch must fail");

        assert!(error.contains("Checksum mismatch"));
        assert!(!install_dir.exists());
    }

    #[test]
    fn claude_install_validation_requires_platform_native_executable() {
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("claude-sdk").join("0.3.207");
        let sdk_dir = install_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk");
        std::fs::create_dir_all(&sdk_dir).unwrap();
        std::fs::write(sdk_dir.join("sdk.mjs"), b"export {};").unwrap();

        let error = validate_component_install_for_platform(
            COMPONENT_CLAUDE_SDK,
            &install_dir,
            "linux-x86_64",
        )
        .expect_err("the SDK wrapper alone must not count as a complete runtime");
        assert!(error.contains("claude-agent-sdk-linux-x64"));

        let native = install_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk-linux-x64")
            .join("claude");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, b"#!fake").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        validate_component_install_for_platform(COMPONENT_CLAUDE_SDK, &install_dir, "linux-x86_64")
            .expect("wrapper plus native executable should be complete");
    }

    #[test]
    fn semantic_validation_rejects_incomplete_archive_before_install() {
        let archive = build_archive(&[(
            "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
            b"export {};".as_slice(),
        )]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("claude-sdk").join("0.3.207");

        let error = install_archive_from_reader_validated(
            archive.as_slice(),
            &checksum,
            &install_dir,
            &|_| {},
            &|staged| {
                validate_component_install_for_platform(
                    COMPONENT_CLAUDE_SDK,
                    staged,
                    "linux-x86_64",
                )
            },
        )
        .expect_err("an incomplete but checksummed archive must be rejected");

        assert!(error.contains("claude-agent-sdk-linux-x64"));
        assert!(!install_dir.exists());
    }
}

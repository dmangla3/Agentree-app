//! Managed provider runtimes.
//!
//! Packaged builds must not depend on whatever Node/codex the user's desktop
//! session PATH happens to contain. Each provider toolchain is published at
//! release time as a pinned, checksummed archive; this module downloads it on
//! first use into the app data dir and resolves binaries from there.

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
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
    pub min_codex_cli_version: String,
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

pub fn min_codex_cli_version() -> &'static str {
    manifest()
        .map(|manifest| manifest.min_codex_cli_version.as_str())
        .unwrap_or("0.135.0")
}

pub fn current_platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "unsupported",
    }
}

/// Numeric dotted-version comparison ("0.139.0" vs "0.57.0"). Non-numeric
/// segments compare as 0 so suffixes like "-beta" never panic.
pub fn compare_dotted_versions(left: &str, right: &str) -> Ordering {
    let parse = |value: &str| -> Vec<u64> {
        value
            .trim()
            .trim_start_matches(|character: char| !character.is_ascii_digit())
            .split('.')
            .map(|segment| {
                segment
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let left_segments = parse(left);
    let right_segments = parse(right);
    let length = left_segments.len().max(right_segments.len());
    for index in 0..length {
        let left_value = left_segments.get(index).copied().unwrap_or(0);
        let right_value = right_segments.get(index).copied().unwrap_or(0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
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
    if dir.join(INSTALL_MARKER).is_file() {
        Ok(Some(dir))
    } else {
        Ok(None)
    }
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
    install_archive_from_reader(response, &archive.sha256, &install_dir, &progress)?;
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
    tar_archive
        .unpack(staging.path())
        .map_err(|error| format!("Could not unpack runtime archive: {}", error))?;

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

/// Installs a managed component if it is published but not yet present, so
/// spawned helpers (which cannot download — they have no AppHandle) find it
/// instead of a possibly stale or absent PATH tool. Failures are logged, not
/// fatal: PATH resolution remains the fallback.
pub fn ensure_component_best_effort(app: &AppHandle, component: &str) {
    let already_installed = installed_component_dir(app, component)
        .ok()
        .flatten()
        .is_some();
    if already_installed || !component_available_for_download(component) {
        return;
    }
    if let Err(error) = ensure_component(app, component) {
        crate::app_log!(
            "[MANAGED_RUNTIME] {} install failed: {}",
            component,
            error
        );
    }
}

/// Mirrors Tauri's app_data_dir for contexts without an AppHandle — the
/// re-invoked codex adapter helper process resolves the managed runtime
/// through this. Must match the `identifier` in tauri.conf.json.
const APP_BUNDLE_IDENTIFIER: &str = "com.agentree.agentree";

pub fn installed_component_dir_without_app(component: &str) -> Option<PathBuf> {
    let spec = component_spec(component).ok()?;
    let dir = dirs::data_dir()?
        .join(APP_BUNDLE_IDENTIFIER)
        .join("runtime")
        .join(component)
        .join(&spec.version);
    if dir.join(INSTALL_MARKER).is_file() {
        Some(dir)
    } else {
        None
    }
}

/// Best node for spawning adapters: managed install first, then PATH.
pub fn node_program(app: &AppHandle) -> String {
    if let Ok(Some(dir)) = installed_component_dir(app, COMPONENT_NODE) {
        return node_binary_path(&dir).to_string_lossy().into_owned();
    }
    crate::cli_path::find_on_tool_path("node").unwrap_or_else(|| "node".to_string())
}

pub struct ClaudeAdapterInvocation {
    pub node_program: String,
    pub adapter_script: PathBuf,
}

/// Resolves how to run the Claude agent SDK adapter.
///
/// Preferred: the managed SDK install (downloading it on first use when
/// published), with the adapter script staged inside the install dir so its
/// bare `import '@anthropic-ai/claude-agent-sdk'` resolves against the
/// managed `node_modules` — NODE_PATH does not apply to ES modules, so the
/// script must live next to them. Fallback: the bundled/resource script with
/// walk-up resolution, which works in dev (repo node_modules) and otherwise
/// fails with a `claude_runtime_missing` error the doctor can explain.
pub fn claude_adapter_invocation(app: &AppHandle) -> Result<ClaudeAdapterInvocation, String> {
    let resource_script =
        crate::runtime_scripts::runtime_script_path(app, "claude-agent-sdk-adapter.mjs")?;

    let sdk_dir = match installed_component_dir(app, COMPONENT_CLAUDE_SDK)? {
        Some(dir) => Some(dir),
        None if component_available_for_download(COMPONENT_CLAUDE_SDK) => {
            match ensure_component(app, COMPONENT_CLAUDE_SDK) {
                Ok(dir) => Some(dir),
                Err(error) => {
                    crate::app_log!("[MANAGED_RUNTIME] claude-sdk install failed: {}", error);
                    None
                }
            }
        }
        None => None,
    };

    if let Some(sdk_dir) = sdk_dir {
        let staged_script = sdk_dir.join("claude-agent-sdk-adapter.mjs");
        fs::copy(&resource_script, &staged_script).map_err(|error| {
            format!(
                "Could not stage Claude adapter into {}: {}",
                sdk_dir.display(),
                error
            )
        })?;
        let node_program = match installed_component_dir(app, COMPONENT_NODE)? {
            Some(dir) => node_binary_path(&dir),
            None if component_available_for_download(COMPONENT_NODE) => {
                node_binary_path(&ensure_component(app, COMPONENT_NODE)?)
            }
            None => PathBuf::from(
                crate::cli_path::find_on_tool_path("node").unwrap_or_else(|| "node".to_string()),
            ),
        };
        return Ok(ClaudeAdapterInvocation {
            node_program: node_program.to_string_lossy().into_owned(),
            adapter_script: staged_script,
        });
    }

    Ok(ClaudeAdapterInvocation {
        node_program: node_program(app),
        adapter_script: resource_script,
    })
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

/// The claude-sdk archive unpacks to `node_modules/...` at its root.
pub fn claude_sdk_node_modules(install_dir: &Path) -> PathBuf {
    install_dir.join("node_modules")
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
        assert!(!manifest.min_codex_cli_version.is_empty());
    }

    #[test]
    fn dotted_version_comparison_orders_numerically() {
        assert_eq!(
            compare_dotted_versions("0.139.0", "0.57.0"),
            Ordering::Greater
        );
        assert_eq!(compare_dotted_versions("0.57.0", "0.135.0"), Ordering::Less);
        assert_eq!(compare_dotted_versions("1.2.3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare_dotted_versions("1.10", "1.9.9"), Ordering::Greater);
        assert_eq!(
            compare_dotted_versions("codex-cli 0.139.0", "0.135.0"),
            Ordering::Greater
        );
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
    fn install_archive_replaces_existing_install_without_leaving_backups() {
        let first = build_archive(&[("bin/codex", b"old".as_slice())]);
        let second = build_archive(&[("bin/codex", b"new".as_slice())]);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("codex").join("0.139.0");

        install_archive_from_reader(first.as_slice(), &sha256_hex(&first), &install_dir, &|_| {})
            .expect("first install should succeed");
        install_archive_from_reader(second.as_slice(), &sha256_hex(&second), &install_dir, &|_| {})
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

        let error = install_archive_from_reader(
            archive.as_slice(),
            "deadbeef",
            &install_dir,
            &|_| {},
        )
        .expect_err("checksum mismatch must fail");

        assert!(error.contains("Checksum mismatch"));
        assert!(!install_dir.exists());
    }
}

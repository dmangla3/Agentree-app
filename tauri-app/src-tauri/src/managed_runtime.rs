//! Managed provider runtimes.
//!
//! Packaged builds must not depend on whatever Node/codex the user's desktop
//! session PATH happens to contain. Each provider toolchain is published at
//! release time as a pinned, checksummed archive; this module downloads it on
//! first use into the app data dir and resolves binaries from there.

use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

const RUNTIME_MANIFEST_JSON: &str = include_str!("../../runtime-manifest.json");
const INSTALL_MARKER: &str = ".agentree-runtime-ok";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const CLAUDE_GENERATED_FILES: &[&str] = &["ai-label-prompt.txt", "claude-agent-sdk-adapter.mjs"];
const OPENCODE_GENERATED_FILES: &[&str] = &["opencode-agent-sdk-adapter.mjs"];

pub const COMPONENT_NODE: &str = "node";
pub const COMPONENT_CLAUDE_SDK: &str = "claude-sdk";
pub const COMPONENT_CODEX: &str = "codex";
pub const COMPONENT_OPENCODE: &str = "opencode";

static MANIFEST: OnceCell<RuntimeManifest> = OnceCell::new();
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
static VALIDATED_INSTALLS: Lazy<Mutex<HashSet<(PathBuf, String)>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

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
    pub tree_sha256: String,
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

fn fingerprint_exclusions(component: &str) -> &'static [&'static str] {
    if component == COMPONENT_CLAUDE_SDK {
        CLAUDE_GENERATED_FILES
    } else if component == COMPONENT_OPENCODE {
        OPENCODE_GENERATED_FILES
    } else {
        &[]
    }
}

fn update_fingerprint_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn install_tree_sha256(install_dir: &Path, exclusions: &[&str]) -> Result<String, String> {
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

fn validate_install_fingerprint(
    install_dir: &Path,
    expected_tree_sha256: &str,
    exclusions: &[&str],
) -> Result<(), String> {
    let validated = (
        install_dir.to_path_buf(),
        expected_tree_sha256.trim().to_ascii_lowercase(),
    );
    if VALIDATED_INSTALLS
        .lock()
        .map_err(|_| "runtime validation cache lock poisoned".to_string())?
        .contains(&validated)
    {
        return Ok(());
    }

    validate_install_fingerprint_uncached(install_dir, expected_tree_sha256, exclusions)?;
    VALIDATED_INSTALLS
        .lock()
        .map_err(|_| "runtime validation cache lock poisoned".to_string())?
        .insert(validated);
    Ok(())
}

fn validate_install_fingerprint_uncached(
    install_dir: &Path,
    expected_tree_sha256: &str,
    exclusions: &[&str],
) -> Result<(), String> {
    let actual_tree_sha256 = install_tree_sha256(install_dir, exclusions)?;
    if !actual_tree_sha256.eq_ignore_ascii_case(expected_tree_sha256.trim()) {
        return Err(format!(
            "Managed runtime content fingerprint mismatch: expected {}, got {}.",
            expected_tree_sha256, actual_tree_sha256
        ));
    }
    Ok(())
}

/// Returns the install dir only when the pinned component's structure and
/// extracted contents match the checksummed archive. After a full verification,
/// the result is reused for later launches in the same app process.
pub fn installed_component_dir(
    app: &AppHandle,
    component: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = component_install_dir(app, component)?;
    let archive = platform_archive(component)?;
    if dir.join(INSTALL_MARKER).is_file()
        && validate_component_install(component, &dir).is_ok()
        && validate_install_fingerprint(
            &dir,
            &archive.tree_sha256,
            fingerprint_exclusions(component),
        )
        .is_ok()
    {
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
        COMPONENT_OPENCODE => vec![
            (opencode_binary_path(install_dir), true),
            (ripgrep_binary_path(install_dir), true),
            (
                install_dir
                    .join("node_modules")
                    .join("@opencode-ai")
                    .join("sdk")
                    .join("package.json"),
                false,
            ),
            (
                install_dir
                    .join("node_modules")
                    .join("@opencode-ai")
                    .join("sdk")
                    .join("dist")
                    .join("index.js"),
                false,
            ),
        ],
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
    let archive = platform_archive(component)?;
    let validation = validate_component_install(component, &dir).and_then(|_| {
        validate_install_fingerprint_uncached(
            &dir,
            &archive.tree_sha256,
            fingerprint_exclusions(component),
        )
    });
    if validation.is_ok() {
        VALIDATED_INSTALLS
            .lock()
            .map_err(|_| "runtime validation cache lock poisoned".to_string())?
            .insert((dir, archive.tree_sha256.trim().to_ascii_lowercase()));
    }
    Ok(validation.err())
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
    if archive.tree_sha256.trim().is_empty() {
        return Err(format!(
            "Managed {} runtime {} has not been published for {} yet (missing extracted-tree fingerprint in runtime manifest). Run the runtime archive build during release.",
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
        Some(&archive.tree_sha256),
        &install_dir,
        &progress,
        &|staged| validate_component_install(component, staged),
        fingerprint_exclusions(component),
    )?;
    Ok(install_dir)
}

/// Streams a gzipped tarball into place: spool to a temp file while hashing,
/// verify the checksum, unpack into a staging dir, then atomically rename to
/// the final install dir and write the completion marker. A failure at any
/// point leaves no half-installed component behind.
#[cfg(test)]
fn install_archive_from_reader(
    mut reader: impl Read,
    expected_sha256: &str,
    install_dir: &Path,
    progress: &dyn Fn(u64),
) -> Result<(), String> {
    install_archive_from_reader_validated(
        &mut reader,
        expected_sha256,
        None,
        install_dir,
        progress,
        &|_| Ok(()),
        &[],
    )
}

fn install_archive_from_reader_validated(
    mut reader: impl Read,
    expected_sha256: &str,
    expected_tree_sha256: Option<&str>,
    install_dir: &Path,
    progress: &dyn Fn(u64),
    validate: &dyn Fn(&Path) -> Result<(), String>,
    fingerprint_exclusions: &[&str],
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
    let tree_sha256 = install_tree_sha256(staging.path(), fingerprint_exclusions)?;
    if let Some(expected_tree_sha256) = expected_tree_sha256 {
        if !tree_sha256.eq_ignore_ascii_case(expected_tree_sha256.trim()) {
            return Err(format!(
                "Extracted runtime content fingerprint mismatch: expected {}, got {}.",
                expected_tree_sha256, tree_sha256
            ));
        }
    }
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
    if let Ok(mut validated) = VALIDATED_INSTALLS.lock() {
        validated.retain(|entry| entry.0 != install_dir);
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

pub struct OpenCodeAdapterInvocation {
    pub node_program: String,
    pub adapter_script: PathBuf,
    pub opencode_program: String,
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

/// Resolves OpenCode through Agentree's atomic pinned CLI/SDK runtime. Debug
/// builds may use repository dependencies and a PATH CLI while those archives
/// are being prepared; production builds never fall back to host state.
pub fn opencode_adapter_invocation(app: &AppHandle) -> Result<OpenCodeAdapterInvocation, String> {
    let resource_script =
        crate::runtime_scripts::runtime_script_path(app, "opencode-agent-sdk-adapter.mjs")?;

    let runtime_dir = match installed_component_dir(app, COMPONENT_OPENCODE)? {
        Some(dir) => Some(dir),
        None if component_available_for_download(COMPONENT_OPENCODE) => Some(
            ensure_component(app, COMPONENT_OPENCODE)
                .map_err(|error| managed_runtime_required_error("OpenCode runtime", error))?,
        ),
        None if cfg!(debug_assertions) => None,
        None => {
            return Err(managed_runtime_required_error(
                "OpenCode runtime",
                "the runtime archive is not published".to_string(),
            ))
        }
    };
    let adapter_script = if let Some(runtime_dir) = runtime_dir.as_ref() {
        let staged_script = runtime_dir.join("opencode-agent-sdk-adapter.mjs");
        fs::copy(&resource_script, &staged_script).map_err(|error| {
            format!(
                "Could not stage OpenCode adapter into {}: {}",
                runtime_dir.display(),
                error
            )
        })?;
        staged_script
    } else {
        resource_script
    };

    let opencode_program = if let Some(runtime_dir) = runtime_dir {
        opencode_binary_path(&runtime_dir)
            .to_string_lossy()
            .into_owned()
    } else {
        if cfg!(debug_assertions) {
            crate::cli_path::find_on_tool_path("opencode").unwrap_or_else(|| "opencode".to_string())
        } else {
            return Err(managed_runtime_required_error(
                "OpenCode runtime",
                "the runtime archive is not published".to_string(),
            ));
        }
    };

    Ok(OpenCodeAdapterInvocation {
        node_program: node_program(app)?,
        adapter_script,
        opencode_program,
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

pub fn opencode_binary_path(install_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        install_dir.join("bin").join("opencode.exe")
    } else {
        install_dir.join("bin").join("opencode")
    }
}

fn ripgrep_binary_path(install_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        install_dir.join("bin").join("rg.exe")
    } else {
        install_dir.join("bin").join("rg")
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
        for component in [
            COMPONENT_NODE,
            COMPONENT_CLAUDE_SDK,
            COMPONENT_CODEX,
            COMPONENT_OPENCODE,
        ] {
            let spec = manifest
                .components
                .get(component)
                .unwrap_or_else(|| panic!("manifest missing {component}"));
            assert!(!spec.version.trim().is_empty());
            assert!(spec.platforms.contains_key("linux-x86_64"));
            assert!(spec.platforms.contains_key("darwin-aarch64"));
            for archive in spec.platforms.values() {
                assert!(!archive.url.trim().is_empty());
                assert_eq!(
                    archive.sha256.trim().is_empty(),
                    archive.tree_sha256.trim().is_empty(),
                    "runtime archives must publish archive and tree fingerprints together"
                );
            }
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
        let trusted_tree_sha256 = install_tree_sha256(&install_dir, &[]).unwrap();
        validate_install_fingerprint(&install_dir, &trusted_tree_sha256, &[])
            .expect("fresh install fingerprint should match");
    }

    #[test]
    fn install_fingerprint_rejects_modified_runtime_content() {
        let archive = build_archive(&[("bin/codex", b"trusted".as_slice())]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("codex").join("0.139.0");
        install_archive_from_reader(archive.as_slice(), &checksum, &install_dir, &|_| {})
            .expect("install should succeed");
        let trusted_tree_sha256 = install_tree_sha256(&install_dir, &[]).unwrap();

        std::fs::write(install_dir.join("bin").join("codex"), b"tampered").unwrap();

        let error = validate_install_fingerprint(&install_dir, &trusted_tree_sha256, &[])
            .expect_err("modified content must invalidate the install");
        assert!(error.contains("content fingerprint mismatch"));

        std::fs::write(install_dir.join(INSTALL_MARKER), b"forged").unwrap();
        let error = validate_install_fingerprint(&install_dir, &trusted_tree_sha256, &[])
            .expect_err("changing the local marker must not replace the embedded fingerprint");
        assert!(error.contains("content fingerprint mismatch"));
    }

    #[test]
    fn install_fingerprint_rejects_unexpected_files_but_allows_claude_generated_files() {
        let archive = build_archive(&[("sdk.mjs", b"trusted".as_slice())]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("claude-sdk").join("0.3.207");
        install_archive_from_reader_validated(
            archive.as_slice(),
            &checksum,
            None,
            &install_dir,
            &|_| {},
            &|_| Ok(()),
            CLAUDE_GENERATED_FILES,
        )
        .expect("install should succeed");
        let trusted_tree_sha256 =
            install_tree_sha256(&install_dir, CLAUDE_GENERATED_FILES).unwrap();

        std::fs::write(
            install_dir.join("claude-agent-sdk-adapter.mjs"),
            b"generated",
        )
        .unwrap();
        assert_eq!(
            install_tree_sha256(&install_dir, CLAUDE_GENERATED_FILES).unwrap(),
            trusted_tree_sha256,
            "known app-generated files should not invalidate the archive"
        );

        std::fs::write(install_dir.join("unexpected.js"), b"tampered").unwrap();
        let error = validate_install_fingerprint(
            &install_dir,
            &trusted_tree_sha256,
            CLAUDE_GENERATED_FILES,
        )
        .expect_err("unexpected files must invalidate the install");
        assert!(error.contains("content fingerprint mismatch"));
    }

    #[test]
    fn completion_marker_cannot_override_the_embedded_fingerprint() {
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("node").join("22.21.1");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::write(install_dir.join(INSTALL_MARKER), b"ok").unwrap();

        let error = validate_install_fingerprint(&install_dir, "deadbeef", &[])
            .expect_err("the local completion marker must not establish integrity");
        assert!(error.contains("content fingerprint mismatch"));
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
    fn install_archive_rejects_tree_fingerprint_mismatch_without_leaving_files() {
        let archive = build_archive(&[("bin/node", b"node".as_slice())]);
        let checksum = sha256_hex(&archive);
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("node").join("22.21.1");

        let error = install_archive_from_reader_validated(
            archive.as_slice(),
            &checksum,
            Some("deadbeef"),
            &install_dir,
            &|_| {},
            &|_| Ok(()),
            &[],
        )
        .expect_err("embedded tree fingerprint mismatch must fail");

        assert!(error.contains("Extracted runtime content fingerprint mismatch"));
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
    fn opencode_install_validation_requires_cli_sdk_and_ripgrep() {
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("opencode").join("1.18.3");
        let sdk_dir = install_dir
            .join("node_modules")
            .join("@opencode-ai")
            .join("sdk");
        let bin_dir = install_dir.join("bin");
        std::fs::create_dir_all(&sdk_dir).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(sdk_dir.join("package.json"), br#"{"version":"1.18.3"}"#).unwrap();

        let opencode = bin_dir.join("opencode");
        std::fs::write(&opencode, b"#!fake").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&opencode, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let error = validate_component_install_for_platform(
            COMPONENT_OPENCODE,
            &install_dir,
            "linux-x86_64",
        )
        .expect_err("the OpenCode CLI and SDK without ripgrep must be incomplete");
        assert!(error.contains("bin/rg"));

        let ripgrep = bin_dir.join("rg");
        std::fs::write(&ripgrep, b"#!fake").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&ripgrep, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let error = validate_component_install_for_platform(
            COMPONENT_OPENCODE,
            &install_dir,
            "linux-x86_64",
        )
        .expect_err("the SDK package marker without its import entrypoint must be incomplete");
        assert!(error.contains("dist/index.js"));

        std::fs::create_dir_all(sdk_dir.join("dist")).unwrap();
        std::fs::write(sdk_dir.join("dist").join("index.js"), b"export {};").unwrap();
        validate_component_install_for_platform(COMPONENT_OPENCODE, &install_dir, "linux-x86_64")
            .expect("the combined OpenCode runtime should be complete");
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
            None,
            &install_dir,
            &|_| {},
            &|staged| {
                validate_component_install_for_platform(
                    COMPONENT_CLAUDE_SDK,
                    staged,
                    "linux-x86_64",
                )
            },
            &[],
        )
        .expect_err("an incomplete but checksummed archive must be rejected");

        assert!(error.contains("claude-agent-sdk-linux-x64"));
        assert!(!install_dir.exists());
    }
}

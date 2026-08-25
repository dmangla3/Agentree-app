fn main() {
    rerun_if_changed("scripts");
    rerun_if_changed("python-sdk");
    rerun_if_changed("binaries");
    validate_release_codex_adapter_sidecar();
    compile_metric_kit_bridge();
    tauri_build::build()
}

fn validate_release_codex_adapter_sidecar() {
    if std::env::var("PROFILE").ok().as_deref() != Some("release") {
        return;
    }

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if !release_requires_codex_adapter_sidecar(&target_os) {
        return;
    }

    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let Some(binary_name) = codex_adapter_binary_name_for(&target_os, &target_arch) else {
        panic!(
            "release build target is missing a Codex adapter sidecar mapping: \
             {target_os} {target_arch}"
        );
    };

    let binary_path = std::path::Path::new("binaries").join(&binary_name);
    if !binary_path.exists() {
        panic!(
            "release build requires Codex adapter sidecar: {}",
            binary_path.display()
        );
    }
}

fn release_requires_codex_adapter_sidecar(target_os: &str) -> bool {
    // Linux is helper-only because relying on system Python caused failed_spawn
    // in real logs. macOS keeps the legacy Python path until the Apple helper is
    // added; to make macOS helper-only, return true for "macos" here and in
    // runtime_scripts::requires_codex_adapter_helper.
    target_os == "linux"
}

fn codex_adapter_binary_name_for(target_os: &str, target_arch: &str) -> Option<String> {
    let triple = match (target_os, target_arch) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        _ => return None,
    };
    Some(format!("codex-app-server-adapter-{triple}"))
}

fn compile_metric_kit_bridge() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }

    let out_dir = std::path::PathBuf::from(
        std::env::var_os("OUT_DIR").expect("OUT_DIR must be set by Cargo"),
    );
    let object_path = out_dir.join("metric_kit_bridge.o");
    let lib_path = out_dir.join("libagentree_metric_kit_bridge.a");

    println!("cargo:rerun-if-changed=src/metric_kit_bridge.m");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=MetricKit");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=agentree_metric_kit_bridge");

    run_build_command(
        "cc",
        std::process::Command::new("cc")
            .arg("-fobjc-arc")
            .arg("-c")
            .arg("src/metric_kit_bridge.m")
            .arg("-o")
            .arg(&object_path),
    );
    run_build_command(
        "ar",
        std::process::Command::new("ar")
            .arg("crs")
            .arg(&lib_path)
            .arg(&object_path),
    );
}

fn run_build_command(label: &str, command: &mut std::process::Command) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("failed to run {label} for MetricKit bridge: {error}"));
    if !status.success() {
        panic!("MetricKit bridge {label} command failed with status {status}");
    }
}

fn rerun_if_changed(path: &str) {
    println!("cargo:rerun-if-changed={path}");
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child_path = entry.path();
            if child_path.is_dir() {
                if let Some(child_path) = child_path.to_str() {
                    rerun_if_changed(child_path);
                }
            } else {
                println!("cargo:rerun-if-changed={}", child_path.display());
            }
        }
    }
}

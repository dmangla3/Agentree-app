// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn nvidia_proprietary_driver_present() -> bool {
    // The proprietary NVIDIA driver is the only one that exposes this procfs
    // entry; Intel, AMD, and the open `nouveau` driver never create it.
    std::path::Path::new("/proc/driver/nvidia/version").exists()
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_runtime() {
    // Keep GPU-accelerated compositing enabled for everyone. We deliberately do
    // NOT set WEBKIT_DISABLE_COMPOSITING_MODE: that forces pure CPU/software
    // rendering (laggy graph pan/zoom) and is not required to avoid the
    // NVIDIA/GBM startup abort.
    //
    // The startup abort comes from WebKitGTK's DMA-BUF renderer hitting the
    // NVIDIA proprietary driver's historically incomplete GBM/DMA-BUF support.
    // Disabling only the DMA-BUF renderer avoids the abort while keeping GPU
    // rendering. Intel/AMD/nouveau keep the fast zero-copy DMA-BUF path.
    //
    // Any pre-set value (power users, CI, hybrid-GPU edge cases) always wins.
    if nvidia_proprietary_driver_present()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    if let Some(exit_code) = agentree_lib::maybe_run_codex_adapter_from_process_args() {
        std::process::exit(exit_code);
    }

    #[cfg(target_os = "linux")]
    configure_linux_webkit_runtime();

    agentree_lib::run()
}

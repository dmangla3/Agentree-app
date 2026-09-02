// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn configure_linux_webkit_runtime() {
    // WebKitGTK can abort during startup on some NVIDIA/GBM stacks unless the
    // DMA-BUF renderer is disabled before Wry creates the webview.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
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

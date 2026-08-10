use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use once_cell::sync::OnceCell;
    use std::ffi::{c_char, c_int, CStr};

    static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

    extern "C" {
        fn agentree_metric_kit_start(callback: extern "C" fn(*const c_char)) -> c_int;
    }

    extern "C" fn handle_metric_kit_payload(payload_json: *const c_char) {
        let _ = std::panic::catch_unwind(|| {
            if payload_json.is_null() {
                crate::app_log!("[METRICKIT] event=payload_ignored reason=null_payload");
                return;
            }

            let payload = unsafe { CStr::from_ptr(payload_json) }
                .to_string_lossy()
                .into_owned();

            let Some(app) = APP_HANDLE.get() else {
                crate::app_log!("[METRICKIT] event=payload_ignored reason=app_handle_unavailable");
                return;
            };

            match crate::logging::persist_metric_kit_diagnostic_payload(app, &payload) {
                Ok(persisted) => crate::app_log!(
                    "[METRICKIT] event=diagnostic_payload_persisted path={} hangDiagnostics={} crashDiagnostics={}",
                    persisted.path,
                    persisted.summary.hang_diagnostics_count,
                    persisted.summary.crash_diagnostics_count
                ),
                Err(error) => crate::app_log!(
                    "[METRICKIT] event=diagnostic_payload_persist_failed error={}",
                    error
                ),
            }
        });
    }

    pub fn start(app: AppHandle) {
        let _ = APP_HANDLE.set(app);
        let started = unsafe { agentree_metric_kit_start(handle_metric_kit_payload) };
        if started == 1 {
            crate::app_log!("[METRICKIT] event=subscriber_started");
        } else {
            crate::app_log!(
                "[METRICKIT] event=subscriber_skipped reason=unavailable_or_callback_missing"
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn start(_app: AppHandle) {
        crate::app_log!("[METRICKIT] event=subscriber_skipped reason=unsupported_platform");
    }
}

pub fn start_metric_kit(app: AppHandle) {
    platform::start(app);
}

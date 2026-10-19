use axum::{
    extract::OriginalUri,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use once_cell::sync::Lazy;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static AUTH_CALLBACK_STARTED: AtomicBool = AtomicBool::new(false);
static AUTH_CALLBACK_APP: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));
static AUTH_CALLBACK_LOGO_DATA_URI: Lazy<String> = Lazy::new(|| {
    let bytes = include_bytes!("../../src/assets/logo.png");
    format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes))
});
#[cfg(debug_assertions)]
const CLOUD_AUTH_KEYCHAIN_SERVICE: &str = "com.agentree.agentree.dev.cloud-auth";
#[cfg(not(debug_assertions))]
const CLOUD_AUTH_KEYCHAIN_SERVICE: &str = "com.agentree.agentree.cloud-auth";
const CLOUD_AUTH_KEYCHAIN_ACCOUNT: &str = "agentree-cloud-session";

#[cfg(debug_assertions)]
const DEFAULT_AUTH_CALLBACK_PORT: u16 = 34118;
#[cfg(not(debug_assertions))]
const DEFAULT_AUTH_CALLBACK_PORT: u16 = 34117;

pub fn auth_callback_base_url() -> String {
    let port = std::env::var("AGENTREE_AUTH_CALLBACK_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_AUTH_CALLBACK_PORT);

    format!("http://127.0.0.1:{}/kinde/callback", port)
}

pub fn is_auth_callback_url(_url: &tauri::Url) -> bool {
    let Ok(callback_base_url) = tauri::Url::parse(&auth_callback_base_url()) else {
        return false;
    };

    _url.scheme() == callback_base_url.scheme()
        && _url.host_str() == callback_base_url.host_str()
        && _url.port_or_known_default() == callback_base_url.port_or_known_default()
        && _url.path() == callback_base_url.path()
}

#[tauri::command]
#[specta::specta]
pub fn get_auth_callback_base_url() -> String {
    auth_callback_base_url()
}

#[tauri::command]
#[specta::specta]
pub async fn save_agentree_cloud_session(session_json: String) -> Result<(), String> {
    run_cloud_auth_task(move || save_agentree_cloud_session_blocking(session_json)).await
}

fn save_agentree_cloud_session_blocking(session_json: String) -> Result<(), String> {
    let entry =
        crate::secure_store::open_entry(CLOUD_AUTH_KEYCHAIN_SERVICE, CLOUD_AUTH_KEYCHAIN_ACCOUNT)
            .map_err(|error| format!("failed to open cloud auth vault: {}", error))?;
    crate::secure_store::set_password(&entry, &session_json)
        .map_err(|error| format!("failed to save cloud auth session: {}", error))
}

#[tauri::command]
#[specta::specta]
pub async fn read_agentree_cloud_session() -> Result<Option<String>, String> {
    run_cloud_auth_task(read_agentree_cloud_session_blocking).await
}

fn read_agentree_cloud_session_blocking() -> Result<Option<String>, String> {
    let entry =
        crate::secure_store::open_entry(CLOUD_AUTH_KEYCHAIN_SERVICE, CLOUD_AUTH_KEYCHAIN_ACCOUNT)
            .map_err(|error| format!("failed to open cloud auth vault: {}", error))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read cloud auth session: {}", error)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn clear_agentree_cloud_session() -> Result<(), String> {
    run_cloud_auth_task(clear_agentree_cloud_session_blocking).await
}

fn clear_agentree_cloud_session_blocking() -> Result<(), String> {
    let entry =
        crate::secure_store::open_entry(CLOUD_AUTH_KEYCHAIN_SERVICE, CLOUD_AUTH_KEYCHAIN_ACCOUNT)
            .map_err(|error| format!("failed to open cloud auth vault: {}", error))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to clear cloud auth session: {}", error)),
    }
}

async fn run_cloud_auth_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("cloud auth vault task failed: {}", error))?
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_auth_callback_server_started(app_handle: AppHandle) -> Result<String, String> {
    let callback_url = auth_callback_base_url();
    if AUTH_CALLBACK_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(callback_url);
    }

    if let Ok(mut guard) = AUTH_CALLBACK_APP.lock() {
        *guard = Some(app_handle);
    }

    let port = std::env::var("AGENTREE_AUTH_CALLBACK_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_AUTH_CALLBACK_PORT);

    let app = Router::new().route("/kinde/callback", get(handle_kinde_callback));
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();

    crate::app_log!("[Auth] Starting Kinde callback server on http://{}", addr);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            let message = format!(
                "[Auth] Failed to bind Kinde callback server on http://{addr}: address already in use. Another Agentree instance, often the installed /Applications app, is probably already running. Quit that app or set AGENTREE_AUTH_CALLBACK_PORT to an allowed Kinde redirect port. Original error: {error}"
            );
            crate::app_log!("{}", message);
            AUTH_CALLBACK_STARTED.store(false, Ordering::SeqCst);
            return Err(message);
        }
        Err(error) => {
            let message =
                format!("[Auth] Failed to bind Kinde callback server on http://{addr}: {error}");
            crate::app_log!("{}", message);
            AUTH_CALLBACK_STARTED.store(false, Ordering::SeqCst);
            return Err(message);
        }
    };

    tauri::async_runtime::spawn(async move {
        crate::app_log!("[Auth] Kinde callback server listening on http://{}", addr);

        if let Err(error) = axum::serve(listener, app).await {
            crate::app_log!("[Auth] Kinde callback server error: {}", error);
        }
    });

    Ok(callback_url)
}

async fn handle_kinde_callback(OriginalUri(uri): OriginalUri) -> impl IntoResponse {
    let is_logout = uri
        .query()
        .map(|query| {
            query.split('&').any(|pair| {
                let mut parts = pair.splitn(2, '=');
                matches!(
                    (parts.next(), parts.next()),
                    (Some("agentree_action"), Some("logout"))
                )
            })
        })
        .unwrap_or(false);

    let callback_url = format!(
        "{}{}",
        auth_callback_base_url(),
        uri.query()
            .map(|query| format!("?{}", query))
            .unwrap_or_default()
    );

    if let Ok(guard) = AUTH_CALLBACK_APP.lock() {
        if let Some(app) = guard.as_ref() {
            if let Err(error) = app.emit("kinde-auth-callback", callback_url) {
                crate::app_log!("[Auth] Failed to emit Kinde callback event: {}", error);
            }
        }
    }

    let (title, heading, body) = if is_logout {
        (
            "Agentree sign out complete",
            "You are signed out from Agentree.",
            "You can close this tab.",
        )
    } else {
        (
            "Agentree sign in complete",
            "You are signed in to Agentree",
            "You can close this tab and return to the app.",
        )
    };

    Html(format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>{title}</title>
    <style>
      body {{
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f8fafc;
        color: #111827;
      }}
      main {{
        max-width: 520px;
        margin: 24px;
        padding: 32px;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        box-shadow: 0 20px 40px -30px rgba(15, 23, 42, 0.35);
        text-align: center;
      }}
      .brand {{
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 22px;
      }}
      .brand img {{
        width: 124px;
        height: 124px;
        object-fit: contain;
      }}
      h1 {{ margin: 0 0 12px; font-size: 24px; }}
      p {{ margin: 0; color: #4b5563; line-height: 1.6; }}
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <img src="{logo_data_uri}" alt="Agentree logo" />
      </div>
      <h1>{heading}</h1>
      <p>{body}</p>
    </main>
  </body>
</html>"#,
        title = title,
        logo_data_uri = AUTH_CALLBACK_LOGO_DATA_URI.as_str(),
        heading = heading,
        body = body
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_auth_callback_port_env<R>(value: Option<&str>, test: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().expect("auth callback env lock poisoned");
        let previous = std::env::var("AGENTREE_AUTH_CALLBACK_PORT").ok();
        match value {
            Some(value) => std::env::set_var("AGENTREE_AUTH_CALLBACK_PORT", value),
            None => std::env::remove_var("AGENTREE_AUTH_CALLBACK_PORT"),
        }

        let result = test();

        match previous {
            Some(value) => std::env::set_var("AGENTREE_AUTH_CALLBACK_PORT", value),
            None => std::env::remove_var("AGENTREE_AUTH_CALLBACK_PORT"),
        }

        result
    }

    #[test]
    fn debug_build_uses_separate_default_auth_callback_port() {
        with_auth_callback_port_env(None, || {
            assert_eq!(
                auth_callback_base_url(),
                "http://127.0.0.1:34118/kinde/callback"
            );
        });
    }

    #[test]
    fn configured_auth_callback_port_overrides_default() {
        with_auth_callback_port_env(Some("34119"), || {
            assert_eq!(
                auth_callback_base_url(),
                "http://127.0.0.1:34119/kinde/callback"
            );
        });
    }

    #[test]
    fn recognizes_configured_auth_callback_navigation() {
        with_auth_callback_port_env(Some("34119"), || {
            let url =
                tauri::Url::parse("http://127.0.0.1:34119/kinde/callback?code=abc&state=state")
                    .expect("valid callback url");

            assert!(is_auth_callback_url(&url));
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cloud_auth_tasks_run_off_the_calling_thread() {
        let calling_thread = std::thread::current().id();

        let worker_thread = run_cloud_auth_task(|| Ok(std::thread::current().id()))
            .await
            .expect("cloud auth task should complete");

        assert_ne!(worker_thread, calling_thread);
    }
}

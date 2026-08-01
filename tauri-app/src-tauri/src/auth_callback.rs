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

const DEFAULT_AUTH_CALLBACK_PORT: u16 = 34117;

pub fn auth_callback_base_url() -> String {
    let port = std::env::var("AGENTREE_AUTH_CALLBACK_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_AUTH_CALLBACK_PORT);

    format!("http://127.0.0.1:{}/kinde/callback", port)
}

#[tauri::command]
#[specta::specta]
pub fn get_auth_callback_base_url() -> String {
    auth_callback_base_url()
}

pub fn start_auth_callback_server(app_handle: AppHandle) {
    if AUTH_CALLBACK_STARTED.swap(true, Ordering::SeqCst) {
        return;
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

    tauri::async_runtime::spawn(async move {
        crate::app_log!("[Auth] Starting Kinde callback server on http://{}", addr);
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                crate::app_log!("[Auth] Failed to bind Kinde callback server: {}", error);
                return;
            }
        };

        if let Err(error) = axum::serve(listener, app).await {
            crate::app_log!("[Auth] Kinde callback server error: {}", error);
        }
    });
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

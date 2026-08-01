const DEV_SERVER_URL: &str = "http://localhost:3000";
#[cfg(not(debug_assertions))]
const PRODUCTION_SERVER_URL: &str = "https://api.agentree.app";

pub fn server_base_url() -> String {
    std::env::var("AGENTREE_SERVER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            option_env!("AGENTREE_SERVER_URL")
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| default_server_url().to_string())
        .trim_end_matches('/')
        .to_string()
}

#[cfg(debug_assertions)]
fn default_server_url() -> &'static str {
    DEV_SERVER_URL
}

#[cfg(not(debug_assertions))]
fn default_server_url() -> &'static str {
    PRODUCTION_SERVER_URL
}

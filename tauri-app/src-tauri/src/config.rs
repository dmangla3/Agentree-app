const DEV_SERVER_URL: &str = "http://localhost:3000";
#[cfg(not(debug_assertions))]
const OFFICIAL_PRODUCTION_SERVER_URL: &str = "https://api.agentree.app";
const INVALID_CLOUD_SERVER_MESSAGE: &str = "Cloud sync is unavailable because this Agentree build has no valid server configured. Use a cloud-enabled build or configure an absolute AGENTREE_SERVER_URL and restart Agentree.";

pub fn server_base_url() -> String {
    std::env::var("AGENTREE_SERVER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            option_env!("AGENTREE_SERVER_URL")
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(default_server_url)
        .trim_end_matches('/')
        .to_string()
}

pub fn validated_server_base_url() -> Result<String, String> {
    validate_server_base_url(&server_base_url())
}

fn validate_server_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed =
        reqwest::Url::parse(value).map_err(|_| INVALID_CLOUD_SERVER_MESSAGE.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(INVALID_CLOUD_SERVER_MESSAGE.to_string());
    }
    Ok(value.to_string())
}

#[cfg(debug_assertions)]
fn default_server_url() -> String {
    DEV_SERVER_URL.to_string()
}

#[cfg(test)]
mod tests {
    use super::validate_server_base_url;

    #[test]
    fn cloud_server_requires_an_absolute_http_url() {
        assert!(validate_server_base_url("").is_err());
        assert!(validate_server_base_url("/api").is_err());
        assert!(validate_server_base_url("file:///tmp/agentree").is_err());
        assert!(validate_server_base_url("https://example.com/api?token=secret").is_err());
        assert!(validate_server_base_url("https://example.com/api#sync").is_err());
        assert_eq!(
            validate_server_base_url("https://example.com/api/").unwrap(),
            "https://example.com/api"
        );
        assert_eq!(
            validate_server_base_url("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
    }
}

#[cfg(not(debug_assertions))]
fn default_server_url() -> String {
    match option_env!("AGENTREE_OFFICIAL_CLOUD") {
        Some("true") => OFFICIAL_PRODUCTION_SERVER_URL.to_string(),
        _ => String::new(),
    }
}

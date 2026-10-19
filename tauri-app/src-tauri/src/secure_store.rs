use keyring::Entry;

pub fn open_entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|error| error.to_string())
}

pub fn set_password(entry: &Entry, password: &str) -> Result<(), String> {
    entry
        .set_password(password)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn default_store_uses_macos_keychain_backend() {
        let entry =
            open_entry("com.agentree.agentree.backend-test", "backend-test").expect("open entry");

        assert!(entry
            .get_credential()
            .downcast_ref::<keyring::macos::MacCredential>()
            .is_some());
    }
}

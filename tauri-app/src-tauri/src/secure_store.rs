use keyring::Entry;

pub fn open_entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|error| error.to_string())
}

pub fn set_password_verified(entry: &Entry, password: &str) -> Result<(), String> {
    entry
        .set_password(password)
        .map_err(|error| error.to_string())?;

    let stored_password = entry.get_password().map_err(|error| error.to_string())?;
    if stored_password != password {
        return Err("secure storage verification returned different credential data".to_string());
    }

    Ok(())
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

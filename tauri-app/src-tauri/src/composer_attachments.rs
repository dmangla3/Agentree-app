use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};

const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Serialize, specta::Type)]
pub struct SavedComposerAttachment {
    pub path: String,
    pub size_bytes: u64,
}

fn sanitize_segment(value: &str, fallback: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(128).collect()
    }
}

fn decode_base64_payload(value: &str) -> Result<Vec<u8>, String> {
    let payload = value
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:") && prefix.contains(";base64"))
        .map(|(_, payload)| payload)
        .unwrap_or(value)
        .trim();
    let bytes = BASE64_STANDARD
        .decode(payload)
        .map_err(|error| format!("Attachment data is not valid base64: {error}"))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachment is too large. Maximum supported size is {} MB.",
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    Ok(bytes)
}

#[tauri::command]
#[specta::specta]
pub fn save_composer_attachment(
    app: AppHandle,
    workspace_id: String,
    attachment_id: String,
    filename: String,
    data_base64: String,
) -> Result<SavedComposerAttachment, String> {
    let workspace_segment = sanitize_segment(&workspace_id, "workspace");
    let attachment_segment = sanitize_segment(&attachment_id, "attachment");
    let filename_segment = sanitize_segment(&filename, "attachment.bin");
    let bytes = decode_base64_payload(&data_base64)?;

    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache dir: {error}"))?
        .join("composer-attachments")
        .join(workspace_segment)
        .join(attachment_segment);
    fs::create_dir_all(&base_dir)
        .map_err(|error| format!("Could not create attachment cache directory: {error}"))?;
    let file_path = base_dir.join(filename_segment);
    fs::write(&file_path, &bytes)
        .map_err(|error| format!("Could not write attachment cache file: {error}"))?;

    Ok(SavedComposerAttachment {
        path: file_path.to_string_lossy().to_string(),
        size_bytes: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::{decode_base64_payload, sanitize_segment};

    #[test]
    fn sanitizes_path_segments() {
        assert_eq!(
            sanitize_segment("../bad name.png", "fallback"),
            "_bad_name.png"
        );
        assert_eq!(sanitize_segment("", "fallback"), "fallback");
    }

    #[test]
    fn decodes_plain_and_data_url_base64() {
        assert_eq!(decode_base64_payload("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(
            decode_base64_payload("data:text/plain;base64,aGVsbG8=").unwrap(),
            b"hello"
        );
    }
}

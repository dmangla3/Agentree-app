use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct Editor {
    pub name: String,
    pub command: String,
    pub icon_key: String, // For frontend to map to an icon
}

#[tauri::command]
#[specta::specta]
pub fn get_available_editors() -> Vec<Editor> {
    let mut editors = Vec::new();

    // Always add Finder
    editors.push(Editor {
        name: "Finder".to_string(),
        command: "open".to_string(),
        icon_key: "finder".to_string(),
    });

    // Check for VS Code
    if is_command_available("code") {
        editors.push(Editor {
            name: "VS Code".to_string(),
            command: "code".to_string(),
            icon_key: "vscode".to_string(),
        });
    }

    // Check for Cursor
    if is_command_available("cursor") {
        editors.push(Editor {
            name: "Cursor".to_string(),
            command: "cursor".to_string(),
            icon_key: "cursor".to_string(),
        });
    }

    // Check for Zed
    if is_command_available("zed") {
        editors.push(Editor {
            name: "Zed".to_string(),
            command: "zed".to_string(),
            icon_key: "zed".to_string(),
        });
    }

    // Check for Sublime Text
    if is_command_available("subl") {
        editors.push(Editor {
            name: "Sublime Text".to_string(),
            command: "subl".to_string(),
            icon_key: "sublime".to_string(),
        });
    }

    // Check for Atom (Legacy)
    if is_command_available("atom") {
        editors.push(Editor {
            name: "Atom".to_string(),
            command: "atom".to_string(),
            icon_key: "atom".to_string(),
        });
    }

    // Check for IntelliJ IDEA (command line launcher 'idea')
    if is_command_available("idea") {
        editors.push(Editor {
            name: "IntelliJ IDEA".to_string(),
            command: "idea".to_string(),
            icon_key: "intellij".to_string(),
        });
    }

    editors
}

fn is_command_available(cmd: &str) -> bool {
    // On macOS/Linux, use 'which' to check availability
    // Note: This relies on the PATH seen by the Tauri app.
    // GUI apps on macOS might have a limited PATH compared to terminal.
    // We might need to check common paths manually if 'which' fails.

    if let Ok(status) = Command::new("which").arg(cmd).status() {
        if status.success() {
            return true;
        }
    }

    // Fallback: Check common locations on macOS
    let common_paths = [
        format!("/usr/local/bin/{}", cmd),
        format!("/opt/homebrew/bin/{}", cmd),
        format!("/usr/bin/{}", cmd),
    ];

    for path in common_paths.iter() {
        if std::path::Path::new(path).exists() {
            return true;
        }
    }

    false
}

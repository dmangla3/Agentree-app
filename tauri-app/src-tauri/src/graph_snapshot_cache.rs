use std::fs;
use tauri::{AppHandle, Manager};

fn cache_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("graph-snapshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn cache_path(app: &AppHandle, workspace_id: &str) -> Result<std::path::PathBuf, String> {
    if !workspace_id
        .chars()
        .all(|char| char.is_ascii_alphanumeric() || char == '-')
    {
        return Err("Invalid workspace id for graph snapshot cache.".to_string());
    }
    Ok(cache_dir(app)?.join(format!("v2-{workspace_id}.json")))
}

#[tauri::command]
#[specta::specta]
pub fn read_graph_snapshot_cache(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let path = cache_path(&app, &workspace_id)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn write_graph_snapshot_cache(
    app: AppHandle,
    workspace_id: String,
    contents: String,
) -> Result<(), String> {
    let path = cache_path(&app, &workspace_id)?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_graph_snapshot_cache(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let path = cache_path(&app, &workspace_id)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|error| error.to_string())
}

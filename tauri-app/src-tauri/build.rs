fn main() {
    rerun_if_changed("scripts");
    rerun_if_changed("python-sdk");
    tauri_build::build()
}

fn rerun_if_changed(path: &str) {
    println!("cargo:rerun-if-changed={path}");
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child_path = entry.path();
            if child_path.is_dir() {
                if let Some(child_path) = child_path.to_str() {
                    rerun_if_changed(child_path);
                }
            } else {
                println!("cargo:rerun-if-changed={}", child_path.display());
            }
        }
    }
}

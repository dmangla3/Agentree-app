use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
fn macos_menu_without_close_window(
    app_handle: &tauri::AppHandle<tauri::Wry>,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let pkg_info = app_handle.package_info();
    let config = app_handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    Menu::with_items(
        app_handle,
        &[
            &Submenu::with_items(
                app_handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app_handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::services(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::hide(app_handle, None)?,
                    &PredefinedMenuItem::hide_others(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::quit(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app_handle, None)?,
                    &PredefinedMenuItem::redo(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::cut(app_handle, None)?,
                    &PredefinedMenuItem::copy(app_handle, None)?,
                    &PredefinedMenuItem::paste(app_handle, None)?,
                    &PredefinedMenuItem::select_all(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app_handle, None)?],
            )?,
            &Submenu::with_items(
                app_handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app_handle, None)?,
                    &PredefinedMenuItem::maximize(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(app_handle, "Help", true, &[])?,
        ],
    )
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use agents::AgentState;
use db::TelemetryDb;
use merge_review::MergeReviewState;
#[cfg(test)]
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, collect_events, Builder as SpectaBuilder, ErrorHandlingMode};

mod agent_launch;
mod agents;
mod artifacts;
mod auth_callback;
mod cli_path;
mod codex_adapter;
mod command_guards;
mod composer_attachments;
mod config;
mod db;
mod editors;
mod git_workspace;
mod graph_snapshot_cache;
mod logging;
mod login_profiles;
mod managed_runtime;
mod mcp;
mod merge_review;
mod metric_kit;
mod process_runner;
mod provider_skills;
pub mod runtime_archive;
mod runtime_model_catalog;
mod runtime_readiness;
mod runtime_scripts;
mod secure_store;
mod terminal;
mod thread_control;
mod tool_output;
pub mod types;
mod worktree_config;

pub fn maybe_run_codex_adapter_from_process_args() -> Option<i32> {
    codex_adapter::maybe_run_from_process_args()
}

#[macro_export]
macro_rules! app_log {
    ($($arg:tt)*) => {{
        let rendered = format!($($arg)*);
        let _ = crate::logging::append_backend_line_without_app(&rendered);
        eprintln!("{}", rendered);
    }};
}

fn specta_builder() -> SpectaBuilder<tauri::Wry> {
    SpectaBuilder::<tauri::Wry>::new()
        .dangerously_cast_bigints_to_number()
        .error_handling(ErrorHandlingMode::Throw)
        .events(collect_events![login_profiles::LoginProfilesChangedEvent,])
        .commands(collect_commands![
            greet,
            logging::append_frontend_logs,
            logging::get_log_paths,
            logging::get_diagnostics_logs,
            logging::export_perf_capture_bundle,
            db::create_session_db,
            db::record_tool_call,
            db::kv_set,
            db::kv_get,
            db::save_orchestration_user_templates,
            db::get_orchestration_user_templates,
            db::save_default_prompt_overrides,
            db::get_default_prompt_overrides,
            db::add_message,
            db::update_session_status,
            db::get_session_snapshot,
            db::get_agent_run_ledger,
            db::replay_agent_run_events,
            db::list_local_nodes,
            db::list_local_insights,
            db::list_local_insight_candidates,
            db::upsert_local_insight,
            db::local_first_dismiss_insight,
            db::record_local_insight_feedback,
            db::hydrate_local_nodes_from_server,
            db::local_first_create_thread_session,
            db::convert_subgraph_to_thread,
            db::list_thread_sessions,
            db::local_first_delete_thread_session,
            db::upsert_local_node,
            db::local_first_update_node_tags,
            db::local_first_update_node_highlight,
            db::local_first_set_node_collapsed,
            db::import_local_commits,
            db::list_local_commit_graph,
            db::repair_local_commit_graph,
            db::enqueue_local_commit_graph_sync,
            db::get_local_identity,
            db::list_local_workspaces,
            db::merge_server_workspaces,
            db::local_first_create_workspace,
            db::local_first_rename_workspace,
            db::local_first_reconnect_workspace,
            db::enable_workspace_cloud_backup,
            db::local_first_delete_branch,
            db::local_first_delete_workspace,
            db::list_local_deleted_node_roots,
            db::list_local_deleted_workspace_ids,
            db::get_cloud_sync_capability,
            db::get_next_local_sync_retry_at,
            db::process_local_sync_events,
            agents::start_agent_run,
            agent_launch::launch_agent_message,
            agents::stop_agent,
            agents::steer_agent_run,
            agents::get_agent_run_state,
            agents::list_agent_resource_usage,
            login_profiles::list_login_profiles,
            login_profiles::read_opencode_login_profile_auth,
            login_profiles::upsert_login_profile,
            login_profiles::delete_login_profile,
            login_profiles::set_default_login_profile,
            login_profiles::list_active_login_profile_runs,
            login_profiles::check_login_profile_readiness,
            login_profiles::ensure_login_profile_ready,
            login_profiles::connect_codex_login_profile,
            login_profiles::connect_claude_oauth_login_profile,
            login_profiles::poll_claude_oauth_login_profile,
            login_profiles::submit_claude_oauth_login_code,
            login_profiles::check_all_login_profile_readiness,
            login_profiles::discover_login_import_candidates,
            login_profiles::import_discovered_login_profile,
            login_profiles::import_existing_runtime_login,
            runtime_readiness::refresh_provider_limits,
            runtime_readiness::check_managed_runtime_doctor,
            runtime_readiness::repair_managed_runtime_component,
            runtime_model_catalog::get_runtime_model_catalogs,
            runtime_model_catalog::refresh_runtime_model_catalogs,
            command_guards::get_agent_sandbox_root,
            worktree_config::get_agent_worktree_config,
            worktree_config::save_agent_worktree_config,
            provider_skills::list_provider_skills,
            git_workspace::check_local_environment,
            git_workspace::attach_workspace,
            git_workspace::init_git_repo,
            git_workspace::commit_uncommitted,
            git_workspace::create_base_branch,
            git_workspace::preview_agent_worktree,
            git_workspace::checkout_commit_detached,
            git_workspace::target_branch_checkout_status,
            git_workspace::diff_commits,
            git_workspace::diff_file_between_commits,
            git_workspace::show_file_at_commit,
            git_workspace::list_files_at_commit,
            git_workspace::merge_preview,
            merge_review::start_merge_review,
            merge_review::synthesize_merge_resolutions,
            merge_review::stop_merge_review,
            merge_review::is_merge_review_running,
            git_workspace::git_merge_apply,
            git_workspace::git_compute_blame,
            git_workspace::create_branch_pointer,
            git_workspace::delete_branch_pointer,
            git_workspace::move_branch_pointer,
            git_workspace::update_git_ref,
            git_workspace::list_branch_pointers,
            git_workspace::list_local_refs,
            git_workspace::snapshot_git_refs,
            git_workspace::resolve_ref_tip,
            git_workspace::resolve_current_branch_ref,
            git_workspace::list_missing_commits,
            git_workspace::read_commit_metadata,
            git_workspace::list_addable_commit_candidates,
            git_workspace::list_addable_commit_range,
            git_workspace::list_all_commits,
            terminal::create_terminal_session,
            terminal::write_terminal_session,
            terminal::resize_terminal_session,
            terminal::acknowledge_terminal_output,
            terminal::close_terminal_session,
            editors::get_available_editors,
            mcp::set_mcp_auth_token,
            mcp::set_mcp_workspace_id,
            mcp::get_mcp_server_url,
            composer_attachments::save_composer_attachment,
            auth_callback::ensure_auth_callback_server_started,
            auth_callback::get_auth_callback_base_url,
            auth_callback::save_agentree_cloud_session,
            auth_callback::read_agentree_cloud_session,
            auth_callback::clear_agentree_cloud_session,
            graph_snapshot_cache::read_graph_snapshot_cache,
            graph_snapshot_cache::write_graph_snapshot_cache,
            graph_snapshot_cache::delete_graph_snapshot_cache,
        ])
}

#[cfg(test)]
fn export_specta_bindings(builder: &SpectaBuilder<tauri::Wry>) {
    let bindings_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/tauri-bindings.ts");
    if let Some(parent) = bindings_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create Tauri Specta bindings directory");
    }
    builder
        .export(Typescript::default(), &bindings_path)
        .expect("failed to export Tauri Specta bindings");

    let generated = std::fs::read_to_string(&bindings_path)
        .expect("failed to read generated Tauri Specta bindings");
    let normalized = normalize_generated_typescript(&generated);
    if normalized != generated {
        std::fs::write(&bindings_path, normalized)
            .expect("failed to normalize generated Tauri Specta bindings");
    }
}

#[cfg(test)]
fn normalize_generated_typescript(generated: &str) -> String {
    let mut normalized = generated
        .trim_end_matches(|character| character == '\r' || character == '\n')
        .to_owned();
    normalized.push('\n');
    normalized
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = specta_builder();

    let mut builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(macos_menu_without_close_window);
    }

    // Must be registered before any other plugin: a second launch of the *same*
    // build is folded into the already-running instance instead of starting a
    // colliding process that shares the data dir, SQLite DBs and the MCP port.
    // Dev and release use different identifiers (see tauri.dev.conf.json), so
    // they are distinct apps and still run side by side.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("agentree-auth-callback-navigation-guard")
                .on_navigation(|webview, url| {
                    if auth_callback::is_auth_callback_url(url) {
                        crate::app_log!(
                            "[Auth] Intercepted main webview Kinde callback navigation: {}",
                            url
                        );
                        if let Err(error) = webview.emit("kinde-auth-callback", url.as_str()) {
                            crate::app_log!(
                                "[Auth] Failed to emit intercepted Kinde callback event: {}",
                                error
                            );
                        }
                        return false;
                    }
                    true
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(debug_assertions)]
    {
        // The plugin derives its socket from the merged Tauri identifier and
        // safely probes/removes stale sockets before binding. Worktree dev apps
        // therefore keep independent Pilot endpoints without a global preflight.
        builder = builder.plugin(tauri_plugin_pilot::init());
    }

    builder
        .manage(AgentState::new())
        .manage(MergeReviewState::default())
        .manage(terminal::TerminalState::new())
        .setup({
            let specta_builder = specta_builder.clone();
            move |app| {
                let start = std::time::Instant::now();
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    app.deep_link().register_all()?;
                }
                #[cfg(desktop)]
                {
                    let mut updater_builder = tauri_plugin_updater::Builder::new();
                    if let Ok(pubkey) = std::env::var("TAURI_UPDATER_PUBKEY") {
                        let trimmed = pubkey.trim();
                        if !trimmed.is_empty() {
                            updater_builder = updater_builder.pubkey(trimmed.to_string());
                        }
                    }
                    app.handle().plugin(updater_builder.build())?;
                }
                let paths = logging::init_logging(&app.handle().clone())?;
                crate::app_log!("[Setup] Starting Tauri setup");
                crate::app_log!(
                    "[Setup] File logs: frontend={} backend={}",
                    paths.frontend_log,
                    paths.backend_log
                );
                metric_kit::start_metric_kit(app.handle().clone());

                let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                #[cfg(debug_assertions)]
                if let Some(source_db_path) = std::env::var_os("AGENTREE_DEV_BOOTSTRAP_SOURCE_DB") {
                    let source_db_path = std::path::PathBuf::from(source_db_path);
                    match TelemetryDb::bootstrap_dev_worktree(&source_db_path, &app_data_dir)? {
                        db::DevWorktreeBootstrapOutcome::Cloned => crate::app_log!(
                            "[Setup] Initialized worktree data from the normal dev app"
                        ),
                        db::DevWorktreeBootstrapOutcome::SkippedExistingWorkspaces => {
                            crate::app_log!(
                                "[Setup] Kept existing worktree data because it already has workspaces"
                            )
                        }
                        db::DevWorktreeBootstrapOutcome::SkippedMissingSource => crate::app_log!(
                            "[Setup] Normal dev data was not found; starting with empty worktree data"
                        ),
                        db::DevWorktreeBootstrapOutcome::SkippedEmptySource => crate::app_log!(
                            "[Setup] Normal dev data has no workspaces; starting with empty worktree data"
                        ),
                    }
                }
                let telemetry = TelemetryDb::open(&app_data_dir)?;
                app.manage(telemetry);
                {
                    let recovered_terminal_runs =
                        agents::recover_terminal_agent_runs_from_journal(app.handle())?;
                    if recovered_terminal_runs > 0 {
                        crate::app_log!(
                            "[AGENT_RECOVERY] event=startup_terminal_journal_replay.recovered count={}",
                            recovered_terminal_runs
                        );
                    }
                    let resumed_interrupted_runs =
                        agents::resume_interrupted_agent_runs_on_startup(app.handle())?;
                    if resumed_interrupted_runs > 0 {
                        crate::app_log!(
                            "[AGENT_RECOVERY] event=startup_provider_resume.resumed count={}",
                            resumed_interrupted_runs
                        );
                    }

                    let telemetry = app.state::<TelemetryDb>();
                    let reconciled_stale_runs = telemetry.reconcile_agent_runs_on_startup()?;
                    if reconciled_stale_runs > 0 {
                        crate::app_log!(
                            "[AGENT_RECOVERY] event=startup_reconcile classified_needs_user_action count={}",
                            reconciled_stale_runs
                        );
                    }
                    let reconciled_prelaunch_local_nodes =
                        telemetry.reconcile_stale_prelaunch_local_nodes(60, "startup")?;
                    if reconciled_prelaunch_local_nodes > 0 {
                        crate::app_log!(
                            "[AGENT_RECOVERY] event=startup_reconcile.prelaunch_local_failed_setup count={}",
                            reconciled_prelaunch_local_nodes
                        );
                    }
                    let repaired_legacy_local_timelines =
                        telemetry.repair_legacy_local_node_timelines(100)?;
                    if repaired_legacy_local_timelines > 0 {
                        crate::app_log!(
                            "[AGENT_RECOVERY] event=startup_reconcile.legacy_local_timelines count={}",
                            repaired_legacy_local_timelines
                        );
                    }
                    // Reclaim scratch worktrees/branches left behind by runs that are
                    // no longer live (crashes, force-quits, skipped cleanup). Runs that
                    // reconcile_agent_runs_on_startup just reclassified are now dead, so
                    // this must come after it; the clean-worktree guard preserves any
                    // run that crashed mid-edit with unsaved work.
                    match telemetry.list_agent_run_repo_paths() {
                        Ok(repos) => {
                            let mut reclaimed_total = 0usize;
                            for repo in repos {
                                match crate::git_workspace::reconcile_orphaned_agent_worktrees(
                                    &repo, &telemetry,
                                ) {
                                    Ok(count) => reclaimed_total += count,
                                    Err(err) => crate::app_log!(
                                        "[AGENT_WORKTREE] event=startup_reconcile.error repo={} err={}",
                                        repo,
                                        err
                                    ),
                                }
                            }
                            if reclaimed_total > 0 {
                                crate::app_log!(
                                    "[AGENT_WORKTREE] event=startup_reconcile.reclaimed count={}",
                                    reclaimed_total
                                );
                            }
                        }
                        Err(err) => crate::app_log!(
                            "[AGENT_WORKTREE] event=startup_reconcile.list_repos_error err={}",
                            err
                        ),
                    }

                    let reconciled_stale_logins =
                        login_profiles::reconcile_login_profiles_on_startup(&telemetry)?;
                    if reconciled_stale_logins > 0 {
                        crate::app_log!(
                            "[LOGIN_PROFILE] event=startup_reconcile reset_orphaned_checking count={}",
                            reconciled_stale_logins
                        );
                    }
                }
                agents::start_agent_run_watchdog(app.handle().clone());
                runtime_model_catalog::start_background_refresh(app.handle().clone());

                crate::app_log!("[PERF][Setup] Starting MCP server...");
                mcp::start_mcp_server(app.handle().clone());
                agent_launch::start_agent_launch_recovery(app.handle().clone());
                crate::app_log!(
                    "[PERF][Setup] MCP server started, total setup time: {:?}",
                    start.elapsed()
                );
                specta_builder.mount_events(app);
                Ok(())
            }
        })
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "run `pnpm run bindings:tauri` explicitly"]
    fn export_tauri_specta_bindings() {
        export_specta_bindings(&specta_builder());
    }

    #[test]
    fn generated_typescript_has_one_trailing_newline() {
        assert_eq!(
            normalize_generated_typescript("export type Example = {};\n\n"),
            "export type Example = {};\n"
        );
        assert_eq!(
            normalize_generated_typescript("export type Example = {};\r\n"),
            "export type Example = {};\n"
        );
        assert_eq!(
            normalize_generated_typescript("export type Example = {};"),
            "export type Example = {};\n"
        );
    }
}

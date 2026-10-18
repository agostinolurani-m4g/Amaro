mod ble;
mod commands;
mod session;
mod state;
mod storage;
mod storage_commands;
mod strava;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let ble = state.ble.clone();
            tauri::async_runtime::spawn(async move {
                let mut manager = ble.lock().await;
                manager.set_app_handle(handle.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_scan,
            commands::stop_scan,
            commands::connect_trainer,
            commands::disconnect_trainer,
            commands::set_control_mode,
            commands::set_target_power,
            commands::start_session,
            commands::pause_session,
            commands::resume_session,
            commands::end_session,
            commands::get_session_status,
            commands::get_last_session_samples,
            commands::export_fit,
            storage_commands::get_profile,
            storage_commands::save_profile_cmd,
            storage_commands::get_auth,
            storage_commands::save_auth_cmd,
            storage_commands::clear_auth_cmd,
            storage_commands::list_workouts,
            storage_commands::save_workout,
            storage_commands::delete_workout,
            storage_commands::get_personal_records,
            storage_commands::save_personal_records_cmd,
            storage_commands::list_calendar,
            storage_commands::save_calendar_entry,
            storage_commands::delete_calendar_entry,
            storage_commands::get_doc,
            storage_commands::save_doc_cmd,
            storage_commands::import_activity_file,
            storage_commands::import_activity_from_path,
            strava::commands::strava_get_status,
            strava::commands::strava_set_auto_upload,
            strava::commands::strava_last_session_fit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

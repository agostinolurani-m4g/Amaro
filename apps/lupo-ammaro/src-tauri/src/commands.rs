use crate::session::recorder::SessionStatus;
use crate::session::{ControlMode, SessionSummary, SimulationParams};
use crate::state::AppState;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn start_scan(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let mut ble = state.ble.lock().await;
    ble.set_app_handle(app);
    ble.start_scan().await
}

#[tauri::command]
pub async fn stop_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.ble.lock().await.stop_scan().await;
    Ok(())
}

#[tauri::command]
pub async fn connect_trainer(
    state: State<'_, AppState>,
    app: AppHandle,
    device_id: String,
) -> Result<(), String> {
    let mut ble = state.ble.lock().await;
    ble.set_app_handle(app);
    ble.connect(device_id).await
}

#[tauri::command]
pub async fn disconnect_trainer(state: State<'_, AppState>) -> Result<(), String> {
    state.ble.lock().await.disconnect().await
}

#[tauri::command]
pub async fn set_control_mode(
    state: State<'_, AppState>,
    mode: ControlMode,
    target_power: Option<u16>,
    resistance: Option<f64>,
    simulation: Option<SimulationParams>,
) -> Result<(), String> {
    let mut ble = state.ble.lock().await;
    match mode {
        ControlMode::Erg => {
            let watts = target_power.unwrap_or(150);
            ble.set_target_power(watts).await?;
            let mut recorder = state.recorder.lock().await;
            recorder.set_target_power(watts);
        }
        ControlMode::Resistance => {
            ble.set_resistance(resistance.unwrap_or(50.0)).await?;
        }
        ControlMode::Sim => {
            let sim = simulation.unwrap_or(SimulationParams {
                grade_percent: 0.0,
                wind_speed_ms: 0.0,
            });
            ble.set_simulation(sim.grade_percent, sim.wind_speed_ms)
                .await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_target_power(state: State<'_, AppState>, watts: u16) -> Result<(), String> {
    state.ble.lock().await.set_target_power(watts).await?;
    state.recorder.lock().await.set_target_power(watts);
    Ok(())
}

#[tauri::command]
pub async fn start_session(state: State<'_, AppState>) -> Result<(), String> {
    if !state.ble.lock().await.is_connected() {
        return Err("Connect a trainer before starting".into());
    }
    state.recorder.lock().await.start();
    Ok(())
}

#[tauri::command]
pub async fn pause_session(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.lock().await.pause();
    Ok(())
}

#[tauri::command]
pub async fn resume_session(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.lock().await.resume();
    Ok(())
}

#[tauri::command]
pub async fn end_session(state: State<'_, AppState>) -> Result<SessionSummary, String> {
    Ok(state.recorder.lock().await.end())
}

#[tauri::command]
pub async fn get_session_status(state: State<'_, AppState>) -> Result<String, String> {
    let status = state.recorder.lock().await.status();
    Ok(match status {
        SessionStatus::Idle => "idle",
        SessionStatus::Active => "active",
        SessionStatus::Paused => "paused",
    }
    .to_string())
}

#[tauri::command]
pub async fn get_last_session_samples(
    state: State<'_, AppState>,
) -> Result<Vec<crate::session::SessionSample>, String> {
    let recorder = state.recorder.lock().await;
    Ok(recorder
        .last_session()
        .map(|s| s.samples.clone())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn export_fit(state: State<'_, AppState>, app: AppHandle) -> Result<Option<String>, String> {
    let recorder = state.recorder.lock().await;
    let last = recorder
        .last_session()
        .ok_or_else(|| "No session to export".to_string())?;
    let started_at = last.started_at;
    let samples = last.samples.clone();
    drop(recorder);

    if samples.is_empty() {
        return Err("Session has no recorded samples".into());
    }

    let default_name = format!(
        "wattlab_{}.fit",
        started_at.format("%Y%m%d_%H%M%S")
    );

    let path = app
        .dialog()
        .file()
        .set_title("Save FIT activity")
        .set_file_name(&default_name)
        .add_filter("FIT Activity", &["fit"])
        .blocking_save_file();

    let Some(file_path) = path else {
        return Ok(None);
    };

    let path_str = file_path.to_string();
    crate::session::fit_writer::write_activity_fit(&path_str, started_at, &samples)
        .map_err(|e| format!("FIT export failed: {e}"))?;

    Ok(Some(path_str))
}

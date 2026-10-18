use super::store::{load_strava_config, save_strava_config};
use crate::session::fit_writer::build_activity_fit;
use crate::state::AppState;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StravaStatus {
    pub auto_upload: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StravaFitPayload {
    pub fit_base64: String,
    pub name: String,
}

#[tauri::command]
pub fn strava_get_status() -> Result<StravaStatus, String> {
    let config = load_strava_config()?;
    Ok(StravaStatus {
        auto_upload: config.auto_upload,
    })
}

#[tauri::command]
pub fn strava_set_auto_upload(enabled: bool) -> Result<StravaStatus, String> {
    let mut config = load_strava_config()?;
    config.auto_upload = enabled;
    save_strava_config(&config)?;
    Ok(StravaStatus {
        auto_upload: config.auto_upload,
    })
}

#[tauri::command]
pub async fn strava_last_session_fit(
    state: State<'_, AppState>,
) -> Result<StravaFitPayload, String> {
    let recorder = state.recorder.lock().await;
    let last = recorder
        .last_session()
        .ok_or_else(|| "Nessuna sessione da caricare".to_string())?;
    let started_at = last.started_at;
    let samples = last.samples.clone();
    drop(recorder);

    if samples.is_empty() {
        return Err("La sessione non ha campioni registrati".into());
    }

    let fit_bytes = build_activity_fit(started_at, &samples);
    Ok(StravaFitPayload {
        fit_base64: STANDARD.encode(fit_bytes),
        name: format!("WattLab {}", started_at.format("%Y-%m-%d %H:%M")),
    })
}

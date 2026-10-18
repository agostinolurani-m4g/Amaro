use crate::storage::store::data_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn default_auto_upload() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StravaConfig {
    #[serde(default = "default_auto_upload")]
    pub auto_upload: bool,
}

impl Default for StravaConfig {
    fn default() -> Self {
        Self { auto_upload: false }
    }
}

fn strava_path() -> Result<PathBuf, String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Create data dir failed: {e}"))?;
    Ok(dir.join("strava.json"))
}

pub fn load_strava_config() -> Result<StravaConfig, String> {
    let path = strava_path()?;
    if !path.exists() {
        return Ok(StravaConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Read strava.json failed: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Parse strava.json failed: {e}"))
}

pub fn save_strava_config(config: &StravaConfig) -> Result<(), String> {
    let path = strava_path()?;
    let raw =
        serde_json::to_string_pretty(config).map_err(|e| format!("Serialize strava.json failed: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("Write strava.json failed: {e}"))
}

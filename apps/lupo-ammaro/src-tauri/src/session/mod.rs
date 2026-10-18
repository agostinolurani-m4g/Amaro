use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySample {
    pub timestamp_ms: i64,
    pub power: Option<u16>,
    pub cadence: Option<f64>,
    pub speed_kmh: Option<f64>,
    pub heart_rate: Option<u8>,
    pub target_power: Option<u16>,
    pub resistance: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSample {
    pub timestamp_ms: i64,
    pub power: Option<u16>,
    pub cadence: Option<f64>,
    pub speed_kmh: Option<f64>,
    pub heart_rate: Option<u8>,
    pub target_power: Option<u16>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_secs: u64,
    pub avg_power: Option<u16>,
    pub max_power: Option<u16>,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlMode {
    Erg,
    Resistance,
    Sim,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationParams {
    pub grade_percent: f64,
    pub wind_speed_ms: f64,
}

pub mod recorder;
pub mod fit_writer;

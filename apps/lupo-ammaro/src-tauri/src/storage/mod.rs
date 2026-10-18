use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LactateTestPoint {
    pub watts: u16,
    pub mmol: f64,
    #[serde(default)]
    pub hr: Option<u16>,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub name: String,
    pub height_cm: u16,
    pub weight_kg: f64,
    pub ftp_watts: u16,
    #[serde(default)]
    pub sex: Option<String>,
    #[serde(default)]
    pub birth_year: Option<u16>,
    #[serde(default)]
    pub hr_max: Option<u16>,
    #[serde(default)]
    pub hr_rest: Option<u16>,
    #[serde(default)]
    pub lthr: Option<u16>,
    #[serde(default)]
    pub lthr_run: Option<u16>,
    #[serde(default)]
    pub lactate_tests: Vec<LactateTestPoint>,
}

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            name: String::new(),
            height_cm: 175,
            weight_kg: 70.0,
            ftp_watts: 200,
            sex: None,
            birth_year: None,
            hr_max: None,
            hr_rest: None,
            lthr: None,
            lthr_run: None,
            lactate_tests: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutStep {
    pub id: String,
    pub kind: String,
    pub duration_secs: u32,
    pub target_pct_ftp: u16,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub grade_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutRepeat {
    pub id: String,
    pub count: u32,
    pub steps: Vec<WorkoutStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkoutBlock {
    #[serde(rename = "step", rename_all = "camelCase")]
    Step {
        id: String,
        kind: String,
        duration_secs: u32,
        target_pct_ftp: u16,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        grade_percent: Option<f64>,
    },
    #[serde(rename = "ramp", rename_all = "camelCase")]
    Ramp {
        id: String,
        duration_secs: u32,
        target_pct_ftp: u16,
        target_end_pct_ftp: u16,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        grade_percent: Option<f64>,
        #[serde(default)]
        grade_end_percent: Option<f64>,
    },
    #[serde(rename = "repeat", rename_all = "camelCase")]
    Repeat {
        id: String,
        count: u32,
        steps: Vec<WorkoutStep>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workout {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub blocks: Vec<WorkoutBlock>,
    #[serde(default)]
    pub steps: Vec<WorkoutStep>,
    #[serde(default)]
    pub repeats: Vec<WorkoutRepeat>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub climb_profile_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSeriesPoint {
    pub t: u64,
    #[serde(default)]
    pub power: Option<u16>,
    #[serde(default)]
    pub hr: Option<u8>,
    #[serde(default)]
    pub cadence: Option<u16>,
    #[serde(default)]
    pub target: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEntry {
    pub id: String,
    pub date: String,
    pub entry_type: String,
    pub title: String,
    #[serde(default)]
    pub workout_id: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<u64>,
    #[serde(default)]
    pub avg_power: Option<u16>,
    #[serde(default)]
    pub import_path: Option<String>,
    #[serde(default)]
    pub import_format: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub coach_comment: Option<String>,
    #[serde(default)]
    pub series: Option<Vec<SessionSeriesPoint>>,
    #[serde(default)]
    pub max_power: Option<u16>,
    #[serde(default)]
    pub np: Option<u16>,
    #[serde(default)]
    pub tss: Option<f64>,
    #[serde(default)]
    pub ifactor: Option<f64>,
    #[serde(default)]
    pub kj: Option<f64>,
    #[serde(default)]
    pub avg_hr: Option<u16>,
    #[serde(default)]
    pub max_hr: Option<u16>,
    #[serde(default)]
    pub avg_cadence: Option<u16>,
    #[serde(default)]
    pub distance_m: Option<f64>,
    #[serde(default)]
    pub decoupling: Option<f64>,
    /// Mean-max power per finestra (allineata a MMP_WINDOWS del motore)
    #[serde(default)]
    pub mmp: Option<Vec<u16>>,
    #[serde(default)]
    pub zone_secs: Option<Vec<u32>>,
    #[serde(default)]
    pub rpe: Option<u8>,
    #[serde(default)]
    pub feel: Option<String>,
    #[serde(default)]
    pub planned_tss: Option<f64>,
    #[serde(default)]
    pub planned_entry_id: Option<String>,
    #[serde(default)]
    pub compliance: Option<f64>,
    #[serde(default)]
    pub session_type: Option<String>,
    #[serde(default)]
    pub coach_plan: Option<bool>,
    #[serde(default)]
    pub sport: Option<String>,
    #[serde(default)]
    pub external_source: Option<String>,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub elevation_m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AmaroMember {
    pub id: u32,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub membership_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    pub expires_at: String,
    pub member: AmaroMember,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalBest {
    pub watts: u16,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersonalRecords {
    #[serde(default)]
    pub bests: HashMap<String, PersonalBest>,
    #[serde(default)]
    pub max_duration_secs: u64,
    #[serde(default)]
    pub max_distance_m: f64,
    #[serde(default)]
    pub max_work_kj: f64,
    #[serde(default)]
    pub max_power: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedActivity {
    pub title: String,
    pub date: String,
    pub duration_secs: u64,
    pub avg_power: Option<u16>,
    pub max_power: Option<u16>,
    pub distance_m: Option<f64>,
    pub format: String,
    pub source_path: String,
    #[serde(default)]
    pub avg_hr: Option<u16>,
    #[serde(default)]
    pub max_hr: Option<u16>,
    /// Serie a 1 Hz (t in secondi dall'inizio)
    #[serde(default)]
    pub series: Vec<SessionSeriesPoint>,
}

pub mod store;

pub use store::{
    clear_auth, import_fit, import_gpx, load_auth, load_calendar, load_doc, load_personal_records,
    load_profile, load_workouts, save_auth, save_calendar, save_doc, save_personal_records,
    save_profile, save_workouts,
};

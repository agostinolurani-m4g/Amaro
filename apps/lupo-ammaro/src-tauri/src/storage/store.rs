use super::{
    AuthSession, CalendarEntry, ImportedActivity, PersonalRecords, SessionSeriesPoint,
    UserProfile, Workout,
};
use chrono::Utc;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::fs;
use std::path::{Path, PathBuf};

pub fn data_dir() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("WATTLAB_DATA_DIR") {
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    dirs::data_dir()
        .map(|d| d.join("wattlab"))
        .ok_or_else(|| "Cannot resolve app data directory".to_string())
}

fn ensure_data_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Create data dir failed: {e}"))?;
    Ok(dir)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Err("__missing__".into());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Read {} failed: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("Parse {} failed: {e}", path.display()))
}

fn read_json_or<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match read_json::<T>(path) {
        Ok(v) => Ok(v),
        Err(e) if e == "__missing__" => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("Serialize failed: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("Write {} failed: {e}", path.display()))
}

pub fn load_profile() -> Result<UserProfile, String> {
    let dir = ensure_data_dir()?;
    read_json_or(&dir.join("profile.json"))
}

pub fn save_profile(profile: &UserProfile) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    write_json(&dir.join("profile.json"), profile)
}

pub fn load_auth() -> Result<Option<AuthSession>, String> {
    let dir = ensure_data_dir()?;
    match read_json::<AuthSession>(&dir.join("auth.json")) {
        Ok(session) => Ok(Some(session)),
        Err(e) if e == "__missing__" => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn save_auth(session: &AuthSession) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    write_json(&dir.join("auth.json"), session)
}

pub fn clear_auth() -> Result<(), String> {
    let dir = ensure_data_dir()?;
    let path = dir.join("auth.json");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Remove auth failed: {e}"))?;
    }
    Ok(())
}

pub fn load_workouts() -> Result<Vec<Workout>, String> {
    let dir = ensure_data_dir()?;
    read_json_or(&dir.join("workouts.json"))
}

pub fn save_workouts(workouts: &[Workout]) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    write_json(&dir.join("workouts.json"), &workouts.to_vec())
}

pub fn load_personal_records() -> Result<PersonalRecords, String> {
    let dir = ensure_data_dir()?;
    read_json_or(&dir.join("personal_records.json"))
}

pub fn save_personal_records(records: &PersonalRecords) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    write_json(&dir.join("personal_records.json"), records)
}

pub fn load_calendar() -> Result<Vec<CalendarEntry>, String> {
    let dir = ensure_data_dir()?;
    read_json_or(&dir.join("calendar.json"))
}

pub fn save_calendar(entries: &[CalendarEntry]) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    write_json(&dir.join("calendar.json"), &entries.to_vec())
}

fn is_valid_doc_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

pub fn load_doc(name: &str) -> Result<Option<serde_json::Value>, String> {
    if !is_valid_doc_name(name) {
        return Err(format!("Nome documento non valido: {name}"));
    }
    let dir = ensure_data_dir()?.join("docs");
    match read_json::<serde_json::Value>(&dir.join(format!("{name}.json"))) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e == "__missing__" => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn save_doc(name: &str, value: &serde_json::Value) -> Result<(), String> {
    if !is_valid_doc_name(name) {
        return Err(format!("Nome documento non valido: {name}"));
    }
    let dir = ensure_data_dir()?.join("docs");
    fs::create_dir_all(&dir).map_err(|e| format!("Create docs dir failed: {e}"))?;
    write_json(&dir.join(format!("{name}.json")), value)
}

fn fit_value_f64(value: &fitparser::Value) -> Option<f64> {
    use fitparser::Value;
    match value {
        Value::Float32(v) => Some(*v as f64),
        Value::Float64(v) => Some(*v),
        Value::UInt8(v) | Value::UInt8z(v) | Value::Byte(v) => Some(*v as f64),
        Value::UInt16(v) | Value::UInt16z(v) => Some(*v as f64),
        Value::UInt32(v) | Value::UInt32z(v) => Some(*v as f64),
        Value::UInt64(v) | Value::UInt64z(v) => Some(*v as f64),
        Value::SInt8(v) => Some(*v as f64),
        Value::SInt16(v) => Some(*v as f64),
        Value::SInt32(v) => Some(*v as f64),
        Value::SInt64(v) => Some(*v as f64),
        _ => None,
    }
}

#[derive(Default, Clone, Copy)]
struct FitRecord {
    ts: i64,
    power: Option<f64>,
    hr: Option<f64>,
    cadence: Option<f64>,
    distance: Option<f64>,
}

pub fn import_fit(path: &str) -> Result<ImportedActivity, String> {
    use fitparser::from_reader;
    use fitparser::profile::MesgNum;

    let mut file = fs::File::open(path).map_err(|e| format!("Open FIT failed: {e}"))?;
    let data = from_reader(&mut file).map_err(|e| format!("Parse FIT failed: {e}"))?;

    let mut duration_secs = 0u64;
    let mut avg_power = None;
    let mut max_power = None;
    let mut avg_hr = None;
    let mut max_hr = None;
    let mut session_distance = None;
    let mut start_time: Option<chrono::DateTime<Utc>> = None;
    let mut records: Vec<FitRecord> = Vec::new();

    for msg in data {
        match msg.kind() {
            MesgNum::Session => {
                for field in msg.fields() {
                    let num = fit_value_f64(field.value());
                    match field.name() {
                        "total_elapsed_time" | "total_timer_time" => {
                            if let Some(v) = num {
                                if duration_secs == 0 || field.name() == "total_elapsed_time" {
                                    duration_secs = v.round() as u64;
                                }
                            }
                        }
                        "avg_power" => avg_power = num.map(|v| v.round() as u16),
                        "max_power" => max_power = num.map(|v| v.round() as u16),
                        "avg_heart_rate" => avg_hr = num.map(|v| v.round() as u16),
                        "max_heart_rate" => max_hr = num.map(|v| v.round() as u16),
                        "total_distance" => session_distance = num,
                        "start_time" => {
                            if let fitparser::Value::Timestamp(ts) = field.value() {
                                start_time = Some(ts.with_timezone(&Utc));
                            }
                        }
                        _ => {}
                    }
                }
            }
            MesgNum::Record => {
                let mut rec = FitRecord::default();
                let mut has_ts = false;
                for field in msg.fields() {
                    match field.name() {
                        "timestamp" => {
                            if let fitparser::Value::Timestamp(ts) = field.value() {
                                rec.ts = ts.timestamp();
                                has_ts = true;
                            }
                        }
                        "power" => rec.power = fit_value_f64(field.value()),
                        "heart_rate" => rec.hr = fit_value_f64(field.value()),
                        "cadence" => rec.cadence = fit_value_f64(field.value()),
                        "distance" => rec.distance = fit_value_f64(field.value()),
                        _ => {}
                    }
                }
                if has_ts {
                    records.push(rec);
                }
            }
            _ => {}
        }
    }

    records.sort_by_key(|r| r.ts);
    let mut series: Vec<SessionSeriesPoint> = Vec::new();
    if let Some(first) = records.first() {
        let t0 = first.ts;
        if start_time.is_none() {
            start_time = chrono::DateTime::<Utc>::from_timestamp(t0, 0);
        }
        let mut last_t: i64 = -1;
        for r in &records {
            let t = r.ts - t0;
            if t <= last_t || t < 0 {
                continue;
            }
            last_t = t;
            series.push(SessionSeriesPoint {
                t: t as u64,
                power: r.power.map(|v| v.clamp(0.0, 3000.0).round() as u16),
                hr: r.hr.map(|v| v.clamp(0.0, 255.0).round() as u8),
                cadence: r.cadence.map(|v| v.clamp(0.0, 250.0).round() as u16),
                target: None,
            });
        }
        if duration_secs == 0 {
            duration_secs = last_t.max(0) as u64;
        }
    }

    if avg_power.is_none() {
        let powered: Vec<u16> = series.iter().filter_map(|p| p.power).collect();
        if !powered.is_empty() {
            let sum: u64 = powered.iter().map(|&w| w as u64).sum();
            avg_power = Some((sum / powered.len() as u64) as u16);
            max_power = powered.iter().copied().max();
        }
    }

    let distance_m = session_distance.or_else(|| records.iter().rev().find_map(|r| r.distance));

    let file_name = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported ride");

    Ok(ImportedActivity {
        title: file_name.to_string(),
        date: start_time
            .unwrap_or_else(Utc::now)
            .format("%Y-%m-%d")
            .to_string(),
        duration_secs,
        avg_power,
        max_power,
        distance_m: distance_m.filter(|d| *d > 0.0),
        format: "fit".to_string(),
        source_path: path.to_string(),
        avg_hr,
        max_hr,
        series,
    })
}

pub fn import_gpx(path: &str) -> Result<ImportedActivity, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("Open GPX failed: {e}"))?;
    let mut reader = Reader::from_str(&raw);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut points = 0u64;
    let mut first_time: Option<String> = None;
    let mut last_time: Option<String> = None;
    let mut distance_m = 0.0f64;
    let mut prev_lat: Option<f64> = None;
    let mut prev_lon: Option<f64> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().as_ref() == b"trkpt" {
                    points += 1;
                    let lat = e
                        .attributes()
                        .filter_map(|a| a.ok())
                        .find(|a| a.key.as_ref() == b"lat")
                        .and_then(|a| String::from_utf8(a.value.into_owned()).ok())
                        .and_then(|s| s.parse().ok());
                    let lon = e
                        .attributes()
                        .filter_map(|a| a.ok())
                        .find(|a| a.key.as_ref() == b"lon")
                        .and_then(|a| String::from_utf8(a.value.into_owned()).ok())
                        .and_then(|s| s.parse().ok());

                    if let (Some(lat), Some(lon), Some(pl), Some(pn)) = (lat, lon, prev_lat, prev_lon)
                    {
                        distance_m += haversine_m(pl, pn, lat, lon);
                    }
                    prev_lat = lat;
                    prev_lon = lon;
                }
            }
            Ok(Event::Text(e)) => {
                let text = e.unescape().unwrap_or_default().into_owned();
                if text.contains('T') && first_time.is_none() {
                    first_time = Some(text.clone());
                }
                if text.contains('T') {
                    last_time = Some(text);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Parse GPX failed: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let duration_secs = match (first_time.as_ref(), last_time.as_ref()) {
        (Some(a), Some(b)) => {
            let start = chrono::DateTime::parse_from_rfc3339(a)
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(a, "%Y-%m-%dT%H:%M:%SZ").map(|d| d.and_utc().fixed_offset()))
                .ok();
            let end = chrono::DateTime::parse_from_rfc3339(b)
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(b, "%Y-%m-%dT%H:%M:%SZ").map(|d| d.and_utc().fixed_offset()))
                .ok();
            match (start, end) {
                (Some(s), Some(e)) => (e.timestamp() - s.timestamp()).max(0) as u64,
                _ => points.saturating_mul(2),
            }
        }
        _ => points.saturating_mul(2),
    };

    let date = first_time
        .as_deref()
        .and_then(|t| t.get(0..10))
        .unwrap_or(&Utc::now().format("%Y-%m-%d").to_string())
        .to_string();

    let file_name = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported ride");

    Ok(ImportedActivity {
        title: file_name.to_string(),
        date,
        duration_secs,
        avg_power: None,
        max_power: None,
        distance_m: if distance_m > 0.0 { Some(distance_m) } else { None },
        format: "gpx".to_string(),
        source_path: path.to_string(),
        avg_hr: None,
        max_hr: None,
        series: Vec::new(),
    })
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::{clear_auth, load_auth, save_auth};
    use crate::storage::{AmaroMember, AuthSession};

    fn sample_session() -> AuthSession {
        AuthSession {
            token: "test-token".to_string(),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
            member: AmaroMember {
                id: 1,
                email: "mario@test.it".to_string(),
                first_name: "Mario".to_string(),
                last_name: "Rossi".to_string(),
                membership_status: "active".to_string(),
            },
        }
    }

    #[test]
    fn auth_roundtrip_persists() {
        let dir = std::env::temp_dir().join(format!(
            "wattlab-auth-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");

        let auth_path = dir.join("auth.json");
        let original_data_dir = std::env::var("WATTLAB_DATA_DIR").ok();
        std::env::set_var("WATTLAB_DATA_DIR", dir.to_string_lossy().to_string());

        let session = sample_session();
        save_auth(&session).expect("save auth");
        let loaded = load_auth().expect("load auth").expect("auth present");
        assert_eq!(loaded.token, session.token);
        assert_eq!(loaded.member.email, session.member.email);

        clear_auth().expect("clear auth");
        assert!(load_auth().expect("load after clear").is_none());
        assert!(!auth_path.exists());

        if let Some(path) = original_data_dir {
            std::env::set_var("WATTLAB_DATA_DIR", path);
        } else {
            std::env::remove_var("WATTLAB_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

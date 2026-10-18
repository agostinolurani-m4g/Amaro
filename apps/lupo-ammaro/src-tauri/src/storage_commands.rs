use crate::storage::{
    clear_auth, import_gpx, import_fit, load_auth, load_calendar, load_doc, load_personal_records,
    load_profile, load_workouts, save_auth, save_calendar, save_doc, save_personal_records,
    save_profile, save_workouts, AuthSession, CalendarEntry, ImportedActivity, PersonalRecords,
    UserProfile, Workout,
};
use chrono::Utc;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[tauri::command]
pub fn get_profile() -> Result<UserProfile, String> {
    load_profile()
}

#[tauri::command]
pub fn save_profile_cmd(profile: UserProfile) -> Result<(), String> {
    save_profile(&profile)
}

#[tauri::command]
pub fn get_auth() -> Result<Option<AuthSession>, String> {
    load_auth()
}

#[tauri::command]
pub fn save_auth_cmd(session: AuthSession) -> Result<(), String> {
    save_auth(&session)
}

#[tauri::command]
pub fn clear_auth_cmd() -> Result<(), String> {
    clear_auth()
}

#[tauri::command]
pub fn list_workouts() -> Result<Vec<Workout>, String> {
    load_workouts()
}

#[tauri::command]
pub fn save_workout(workout: Workout) -> Result<Workout, String> {
    let mut workouts = load_workouts()?;
    let now = Utc::now();
    let saved = if workout.id.is_empty() {
        Workout {
            id: Uuid::new_v4().to_string(),
            created_at: now,
            updated_at: now,
            ..workout
        }
    } else {
        let mut w = workout;
        w.updated_at = now;
        if w.created_at.timestamp() == 0 {
            w.created_at = now;
        }
        w
    };

    if let Some(idx) = workouts.iter().position(|w| w.id == saved.id) {
        workouts[idx] = saved.clone();
    } else {
        workouts.push(saved.clone());
    }
    save_workouts(&workouts)?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_workout(id: String) -> Result<(), String> {
    let mut workouts = load_workouts()?;
    workouts.retain(|w| w.id != id);
    save_workouts(&workouts)
}

#[tauri::command]
pub fn get_personal_records() -> Result<PersonalRecords, String> {
    load_personal_records()
}

#[tauri::command]
pub fn save_personal_records_cmd(records: PersonalRecords) -> Result<(), String> {
    save_personal_records(&records)
}

#[tauri::command]
pub fn list_calendar() -> Result<Vec<CalendarEntry>, String> {
    load_calendar()
}

#[tauri::command]
pub fn save_calendar_entry(entry: CalendarEntry) -> Result<CalendarEntry, String> {
    let mut entries = load_calendar()?;
    let saved = if entry.id.is_empty() {
        CalendarEntry {
            id: Uuid::new_v4().to_string(),
            ..entry
        }
    } else {
        entry
    };

    if let Some(idx) = entries.iter().position(|e| e.id == saved.id) {
        entries[idx] = saved.clone();
    } else {
        entries.push(saved.clone());
    }
    save_calendar(&entries)?;
    Ok(saved)
}

#[tauri::command]
pub fn get_doc(name: String) -> Result<Option<serde_json::Value>, String> {
    load_doc(&name)
}

#[tauri::command]
pub fn save_doc_cmd(name: String, value: serde_json::Value) -> Result<(), String> {
    save_doc(&name, &value)
}

#[tauri::command]
pub fn delete_calendar_entry(id: String) -> Result<(), String> {
    let mut entries = load_calendar()?;
    entries.retain(|e| e.id != id);
    save_calendar(&entries)
}

fn import_activity_at_path(path: &str) -> Result<ImportedActivity, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".fit") {
        import_fit(path)
    } else if lower.ends_with(".gpx") {
        import_gpx(path)
    } else {
        Err("Formato non supportato. Usa .fit o .gpx".into())
    }
}

#[tauri::command]
pub fn import_activity_from_path(path: String) -> Result<ImportedActivity, String> {
    import_activity_at_path(&path)
}

#[tauri::command]
pub async fn import_activity_file(app: AppHandle) -> Result<Option<ImportedActivity>, String> {
    let path = app
        .dialog()
        .file()
        .set_title("Importa attività")
        .add_filter("Activity files", &["fit", "gpx"])
        .blocking_pick_file();

    let Some(file_path) = path else {
        return Ok(None);
    };

    Ok(Some(import_activity_at_path(&file_path.to_string())?))
}

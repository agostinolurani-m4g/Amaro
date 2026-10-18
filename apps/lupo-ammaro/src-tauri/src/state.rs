use crate::ble::manager::BleManager;
use crate::session::recorder::SessionRecorder;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AppState {
    pub ble: Arc<Mutex<BleManager>>,
    pub recorder: Arc<Mutex<SessionRecorder>>,
}

impl AppState {
    pub fn new() -> Self {
        let recorder = Arc::new(Mutex::new(SessionRecorder::new()));
        Self {
            ble: Arc::new(Mutex::new(BleManager::new(recorder.clone()))),
            recorder,
        }
    }
}

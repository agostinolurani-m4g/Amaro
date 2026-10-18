use crate::ble::ftms::{
    self, parse_control_response, parse_hr_measurement, parse_indoor_bike_data, FTMS_CONTROL_POINT,
    FTMS_SERVICE, HR_MEASUREMENT, INDOOR_BIKE_DATA,
};
use crate::session::recorder::SessionRecorder;
use crate::session::TelemetrySample;
use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, PeripheralProperties, ScanFilter,
    WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use log::{error, info, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResultPayload {
    pub id: String,
    pub name: String,
    pub has_ftms: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatePayload {
    pub status: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub error: Option<String>,
}

pub struct BleManager {
    manager: Option<Manager>,
    adapter: Option<Arc<Adapter>>,
    scan_task: Option<JoinHandle<()>>,
    notify_task: Option<JoinHandle<()>>,
    scan_generation: Arc<AtomicU64>,
    target_power_shared: Arc<Mutex<Option<u16>>>,
    connecting: bool,
    connected_id: Option<String>,
    connected_name: Option<String>,
    peripheral: Option<Arc<Peripheral>>,
    control_char: Option<Characteristic>,
    has_control: bool,
    target_power: Option<u16>,
    app_handle: Option<AppHandle>,
    stop_scan_notify: Arc<Notify>,
    recorder: Arc<Mutex<SessionRecorder>>,
    ble_serial: Arc<Mutex<()>>,
}

fn trainer_display_name(local_name: &Option<String>) -> Option<String> {
    let name = local_name.as_ref()?.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if matches!(
        lower.as_str(),
        "unknown" | "unknown trainer" | "(unknown)" | "n/a" | "unnamed"
    ) {
        return None;
    }
    Some(name.to_string())
}

fn looks_like_trainer_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "tacx", "wahoo", "elite", "kickr", "trainer", "flux", "neo", "hammer", "hype", "atom",
        "saris", "stages", "cycleops", "bkool", "thinkrider",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
}

fn scan_has_ftms(props: &PeripheralProperties, name: &str) -> bool {
    props.services.iter().any(|s| *s == FTMS_SERVICE) || looks_like_trainer_name(name)
}

impl BleManager {
    pub fn new(recorder: Arc<Mutex<SessionRecorder>>) -> Self {
        Self {
            manager: None,
            adapter: None,
            scan_task: None,
            notify_task: None,
            scan_generation: Arc::new(AtomicU64::new(0)),
            target_power_shared: Arc::new(Mutex::new(None)),
            connecting: false,
            connected_id: None,
            connected_name: None,
            peripheral: None,
            control_char: None,
            has_control: false,
            target_power: None,
            app_handle: None,
            stop_scan_notify: Arc::new(Notify::new()),
            recorder,
            ble_serial: Arc::new(Mutex::new(())),
        }
    }

    pub fn set_app_handle(&mut self, app: AppHandle) {
        self.app_handle = Some(app);
    }

    pub fn is_connected(&self) -> bool {
        self.connected_id.is_some()
    }

    fn emit_connection_state(&self, status: &str, error: Option<String>) {
        if let Some(app) = &self.app_handle {
            if let Err(e) = app.emit(
                "connection-state",
                ConnectionStatePayload {
                    status: status.to_string(),
                    device_id: self.connected_id.clone(),
                    device_name: self.connected_name.clone(),
                    error,
                },
            ) {
                error!("emit connection-state failed: {e}");
            }
        }
    }

    async fn ensure_manager(&mut self) -> Result<(), String> {
        if self.manager.is_none() {
            self.manager = Some(
                Manager::new()
                    .await
                    .map_err(|e| format!("BLE manager init failed: {e}"))?,
            );
        }
        Ok(())
    }

    async fn adapter(&mut self) -> Result<Arc<Adapter>, String> {
        if let Some(adapter) = &self.adapter {
            return Ok(adapter.clone());
        }

        self.ensure_manager().await?;
        let manager = self.manager.as_ref().unwrap();
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| format!("No BLE adapter: {e}"))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "No Bluetooth adapter found".to_string())?;

        let adapter = Arc::new(adapter);
        self.adapter = Some(adapter.clone());
        Ok(adapter)
    }

    async fn stop_adapter_scan(adapter: &Adapter) {
        if let Err(e) = adapter.stop_scan().await {
            warn!("stop_scan: {e}");
        }
    }

    async fn wait_task(task: Option<JoinHandle<()>>, label: &str) {
        let Some(task) = task else {
            return;
        };
        match tokio::time::timeout(Duration::from_secs(8), task).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => warn!("{label} task join error: {e}"),
            Err(_) => warn!("{label} task timeout"),
        }
    }

    pub async fn start_scan(&mut self) -> Result<(), String> {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        self.stop_scan_internal().await;

        let adapter = self.adapter().await?;
        let generation = self.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit_connection_state("scanning", None);

        let app = self.app_handle.clone().ok_or("App handle missing")?;
        let stop_notify = self.stop_scan_notify.clone();
        let scan_generation = self.scan_generation.clone();

        let task = tokio::spawn(async move {
            let filter = ScanFilter {
                services: vec![],
            };

            if let Err(e) = adapter.start_scan(filter).await {
                let _ = app.emit(
                    "connection-state",
                    ConnectionStatePayload {
                        status: "disconnected".to_string(),
                        device_id: None,
                        device_name: None,
                        error: Some(format!("Scan failed: {e}")),
                    },
                );
                return;
            }

            let mut seen = HashMap::<String, String>::new();
            let deadline = Instant::now() + Duration::from_secs(12);

            loop {
                if scan_generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                tokio::select! {
                    _ = stop_notify.notified() => break,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        if Instant::now() > deadline {
                            break;
                        }
                        if scan_generation.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        let peripherals = match adapter.peripherals().await {
                            Ok(p) => p,
                            Err(e) => {
                                warn!("peripherals during scan: {e}");
                                continue;
                            }
                        };
                        for peripheral in peripherals {
                            let props = match peripheral.properties().await {
                                Ok(Some(p)) => p,
                                _ => continue,
                            };
                            let id = peripheral.id().to_string();
                            if seen.contains_key(&id) {
                                continue;
                            }
                            let Some(name) = trainer_display_name(&props.local_name) else {
                                continue;
                            };
                            let has_ftms = scan_has_ftms(&props, &name);
                            seen.insert(id.clone(), name.clone());
                            let _ = app.emit(
                                "scan-result",
                                ScanResultPayload { id, name, has_ftms },
                            );
                        }
                    }
                }
            }

            Self::stop_adapter_scan(&adapter).await;
        });

        self.scan_task = Some(task);
        Ok(())
    }

    async fn stop_scan_internal(&mut self) {
        self.scan_generation.fetch_add(1, Ordering::SeqCst);
        self.stop_scan_notify.notify_waiters();
        self.stop_scan_notify = Arc::new(Notify::new());

        let task = self.scan_task.take();
        Self::wait_task(task, "scan").await;

        if let Some(adapter) = &self.adapter {
            Self::stop_adapter_scan(adapter).await;
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    async fn scan_and_connect(
        adapter: &Adapter,
        device_id: &str,
    ) -> Result<Peripheral, String> {
        info!("BLE: scan+connect for {device_id}");
        let filter = ScanFilter {
            services: vec![],
        };
        adapter
            .start_scan(filter)
            .await
            .map_err(|e| format!("Scan before connect failed: {e}"))?;

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut last_err = String::from("dispositivo non raggiungibile");

        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(350)).await;
            let peripherals = adapter
                .peripherals()
                .await
                .map_err(|e| format!("Peripheral list failed: {e}"))?;

            for peripheral in peripherals {
                if peripheral.id().to_string() != device_id {
                    continue;
                }

                info!("BLE: target found, connecting while scan is active");
                match peripheral.connect().await {
                    Ok(()) => {
                        Self::stop_adapter_scan(adapter).await;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        return Ok(peripheral);
                    }
                    Err(e) => {
                        last_err = format!("{e}");
                        warn!("BLE: connect while scanning failed: {e}");
                        let _ = peripheral.disconnect().await;
                        tokio::time::sleep(Duration::from_millis(450)).await;
                    }
                }
            }
        }

        Self::stop_adapter_scan(adapter).await;
        Err(format!(
            "Connect failed: {last_err}. \
            Pedala sul rullo, chiudi Zwift/Tacx/Garmin e verifica l'accoppiamento Bluetooth in Windows."
        ))
    }

    pub async fn stop_scan(&mut self) {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        self.stop_scan_internal().await;
        if self.connected_id.is_none() && !self.connecting {
            self.emit_connection_state("disconnected", None);
        }
    }

    pub async fn connect(&mut self, device_id: String) -> Result<(), String> {
        if self.connecting {
            return Err("Connessione già in corso".into());
        }

        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        self.connecting = true;

        let result = self.connect_inner(device_id).await;
        self.connecting = false;
        result
    }

    async fn connect_inner(&mut self, device_id: String) -> Result<(), String> {
        self.stop_scan_internal().await;
        self.emit_connection_state("connecting", None);

        let adapter = self.adapter().await?;
        info!("BLE: preparing connect to {device_id}");

        let connect_result: Result<(), String> = async {
            let peripheral = Self::scan_and_connect(adapter.as_ref(), &device_id).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;

            info!("BLE: discovering services...");
            peripheral
                .discover_services()
                .await
                .map_err(|e| format!("Service discovery failed: {e}"))?;

            let props = peripheral
                .properties()
                .await
                .map_err(|e| format!("Properties failed: {e}"))?
                .ok_or_else(|| "No device properties".to_string())?;

            let name = trainer_display_name(&props.local_name)
                .unwrap_or_else(|| "Smart trainer".to_string());

            let services = peripheral.services();
            let has_ftms = services.iter().any(|s| s.uuid == FTMS_SERVICE);
            if !has_ftms {
                let _ = peripheral.disconnect().await;
                return Err(
                    "Device does not expose FTMS (Fitness Machine Service). Unsupported in MVP."
                        .into(),
                );
            }

            let control_char = services
                .iter()
                .flat_map(|s| s.characteristics.iter())
                .find(|c| c.uuid == FTMS_CONTROL_POINT)
                .cloned();

            let peripheral = Arc::new(peripheral);

            info!("BLE: starting notifications...");
            self.start_notifications(peripheral.clone(), control_char.clone())
                .await?;

            self.connected_id = Some(device_id);
            self.connected_name = Some(name);
            self.peripheral = Some(peripheral.clone());
            self.control_char = control_char.clone();
            self.has_control = control_char.is_some();

            self.emit_connection_state("connected", None);
            info!("BLE: connected");

            if let Some(control) = control_char {
                let p = peripheral.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    if let Err(e) = request_control_soft(&p, &control).await {
                        warn!("FTMS request control failed (non-fatal): {e}");
                    }
                });
            }

            Ok(())
        }
        .await;

        if let Err(ref err) = connect_result {
            if let Some(peripheral) = self.peripheral.take() {
                let _ = peripheral.disconnect().await;
            }
            self.connected_id = None;
            self.connected_name = None;
            self.control_char = None;
            self.has_control = false;
            self.emit_connection_state("disconnected", Some(err.clone()));
        }

        connect_result
    }

    async fn start_notifications(
        &mut self,
        peripheral: Arc<Peripheral>,
        control_char: Option<Characteristic>,
    ) -> Result<(), String> {
        if let Some(task) = self.notify_task.take() {
            Self::wait_task(Some(task), "notify").await;
        }

        let services = peripheral.services();
        let bike_char = services
            .iter()
            .flat_map(|s| s.characteristics.iter())
            .find(|c| c.uuid == INDOOR_BIKE_DATA)
            .cloned()
            .ok_or_else(|| "Indoor Bike Data characteristic not found".to_string())?;

        let hr_char = services
            .iter()
            .flat_map(|s| s.characteristics.iter())
            .find(|c| c.uuid == HR_MEASUREMENT)
            .cloned();

        info!("BLE: opening notification stream");
        let mut notification_stream = peripheral
            .notifications()
            .await
            .map_err(|e| format!("Notification stream failed: {e}"))?;

        if let Some(control) = &control_char {
            info!("BLE: subscribing control point");
            if let Err(e) = peripheral.subscribe(control).await {
                warn!("Control point subscribe failed: {e}");
            } else {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }

        info!("BLE: subscribing indoor bike data");
        peripheral
            .subscribe(&bike_char)
            .await
            .map_err(|e| format!("Subscribe failed: {e}"))?;

        if let Some(hr) = &hr_char {
            if let Err(e) = peripheral.subscribe(hr).await {
                warn!("HR subscribe failed: {e}");
            }
        }

        let app = self.app_handle.clone();
        let recorder = self.recorder.clone();
        let tp_clone = self.target_power_shared.clone();
        let session_start = Instant::now();

        let task = tokio::spawn(async move {
            let mut last_hr: Option<u8> = None;
            while let Some(notification) = notification_stream.next().await {
                if notification.uuid == FTMS_CONTROL_POINT {
                    if let Err(e) = parse_control_response(&notification.value) {
                        warn!("FTMS control response: {e}");
                    }
                    continue;
                }

                let timestamp_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or_else(|_| session_start.elapsed().as_millis() as i64);

                if notification.uuid == INDOOR_BIKE_DATA {
                    if let Some(parsed) = parse_indoor_bike_data(&notification.value) {
                        let target = *tp_clone.lock().await;
                        let sample = TelemetrySample {
                            timestamp_ms,
                            power: parsed.power_watts.map(|p| p.max(0) as u16),
                            cadence: parsed.cadence_rpm,
                            speed_kmh: parsed.speed_kmh,
                            heart_rate: last_hr,
                            target_power: target,
                            resistance: parsed.resistance,
                        };
                        recorder.lock().await.ingest(&sample);
                        if let Some(app) = &app {
                            let _ = app.emit("telemetry", sample);
                        }
                    }
                } else if notification.uuid == HR_MEASUREMENT {
                    last_hr = parse_hr_measurement(&notification.value);
                }
            }
        });

        self.notify_task = Some(task);
        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<(), String> {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;

        if let Some(peripheral) = self.peripheral.take() {
            let _ = peripheral.disconnect().await;
        }

        let task = self.notify_task.take();
        Self::wait_task(task, "notify").await;

        self.connected_id = None;
        self.connected_name = None;
        self.control_char = None;
        self.has_control = false;
        self.emit_connection_state("disconnected", None);
        Ok(())
    }

    pub async fn set_target_power(&mut self, watts: u16) -> Result<(), String> {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        self.target_power = Some(watts);
        *self.target_power_shared.lock().await = Some(watts);
        let peripheral = self
            .peripheral
            .clone()
            .ok_or_else(|| "Not connected".to_string())?;
        let control = self
            .control_char
            .clone()
            .ok_or_else(|| "Control point unavailable".to_string())?;

        write_control_soft(
            peripheral.as_ref(),
            &control,
            ftms::encode_set_target_power(watts as i16),
        )
        .await
    }

    pub async fn set_resistance(&mut self, percent: f64) -> Result<(), String> {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        let peripheral = self
            .peripheral
            .clone()
            .ok_or_else(|| "Not connected".to_string())?;
        let control = self
            .control_char
            .clone()
            .ok_or_else(|| "Control point unavailable".to_string())?;

        write_control_soft(
            peripheral.as_ref(),
            &control,
            ftms::encode_set_target_resistance(percent),
        )
        .await
    }

    pub async fn set_simulation(&mut self, grade_percent: f64, wind_speed_ms: f64) -> Result<(), String> {
        let serial = self.ble_serial.clone();
        let _serial = serial.lock().await;
        let peripheral = self
            .peripheral
            .clone()
            .ok_or_else(|| "Not connected".to_string())?;
        let control = self
            .control_char
            .clone()
            .ok_or_else(|| "Control point unavailable".to_string())?;

        write_control_soft(
            peripheral.as_ref(),
            &control,
            ftms::encode_set_simulation(grade_percent, wind_speed_ms),
        )
        .await
    }
}

async fn write_control_soft(
    peripheral: &Peripheral,
    control: &Characteristic,
    payload: Vec<u8>,
) -> Result<(), String> {
    if let Err(e) = peripheral
        .write(control, &payload, WriteType::WithoutResponse)
        .await
    {
        peripheral
            .write(control, &payload, WriteType::WithResponse)
            .await
            .map_err(|e2| format!("Control write failed: {e} / {e2}"))?;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn request_control_soft(
    peripheral: &Peripheral,
    control: &Characteristic,
) -> Result<(), String> {
    write_control_soft(peripheral, control, ftms::encode_request_control()).await?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    write_control_soft(peripheral, control, ftms::encode_start_or_resume()).await?;
    Ok(())
}

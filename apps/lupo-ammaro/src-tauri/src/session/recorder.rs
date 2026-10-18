use super::{SessionSample, SessionSummary, TelemetrySample};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Active,
    Paused,
}

pub struct LastSession {
    pub started_at: DateTime<Utc>,
    pub samples: Vec<SessionSample>,
}

pub struct SessionRecorder {
    status: SessionStatus,
    started_at: Option<DateTime<Utc>>,
    paused_at: Option<DateTime<Utc>>,
    total_paused_ms: i64,
    samples: Vec<SessionSample>,
    current_target_power: Option<u16>,
    last_session: Option<LastSession>,
}

impl SessionRecorder {
    pub fn new() -> Self {
        Self {
            status: SessionStatus::Idle,
            started_at: None,
            paused_at: None,
            total_paused_ms: 0,
            samples: Vec::new(),
            current_target_power: None,
            last_session: None,
        }
    }

    pub fn status(&self) -> SessionStatus {
        self.status
    }

    pub fn start(&mut self) {
        self.status = SessionStatus::Active;
        self.started_at = Some(Utc::now());
        self.paused_at = None;
        self.total_paused_ms = 0;
        self.samples.clear();
    }

    pub fn pause(&mut self) {
        if self.status == SessionStatus::Active {
            self.status = SessionStatus::Paused;
            self.paused_at = Some(Utc::now());
        }
    }

    pub fn resume(&mut self) {
        if self.status == SessionStatus::Paused {
            if let Some(paused_at) = self.paused_at.take() {
                self.total_paused_ms += (Utc::now() - paused_at).num_milliseconds();
            }
            self.status = SessionStatus::Active;
        }
    }

    pub fn end(&mut self) -> SessionSummary {
        let ended_at = Utc::now();
        let summary = self.build_summary(ended_at);
        if let Some(started_at) = self.started_at {
            self.last_session = Some(LastSession {
                started_at,
                samples: self.samples.clone(),
            });
        }
        self.status = SessionStatus::Idle;
        self.started_at = None;
        self.paused_at = None;
        self.total_paused_ms = 0;
        self.samples.clear();
        summary
    }

    pub fn set_target_power(&mut self, watts: u16) {
        self.current_target_power = Some(watts);
    }

    pub fn ingest(&mut self, telemetry: &TelemetrySample) {
        if self.status != SessionStatus::Active {
            return;
        }

        self.samples.push(SessionSample {
            timestamp_ms: telemetry.timestamp_ms,
            power: telemetry.power,
            cadence: telemetry.cadence,
            speed_kmh: telemetry.speed_kmh,
            heart_rate: telemetry.heart_rate,
            target_power: telemetry
                .target_power
                .or(self.current_target_power),
        });
    }

    pub fn samples(&self) -> &[SessionSample] {
        &self.samples
    }

    pub fn started_at(&self) -> Option<DateTime<Utc>> {
        self.started_at
    }

    pub fn last_session(&self) -> Option<&LastSession> {
        self.last_session.as_ref()
    }

    fn build_summary(&self, ended_at: DateTime<Utc>) -> SessionSummary {
        let duration_secs = self
            .started_at
            .map(|start| {
                let elapsed_ms = (ended_at - start).num_milliseconds() - self.total_paused_ms;
                (elapsed_ms.max(0) as u64) / 1000
            })
            .unwrap_or(0);

        let powers: Vec<u16> = self
            .samples
            .iter()
            .filter_map(|s| s.power)
            .collect();

        let avg_power = if powers.is_empty() {
            None
        } else {
            Some((powers.iter().map(|p| *p as u64).sum::<u64>() / powers.len() as u64) as u16)
        };

        let max_power = powers.iter().copied().max();

        SessionSummary {
            started_at: self.started_at,
            ended_at: Some(ended_at),
            duration_secs,
            avg_power,
            max_power,
            sample_count: self.samples.len(),
        }
    }
}

impl Default for SessionRecorder {
    fn default() -> Self {
        Self::new()
    }
}

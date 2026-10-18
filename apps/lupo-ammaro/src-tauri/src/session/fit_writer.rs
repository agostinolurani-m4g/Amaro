use super::SessionSample;
use chrono::{DateTime, Utc};
use std::collections::HashSet;
use std::io;

const FIT_EPOCH: i64 = 631_065_600;

pub fn build_activity_fit(
    started_at: DateTime<Utc>,
    samples: &[SessionSample],
) -> Vec<u8> {
    let mut encoder = FitEncoder::new();
    encoder.write_file_id(started_at);
    encoder.write_file_creator();
    encoder.write_sport();

    for sample in samples {
        encoder.write_record(started_at, sample);
    }

    let duration_secs = samples
        .last()
        .map(|s| (s.timestamp_ms.max(0) as u64) / 1000)
        .unwrap_or(0);

    encoder.write_session(started_at, duration_secs, samples);
    encoder.write_lap(started_at, duration_secs, samples);
    encoder.write_activity(started_at);

    encoder.finish()
}

pub fn write_activity_fit(
    path: &str,
    started_at: DateTime<Utc>,
    samples: &[SessionSample],
) -> io::Result<()> {
    let bytes = build_activity_fit(started_at, samples);
    std::fs::write(path, bytes)
}

struct FitEncoder {
    records: Vec<u8>,
    local_msg_types: std::collections::HashMap<&'static str, u8>,
    defined: HashSet<&'static str>,
    next_local_type: u8,
}

impl FitEncoder {
    fn new() -> Self {
        Self {
            records: Vec::new(),
            local_msg_types: std::collections::HashMap::new(),
            defined: HashSet::new(),
            next_local_type: 0,
        }
    }

    fn local_type(&mut self, name: &'static str) -> u8 {
        if let Some(t) = self.local_msg_types.get(name) {
            return *t;
        }
        let t = self.next_local_type;
        self.next_local_type += 1;
        self.local_msg_types.insert(name, t);
        t
    }

    fn ensure_definition(&mut self, name: &'static str, global_type: u16, fields: &[(u8, u8, u8)]) {
        if self.defined.contains(name) {
            return;
        }
        let local = self.local_type(name);
        self.write_definition(local, global_type, fields);
        self.defined.insert(name);
    }

    fn fit_timestamp(dt: DateTime<Utc>) -> u32 {
        (dt.timestamp() - FIT_EPOCH).max(0) as u32
    }

    fn write_file_id(&mut self, started_at: DateTime<Utc>) {
        self.ensure_definition(
            "file_id",
            0,
            &[
                (0, 1, 2),
                (1, 1, 132),
                (2, 1, 132),
                (3, 1, 132),
                (4, 1, 134),
            ],
        );
        let local = self.local_type("file_id");
        self.records.push(local);
        self.write_field_u8(4);
        self.write_field_u16(255);
        self.write_field_u16(0);
        self.write_field_u32(Self::fit_timestamp(started_at));
    }

    fn write_file_creator(&mut self) {
        self.ensure_definition("file_creator", 49, &[(0, 1, 132), (1, 1, 132)]);
        let local = self.local_type("file_creator");
        self.records.push(local);
        self.write_field_u16(1);
        self.write_field_u16(100);
    }

    fn write_sport(&mut self) {
        self.ensure_definition("sport", 12, &[(0, 1, 0), (1, 1, 0)]);
        let local = self.local_type("sport");
        self.records.push(local);
        self.write_field_u8(2);
        self.write_field_u8(0);
    }

    fn write_record(&mut self, started_at: DateTime<Utc>, sample: &SessionSample) {
        self.ensure_definition(
            "record",
            20,
            &[
                (253, 4, 134),
                (3, 1, 2),
                (4, 1, 2),
                (6, 2, 132),
                (7, 2, 132),
            ],
        );

        let elapsed_secs = (sample.timestamp_ms.max(0) as u64) / 1000;
        let ts = Self::fit_timestamp(started_at) + elapsed_secs as u32;
        let local = self.local_type("record");

        self.records.push(local);
        self.write_field_u32(ts);
        self.write_field_u8(sample.heart_rate.unwrap_or(0));
        self.write_field_u8(
            sample
                .cadence
                .map(|cad| cad.round().clamp(0.0, 255.0) as u8)
                .unwrap_or(0),
        );

        let speed_ms = sample
            .speed_kmh
            .map(|kmh| (kmh / 3.6 * 1000.0).round() as u16)
            .unwrap_or(0);
        self.write_field_u16(speed_ms);
        self.write_field_u16(sample.power.unwrap_or(0));
    }

    fn write_session(
        &mut self,
        started_at: DateTime<Utc>,
        duration_secs: u64,
        samples: &[SessionSample],
    ) {
        self.ensure_definition(
            "session",
            18,
            &[
                (253, 4, 134),
                (7, 4, 134),
                (8, 4, 134),
                (9, 4, 134),
                (14, 2, 132),
                (15, 2, 132),
                (5, 1, 0),
            ],
        );

        let powers: Vec<u16> = samples.iter().filter_map(|s| s.power).collect();
        let avg_power = if powers.is_empty() {
            0
        } else {
            powers.iter().map(|p| *p as u32).sum::<u32>() / powers.len() as u32
        };
        let max_power = powers.iter().copied().max().unwrap_or(0) as u32;
        let end_ts = Self::fit_timestamp(started_at) + duration_secs as u32;
        let local = self.local_type("session");

        self.records.push(local);
        self.write_field_u32(end_ts);
        self.write_field_u32((duration_secs * 1000) as u32);
        self.write_field_u32((duration_secs * 1000) as u32);
        self.write_field_u32(0);
        self.write_field_u16(avg_power as u16);
        self.write_field_u16(max_power as u16);
        self.write_field_u8(2);
    }

    fn write_lap(
        &mut self,
        started_at: DateTime<Utc>,
        duration_secs: u64,
        samples: &[SessionSample],
    ) {
        self.ensure_definition(
            "lap",
            19,
            &[
                (253, 4, 134),
                (7, 4, 134),
                (8, 4, 134),
                (9, 4, 134),
                (14, 2, 132),
                (15, 2, 132),
            ],
        );

        let powers: Vec<u16> = samples.iter().filter_map(|s| s.power).collect();
        let avg_power = if powers.is_empty() {
            0
        } else {
            powers.iter().map(|p| *p as u32).sum::<u32>() / powers.len() as u32
        };
        let max_power = powers.iter().copied().max().unwrap_or(0) as u32;
        let end_ts = Self::fit_timestamp(started_at) + duration_secs as u32;
        let local = self.local_type("lap");

        self.records.push(local);
        self.write_field_u32(end_ts);
        self.write_field_u32((duration_secs * 1000) as u32);
        self.write_field_u32((duration_secs * 1000) as u32);
        self.write_field_u32(0);
        self.write_field_u16(avg_power as u16);
        self.write_field_u16(max_power as u16);
    }

    fn write_activity(&mut self, started_at: DateTime<Utc>) {
        self.ensure_definition("activity", 34, &[(253, 4, 134), (0, 2, 132), (1, 1, 0)]);
        let local = self.local_type("activity");
        self.records.push(local);
        self.write_field_u32(Self::fit_timestamp(started_at));
        self.write_field_u16(0);
        self.write_field_u8(0);
    }

    fn write_definition(&mut self, local_type: u8, global_type: u16, fields: &[(u8, u8, u8)]) {
        self.records.push(0x40 | local_type);
        self.records.push(0);
        self.records.push(0);
        self.records.extend_from_slice(&global_type.to_le_bytes());
        self.records.push(fields.len() as u8);
        for (num, size, typ) in fields {
            self.records.push(*num);
            self.records.push(*size);
            self.records.push(*typ);
        }
    }

    fn write_field_u8(&mut self, value: u8) {
        self.records.push(value);
    }

    fn write_field_u16(&mut self, value: u16) {
        self.records.extend_from_slice(&value.to_le_bytes());
    }

    fn write_field_u32(&mut self, value: u32) {
        self.records.extend_from_slice(&value.to_le_bytes());
    }

    fn finish(self) -> Vec<u8> {
        let data_size = self.records.len() as u32;
        let mut header = Vec::with_capacity(14);
        header.extend_from_slice(b".FIT");
        header.push(14);
        header.push(0x20);
        header.extend_from_slice(&[0x08, 0x00]);
        header.extend_from_slice(&data_size.to_le_bytes());
        let header_crc = fit_crc16(&header);
        header.extend_from_slice(&header_crc.to_le_bytes());

        let mut file = header;
        file.extend_from_slice(&self.records);
        let file_crc = fit_crc16(&file);
        file.extend_from_slice(&file_crc.to_le_bytes());
        file
    }
}

fn fit_crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for byte in data {
        let mut tmp = crc ^ (*byte as u16);
        for _ in 0..8 {
            if tmp & 1 != 0 {
                tmp = (tmp >> 1) ^ 0xA001;
            } else {
                tmp >>= 1;
            }
        }
        crc = tmp;
    }
    crc
}

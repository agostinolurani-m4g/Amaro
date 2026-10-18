use uuid::Uuid;

pub const FTMS_SERVICE: Uuid = Uuid::from_u128(0x00001826_0000_1000_8000_00805f9b34fb);
pub const INDOOR_BIKE_DATA: Uuid = Uuid::from_u128(0x00002ad2_0000_1000_8000_00805f9b34fb);
pub const FTMS_CONTROL_POINT: Uuid = Uuid::from_u128(0x00002ad9_0000_1000_8000_00805f9b34fb);
pub const HR_SERVICE: Uuid = Uuid::from_u128(0x0000180d_0000_1000_8000_00805f9b34fb);
pub const HR_MEASUREMENT: Uuid = Uuid::from_u128(0x00002a37_0000_1000_8000_00805f9b34fb);

#[derive(Debug, Clone, Default)]
pub struct IndoorBikeData {
    pub speed_kmh: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub power_watts: Option<i16>,
    pub resistance: Option<f64>,
}

pub fn parse_indoor_bike_data(data: &[u8]) -> Option<IndoorBikeData> {
    if data.len() < 4 {
        return None;
    }

    let flags = u16::from_le_bytes([data[0], data[1]]);
    let mut offset = 2;
    let mut result = IndoorBikeData::default();

    if data.len() >= offset + 2 {
        let speed_raw = u16::from_le_bytes([data[offset], data[offset + 1]]);
        result.speed_kmh = Some(speed_raw as f64 * 0.01);
        offset += 2;
    }

    if flags & 0x02 != 0 {
        if data.len() >= offset + 2 {
            offset += 2;
        }
    }

    if flags & 0x04 != 0 {
        if data.len() >= offset + 2 {
            let cad_raw = u16::from_le_bytes([data[offset], data[offset + 1]]);
            result.cadence_rpm = Some(cad_raw as f64 * 0.5);
            offset += 2;
        }
    }

    if flags & 0x08 != 0 {
        if data.len() >= offset + 2 {
            offset += 2;
        }
    }

    if flags & 0x10 != 0 {
        if data.len() >= offset + 3 {
            offset += 3;
        }
    }

    if flags & 0x20 != 0 {
        if data.len() >= offset + 2 {
            let res_raw = i16::from_le_bytes([data[offset], data[offset + 1]]);
            result.resistance = Some(res_raw as f64 * 0.1);
            offset += 2;
        }
    }

    if flags & 0x40 != 0 {
        if data.len() >= offset + 2 {
            let power_raw = i16::from_le_bytes([data[offset], data[offset + 1]]);
            result.power_watts = Some(power_raw);
            offset += 2;
        }
    }

    let _ = offset;
    Some(result)
}

pub fn parse_hr_measurement(data: &[u8]) -> Option<u8> {
    if data.is_empty() {
        return None;
    }
    let flags = data[0];
    let hr_index = if flags & 0x01 != 0 { 2 } else { 1 };
    data.get(hr_index).copied()
}

pub fn encode_request_control() -> Vec<u8> {
    vec![0x00]
}

pub fn encode_start_or_resume() -> Vec<u8> {
    vec![0x07]
}

pub fn encode_stop_or_pause() -> Vec<u8> {
    vec![0x08]
}

/// FTMS Control Point 0x05 — Set Target Power (ERG).
pub fn encode_set_target_power(watts: i16) -> Vec<u8> {
    let mut buf = vec![0x05];
    buf.extend_from_slice(&watts.to_le_bytes());
    buf
}

pub fn encode_set_target_resistance(percent: f64) -> Vec<u8> {
    let value = (percent * 10.0).round().clamp(0.0, 1000.0) as i16;
    let mut buf = vec![0x04];
    buf.extend_from_slice(&value.to_le_bytes());
    buf
}

/// FTMS Control Point 0x11 — Set Indoor Bike Simulation Parameters.
/// Same layout Zwift uses: wind, grade, Crr=0.004, Cw=0.51 kg/m.
/// wind: sint16 @ 0.001 m/s · grade: sint16 @ 0.01 % · Crr: uint8 @ 0.0001 · Cw: uint8 @ 0.01 kg/m
pub fn encode_set_simulation(grade_percent: f64, wind_speed_ms: f64) -> Vec<u8> {
    let wind = (wind_speed_ms * 1000.0).round().clamp(-32768.0, 32767.0) as i16;
    let grade = (grade_percent * 100.0).round().clamp(-32768.0, 32767.0) as i16;
    let crr = 40u8;
    let wind_resistance = 51u8;
    let mut buf = vec![0x11];
    buf.extend_from_slice(&wind.to_le_bytes());
    buf.extend_from_slice(&grade.to_le_bytes());
    buf.push(crr);
    buf.push(wind_resistance);
    buf
}

/// Indication: 0x80, request op code, result (0x01 success).
pub fn parse_control_response(data: &[u8]) -> Result<(), String> {
    if data.len() < 3 || data[0] != 0x80 {
        return Err(format!(
            "Unknown control response: {:02X?}",
            data.get(0)
        ));
    }
    match data[2] {
        0x01 => Ok(()),
        0x02 => Err("Op code not supported".into()),
        0x03 => Err("Invalid parameter".into()),
        0x04 => Err("Operation failed".into()),
        0x05 => Err("Control not permitted".into()),
        code => Err(format!("Unknown control result: 0x{code:02X}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_power_uses_erg_opcode() {
        assert_eq!(encode_set_target_power(220), vec![0x05, 0xDC, 0x00]);
    }

    #[test]
    fn simulation_matches_zwift_ftms_layout() {
        let bytes = encode_set_simulation(8.5, 0.0);
        assert_eq!(bytes[0], 0x11);
        assert_eq!(&bytes[1..3], &[0x00, 0x00]);
        assert_eq!(&bytes[3..5], &850i16.to_le_bytes());
        assert_eq!(bytes[5], 40);
        assert_eq!(bytes[6], 51);
    }

    #[test]
    fn control_success_is_80_then_result_01() {
        assert!(parse_control_response(&[0x80, 0x11, 0x01]).is_ok());
        assert!(parse_control_response(&[0x80, 0x05, 0x02]).is_err());
    }
}

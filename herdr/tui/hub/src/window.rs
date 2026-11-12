//! Authenticated commands for the last connected desktop window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::frontend::WindowError;
use serde_json::{Value, json};

struct Pending {
    tx: Sender<Result<Value, WindowError>>,
    sub: u64,
    expires: Instant,
}

fn pending() -> &'static Mutex<HashMap<u64, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

pub fn secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| format!("{}{}", crate::token().expect("window entropy"), crate::token().expect("window entropy")))
}

pub fn call(cmd: &str, command: &str, args: &Value, timeout: Duration) -> Result<Value, WindowError> {
    if !["do", "ls", "status"].contains(&cmd) {
        return Err(WindowError::Failed(format!("unknown window command {cmd:?}")));
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let (sub, sender) = crate::views::window_sender().ok_or(WindowError::NoWindow)?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    let mut waits = pending().lock().unwrap_or_else(|e| e.into_inner());
    waits.insert(id, Pending { tx, sub, expires: Instant::now() + timeout });
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() + timeout.as_millis();
    if sender.send(json!({"window":{"id":id,"cmd":cmd,"command":command,"args":args,"deadline":deadline as u64}}).to_string()).is_err() {
        waits.remove(&id);
        return Err(WindowError::NoWindow);
    }
    drop(waits);
    let answer = rx.recv_timeout(timeout).unwrap_or(Err(WindowError::MayHaveRun));
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    answer
}

pub fn reply(id: u64, token: &str, outcome: Result<Value, String>) -> bool {
    if token != secret() {
        return false;
    }
    let mut waits = pending().lock().unwrap_or_else(|e| e.into_inner());
    let Some(wait) = waits.remove(&id) else { return false };
    if Instant::now() >= wait.expires {
        return false;
    }
    wait.tx.send(outcome.map_err(WindowError::Failed)).is_ok()
}

pub fn gone(sub: u64) {
    pending().lock().unwrap_or_else(|e| e.into_inner()).retain(|_, wait| {
        if wait.sub != sub {
            return true;
        }
        let _ = wait.tx.send(Err(WindowError::MayHaveRun));
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_window_command_cannot_be_answered() {
        let (tx, rx) = channel();
        let sub = crate::views::subscribe(&json!({"notify":true,"window":true}), tx);
        assert_eq!(call("ls", "", &Value::Null, Duration::from_millis(5)), Err(WindowError::MayHaveRun));
        let command: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
        assert!(!reply(command["window"]["id"].as_u64().unwrap(), secret(), Ok(json!({}))));
        crate::views::window_gone(sub);
    }
}

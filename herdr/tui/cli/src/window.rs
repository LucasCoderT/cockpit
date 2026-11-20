//! Calls the local desktop or the window connected to this machine's hub.

use cockpit_core::frontend::{self, WindowError};
use serde_json::Value;

pub fn main(args: &[String]) {
    let result = match args {
        [cmd] if cmd == "ls" || cmd == "status" => frontend::window(cmd, "", &Value::Null),
        [cmd, command, json] if cmd == "do" => match serde_json::from_str(json) {
            Ok(value) => frontend::window(cmd, command, &value),
            Err(error) => Err(WindowError::Failed(format!("invalid window arguments: {error}"))),
        },
        _ => Err(WindowError::Failed("cockpit window do <command> <JSON args> | ls | status".into())),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(match error {
                WindowError::NoWindow => 3,
                WindowError::MayHaveRun => 4,
                WindowError::Failed(_) => 1,
            });
        }
    }
}

pub fn token() {
    match cockpit_core::hub::request(&serde_json::json!({"op":"window_token"}), std::time::Duration::from_secs(2)) {
        Ok(value) => println!("{value}"),
        Err(error) => crate::proc::fail(&error),
    }
}

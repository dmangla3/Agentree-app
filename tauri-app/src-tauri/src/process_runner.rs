use std::fmt;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommandOutputError {
    Spawn {
        label: String,
        message: String,
    },
    Capture {
        label: String,
        stream: &'static str,
    },
    Wait {
        label: String,
        message: String,
    },
    Terminate {
        label: String,
        message: String,
    },
    ReaderPanicked {
        label: String,
        stream: &'static str,
    },
    Read {
        label: String,
        stream: &'static str,
        message: String,
    },
    TimedOut {
        label: String,
        timeout: Duration,
        stderr: String,
    },
}

impl fmt::Display for CommandOutputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { label, message } => write!(formatter, "Failed to run {label}: {message}"),
            Self::Capture { label, stream } => {
                write!(formatter, "Failed to capture {label} {stream}")
            }
            Self::Wait { label, message } => {
                write!(formatter, "Failed while waiting for {label}: {message}")
            }
            Self::Terminate { label, message } => {
                write!(formatter, "Failed to stop {label}: {message}")
            }
            Self::ReaderPanicked { label, stream } => {
                write!(formatter, "{label} {stream} reader panicked")
            }
            Self::Read {
                label,
                stream,
                message,
            } => write!(formatter, "Failed to read {label} {stream}: {message}"),
            Self::TimedOut {
                label,
                timeout,
                stderr,
            } => write!(
                formatter,
                "{label} timed out after {}ms. stderr={stderr}",
                timeout.as_millis()
            ),
        }
    }
}

impl std::error::Error for CommandOutputError {}

fn terminate_command_tree(
    child: &mut Child,
    label: &str,
) -> Result<ExitStatus, CommandOutputError> {
    #[cfg(unix)]
    {
        let process_group_id = child.id() as i32;
        unsafe {
            libc::kill(-process_group_id, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut leader_status = None;
        while Instant::now() < deadline {
            if leader_status.is_none() {
                leader_status =
                    child
                        .try_wait()
                        .map_err(|error| CommandOutputError::Terminate {
                            label: label.to_string(),
                            message: format!("failed to inspect process leader: {error}"),
                        })?;
            }
            let group_exists = unsafe { libc::kill(-process_group_id, 0) } == 0;
            if !group_exists {
                return match leader_status {
                    Some(status) => Ok(status),
                    None => child.wait().map_err(|error| CommandOutputError::Terminate {
                        label: label.to_string(),
                        message: format!("failed to reap process: {error}"),
                    }),
                };
            }
            thread::sleep(Duration::from_millis(25));
        }
        unsafe {
            libc::kill(-process_group_id, libc::SIGKILL);
        }
        return match leader_status {
            Some(status) => Ok(status),
            None => child.wait().map_err(|error| CommandOutputError::Terminate {
                label: label.to_string(),
                message: format!("failed to reap process group: {error}"),
            }),
        };
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
        child.wait().map_err(|error| CommandOutputError::Terminate {
            label: label.to_string(),
            message: error.to_string(),
        })
    }
}

pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, CommandOutputError> {
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CommandOutputError::Spawn {
            label: label.to_string(),
            message: error.to_string(),
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandOutputError::Capture {
            label: label.to_string(),
            stream: "stdout",
        })?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| CommandOutputError::Capture {
            label: label.to_string(),
            stream: "stderr",
        })?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started_at = Instant::now();
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status, false),
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let status = terminate_command_tree(&mut child, label)?;
                    break (status, true);
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = terminate_command_tree(&mut child, label);
                return Err(CommandOutputError::Wait {
                    label: label.to_string(),
                    message: error.to_string(),
                });
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| CommandOutputError::ReaderPanicked {
            label: label.to_string(),
            stream: "stdout",
        })?
        .map_err(|error| CommandOutputError::Read {
            label: label.to_string(),
            stream: "stdout",
            message: error.to_string(),
        })?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CommandOutputError::ReaderPanicked {
            label: label.to_string(),
            stream: "stderr",
        })?
        .map_err(|error| CommandOutputError::Read {
            label: label.to_string(),
            stream: "stderr",
            message: error.to_string(),
        })?;
    if timed_out {
        return Err(CommandOutputError::TimedOut {
            label: label.to_string(),
            timeout,
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        });
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

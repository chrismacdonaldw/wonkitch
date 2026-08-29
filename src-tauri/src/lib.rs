use axum::{
    Router,
    body::Body,
    extract::State as AxumState,
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(windows)]
use std::io::{Read, Write};
use std::{
    cmp::Reverse,
    collections::HashMap,
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, path::BaseDirectory};
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

mod preferences;
mod twitch;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STREAMLINK_RESOURCE: &str = "streamlink/8.5.0-1/bin/streamlink.exe";
const STREAMLINK_RUNNER_ARGUMENT: &str = "--wonkitch-streamlink-runner";

struct StreamState {
    active: Mutex<Option<ActiveStream>>,
    generation: AtomicU64,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

struct ActiveStream {
    child: ManagedChild,
    proxy_shutdown: Option<oneshot::Sender<()>>,
}

struct PreparedStream {
    child: ManagedChild,
    upstream_url: String,
    channel: String,
    quality: String,
    qualities: Vec<String>,
    title: String,
    category: String,
}

struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: Option<KillOnCloseJob>,
}

impl ManagedChild {
    fn new(mut child: Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let job = KillOnCloseJob::new(&child).map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                format!("Could not contain the Streamlink process: {error}")
            })?;
            Ok(Self {
                child,
                job: Some(job),
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self { child })
        }
    }

    fn wait_with_output(self) -> std::io::Result<std::process::Output> {
        self.child.wait_with_output()
    }
}

#[cfg(windows)]
struct KillOnCloseJob(HANDLE);

#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}

#[cfg(windows)]
impl KillOnCloseJob {
    fn new(child: &Child) -> std::io::Result<Self> {
        // The job handle remains owned by wonkitch, so Windows kills the entire
        // Streamlink/Python tree even if the app exits unexpectedly.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) } != 0;
        if !assigned {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(Self(job))
    }
}

#[cfg(windows)]
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[derive(Clone)]
struct ProxyTarget {
    client: reqwest::Client,
    upstream_url: String,
}

#[derive(Deserialize)]
struct StreamlinkOutput {
    #[serde(default)]
    metadata: HashMap<String, Value>,
    streams: HashMap<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamInfo {
    url: String,
    channel: String,
    quality: String,
    qualities: Vec<String>,
    title: String,
    category: String,
}

#[tauri::command]
async fn start_stream(
    app: tauri::AppHandle,
    channel: String,
    quality: String,
    state: tauri::State<'_, StreamState>,
) -> Result<StreamInfo, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let streamlink = find_streamlink(&app)?;
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_stream(normalize_channel(&channel)?, quality, streamlink)
    })
    .await
    .map_err(|error| format!("Stream worker failed: {error}"))??;

    if state.generation.load(Ordering::SeqCst) != generation {
        terminate_stream(ActiveStream {
            child: prepared.child,
            proxy_shutdown: None,
        });
        return Err("Stream request was superseded".to_string());
    }

    let proxy_result = start_proxy(prepared.upstream_url.clone()).await;
    let (proxy_url, proxy_shutdown) = match proxy_result {
        Ok(proxy) => proxy,
        Err(error) => {
            let mut child = prepared.child;
            terminate_child(&mut child);
            return Err(error);
        }
    };

    if state.generation.load(Ordering::SeqCst) != generation {
        terminate_stream(ActiveStream {
            child: prepared.child,
            proxy_shutdown: Some(proxy_shutdown),
        });
        return Err("Stream request was superseded".to_string());
    }

    let info = StreamInfo {
        url: proxy_url,
        channel: prepared.channel.clone(),
        quality: prepared.quality.clone(),
        qualities: prepared.qualities.clone(),
        title: prepared.title.clone(),
        category: prepared.category.clone(),
    };

    let mut active = state
        .active
        .lock()
        .map_err(|_| "Stream state is unavailable".to_string())?;

    if state.generation.load(Ordering::SeqCst) != generation {
        drop(active);
        terminate_stream(ActiveStream {
            child: prepared.child,
            proxy_shutdown: Some(proxy_shutdown),
        });
        return Err("Stream request was superseded".to_string());
    }

    if let Some(previous) = active.take() {
        terminate_stream(previous);
    }

    *active = Some(ActiveStream {
        child: prepared.child,
        proxy_shutdown: Some(proxy_shutdown),
    });

    Ok(info)
}

#[tauri::command]
fn stop_stream(state: tauri::State<'_, StreamState>) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    stop_active_stream(&state)
}

fn prepare_stream(
    channel: String,
    requested_quality: String,
    streamlink: PathBuf,
) -> Result<PreparedStream, String> {
    let twitch_url = format!("https://www.twitch.tv/{channel}");

    let output = spawn_streamlink(
        &streamlink,
        &[
            "--no-config",
            "--no-plugin-sideloading",
            "--json",
            "--loglevel=none",
            &twitch_url,
        ],
        true,
    )
    .and_then(|child| child.wait_with_output().map_err(|error| error.to_string()))
    .map_err(|error| format!("Could not inspect #{channel}: {error}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("#{channel} is offline or unavailable")
        } else {
            detail
        });
    }

    let payload: StreamlinkOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Streamlink returned invalid stream data: {error}"))?;

    if payload.streams.is_empty() {
        return Err(format!("#{channel} is offline or unavailable"));
    }

    let mut qualities: Vec<String> = payload
        .streams
        .keys()
        .filter(|quality| quality.as_str() != "best" && quality.as_str() != "worst")
        .cloned()
        .collect();
    qualities.sort_by_key(|quality| Reverse(quality_score(quality)));
    qualities.dedup();
    qualities.insert(0, "best".to_string());

    let selected_quality =
        if requested_quality == "best" || payload.streams.contains_key(&requested_quality) {
            requested_quality
        } else {
            "best".to_string()
        };

    let port = reserve_port()?;
    let upstream_url = format!("http://127.0.0.1:{port}/");
    let port_argument = format!("--player-external-http-port={port}");

    let mut child = spawn_streamlink(
        &streamlink,
        &[
            "--no-config",
            "--no-plugin-sideloading",
            "--loglevel=none",
            "--twitch-low-latency",
            "--stream-segment-threads=3",
            "--retry-open=3",
            "--player-external-http",
            "--player-external-http-interface=127.0.0.1",
            &port_argument,
            "--player-external-http-continuous=yes",
            &twitch_url,
            &selected_quality,
        ],
        false,
    )
    .map_err(|error| format!("Could not start Streamlink: {error}"))?;

    wait_for_server(&mut child.child, port).inspect_err(|_| {
        terminate_child(&mut child);
    })?;

    Ok(PreparedStream {
        child,
        upstream_url,
        channel,
        quality: selected_quality,
        qualities,
        title: metadata_string(&payload.metadata, "title"),
        category: metadata_string(&payload.metadata, "category"),
    })
}

async fn start_proxy(upstream_url: String) -> Result<(String, oneshot::Sender<()>), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("Could not create the local stream relay: {error}"))?;

    let target = Arc::new(ProxyTarget {
        client,
        upstream_url,
    });
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers(Any);
    let router = Router::new()
        .route("/stream", get(relay_stream))
        .with_state(target)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not bind the local stream relay: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the relay address: {error}"))?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        let _ = server.await;
    });

    Ok((format!("http://{address}/stream"), shutdown_tx))
}

async fn relay_stream(AxumState(target): AxumState<Arc<ProxyTarget>>) -> Response {
    let upstream = match target.client.get(&target.upstream_url).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Stream relay connection failed: {error}"),
            )
                .into_response();
        }
    };

    if !upstream.status().is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            format!("Streamlink relay returned {}", upstream.status()),
        )
            .into_response();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CACHE_CONTROL, "no-store, no-cache")
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn normalize_channel(input: &str) -> Result<String, String> {
    let mut channel = input.trim().to_ascii_lowercase();

    for prefix in [
        "https://www.twitch.tv/",
        "https://twitch.tv/",
        "www.twitch.tv/",
        "twitch.tv/",
    ] {
        if let Some(stripped) = channel.strip_prefix(prefix) {
            channel = stripped.to_string();
            break;
        }
    }

    channel = channel
        .trim_start_matches(['#', '@'])
        .split(['/', '?'])
        .next()
        .unwrap_or_default()
        .to_string();

    let valid = !channel.is_empty()
        && channel.len() <= 25
        && channel
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_');

    if valid {
        Ok(channel)
    } else {
        Err("Enter a valid Twitch channel name".to_string())
    }
}

fn find_streamlink(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve(STREAMLINK_RESOURCE, BaseDirectory::Resource)
        .map_err(|error| format!("Could not resolve the bundled Streamlink runtime: {error}"))?;
    bundled
        .is_file()
        .then_some(bundled)
        .ok_or_else(|| "The bundled Streamlink runtime is unavailable".to_string())
}

fn hidden_command(program: &PathBuf) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn spawn_streamlink(
    streamlink: &PathBuf,
    arguments: &[&str],
    capture_output: bool,
) -> Result<ManagedChild, String> {
    #[cfg(windows)]
    let mut command = {
        let current_executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the wonkitch executable: {error}"))?;
        let mut command = hidden_command(&current_executable);
        command
            .arg(STREAMLINK_RUNNER_ARGUMENT)
            .arg(streamlink)
            .args(arguments)
            .stdin(Stdio::piped());
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = hidden_command(streamlink);
        command.args(arguments).stdin(Stdio::null());
        command
    };

    if capture_output {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Could not start Streamlink: {error}"))?;
    let mut child = ManagedChild::new(child)?;

    #[cfg(windows)]
    {
        let ready = child
            .child
            .stdin
            .take()
            .ok_or_else(|| "Could not synchronize the Streamlink process".to_string())?
            .write_all(&[1]);
        if let Err(error) = ready {
            terminate_child(&mut child);
            return Err(format!(
                "Could not synchronize the Streamlink process: {error}"
            ));
        }
    }
    Ok(child)
}

#[cfg(windows)]
fn run_streamlink_runner() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _ = arguments.next();
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(STREAMLINK_RUNNER_ARGUMENT)) {
        return None;
    }
    let Some(streamlink) = arguments.next() else {
        return Some(1);
    };
    let mut ready = [0_u8; 1];
    if std::io::stdin().read_exact(&mut ready).is_err() {
        return Some(1);
    }
    Some(
        Command::new(streamlink)
            .args(arguments)
            .stdin(Stdio::null())
            .status()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1),
    )
}

fn reserve_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a local stream port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read the local stream port: {error}"))
}

fn wait_for_server(child: &mut Child, port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(20);

    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not check Streamlink: {error}"))?
        {
            return Err(format!("Streamlink exited before playback ({status})"));
        }

        if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err("Streamlink took too long to start playback".to_string())
}

fn quality_score(quality: &str) -> i32 {
    if quality == "audio_only" {
        return -1;
    }

    let resolution = quality
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .parse::<i32>()
        .unwrap_or_default();
    let framerate = if quality.contains("60") { 60 } else { 30 };
    resolution * 100 + framerate
}

fn metadata_string(metadata: &HashMap<String, Value>, key: &str) -> String {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn terminate_stream(mut stream: ActiveStream) {
    if let Some(shutdown) = stream.proxy_shutdown.take() {
        let _ = shutdown.send(());
    }
    terminate_child(&mut stream.child);
}

fn terminate_child(child: &mut ManagedChild) {
    #[cfg(windows)]
    {
        drop(child.job.take());
    }
    let _ = child.child.kill();
    let _ = child.child.wait();
}

fn stop_active_stream(state: &StreamState) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Stream state is unavailable".to_string())?;
    if let Some(stream) = active.take() {
        terminate_stream(stream);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if let Some(exit_code) = run_streamlink_runner() {
        std::process::exit(exit_code);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(StreamState::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            app.manage(twitch::TwitchState::load(app_data.join("settings.json")));
            app.manage(preferences::PreferencesState::load(
                app_data.join("preferences.json"),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_stream,
            stop_stream,
            preferences::get_preferences,
            preferences::save_preferences,
            preferences::reset_preferences,
            twitch::get_twitch_auth_status,
            twitch::configure_twitch_client,
            twitch::begin_twitch_login,
            twitch::poll_twitch_login,
            twitch::cancel_twitch_login,
            twitch::logout_twitch,
            twitch::send_chat_message,
            twitch::get_followed_channels
        ])
        .build(tauri::generate_context!())
        .expect("error while building wonkitch");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<StreamState>();
            let _ = stop_active_stream(&state);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{normalize_channel, quality_score};

    #[test]
    fn normalizes_channel_names_and_urls() {
        assert_eq!(normalize_channel("#MoonMoon").unwrap(), "moonmoon");
        assert_eq!(
            normalize_channel("https://www.twitch.tv/Sodapoppin/videos").unwrap(),
            "sodapoppin"
        );
    }

    #[test]
    fn rejects_invalid_channels() {
        assert!(normalize_channel("not a channel").is_err());
        assert!(normalize_channel("https://twitch.tv/").is_err());
    }

    #[test]
    fn sorts_video_above_audio() {
        assert!(quality_score("1080p60") > quality_score("720p60"));
        assert!(quality_score("480p") > quality_score("audio_only"));
    }
}

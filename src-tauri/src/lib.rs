use axum::{
    body::Body,
    extract::State as AxumState,
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::HashMap,
    env,
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct StreamState {
    active: Mutex<Option<ActiveStream>>,
}

struct ActiveStream {
    child: Child,
    proxy_shutdown: Option<oneshot::Sender<()>>,
}

struct PreparedStream {
    child: Child,
    upstream_url: String,
    channel: String,
    quality: String,
    qualities: Vec<String>,
    title: String,
    category: String,
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
    channel: String,
    quality: String,
    state: tauri::State<'_, StreamState>,
) -> Result<StreamInfo, String> {
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_stream(normalize_channel(&channel)?, quality)
    })
    .await
    .map_err(|error| format!("Stream worker failed: {error}"))??;

    let proxy_result = start_proxy(prepared.upstream_url.clone()).await;
    let (proxy_url, proxy_shutdown) = match proxy_result {
        Ok(proxy) => proxy,
        Err(error) => {
            let mut child = prepared.child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

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
    stop_active_stream(&state)
}

fn prepare_stream(channel: String, requested_quality: String) -> Result<PreparedStream, String> {
    let streamlink = find_streamlink()?;
    let twitch_url = format!("https://www.twitch.tv/{channel}");

    let mut inspect = hidden_command(&streamlink);
    let output = inspect
        .args(["--json", "--loglevel=none", &twitch_url])
        .output()
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

    let selected_quality = if requested_quality == "best"
        || payload.streams.contains_key(&requested_quality)
    {
        requested_quality
    } else {
        "best".to_string()
    };

    let port = reserve_port()?;
    let upstream_url = format!("http://127.0.0.1:{port}/");
    let port_argument = format!("--player-external-http-port={port}");

    let mut launch = hidden_command(&streamlink);
    let mut child = launch
        .args([
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
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Streamlink: {error}"))?;

    wait_for_server(&mut child, port).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error
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

fn find_streamlink() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data).join("Programs/Streamlink/bin/streamlink.exe"),
        );
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Streamlink/bin/streamlink.exe"));
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("Streamlink/bin/streamlink.exe"));
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Streamlink is not installed where MoonDeck can find it".to_string())
}

fn hidden_command(program: &PathBuf) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
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
    let _ = stream.child.kill();
    let _ = stream.child.wait();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(StreamState::default())
        .invoke_handler(tauri::generate_handler![start_stream, stop_stream])
        .build(tauri::generate_context!())
        .expect("error while building MoonDeck");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<StreamState>();
            let _ = stop_active_stream(&state);
        }
    });
}

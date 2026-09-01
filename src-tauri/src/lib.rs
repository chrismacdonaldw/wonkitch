use axum::{
    Router,
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use reqwest::Url;
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
const STREAMLINK_RESOURCE: &str = "streamlink/8.5.0-1/Python/pythonw.exe";
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
    child: Option<ManagedChild>,
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
struct LiveProxyTarget {
    client: reqwest::Client,
    upstream_url: String,
}

#[derive(Clone)]
struct VodProxyTarget {
    client: reqwest::Client,
    token: String,
    resources: Arc<Mutex<VodResourceRegistry>>,
}

#[derive(Clone)]
struct VodSource {
    url: Url,
    headers: HeaderMap,
}

struct VodResourceRegistry {
    next_id: u64,
    resources: HashMap<String, VodSource>,
    ids_by_url: HashMap<String, String>,
}

#[derive(Deserialize)]
struct StreamlinkOutput {
    #[serde(default)]
    metadata: HashMap<String, Value>,
    streams: HashMap<String, StreamlinkStream>,
}

#[derive(Deserialize)]
struct StreamlinkStream {
    #[serde(rename = "type")]
    stream_type: String,
    master: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
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

struct PreparedVod {
    video_id: String,
    author: String,
    title: String,
    category: String,
    start_seconds: u64,
    source: VodSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VodInfo {
    video_id: String,
    author: String,
    title: String,
    category: String,
    start_seconds: u64,
    url: String,
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
            child: Some(prepared.child),
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
            child: Some(prepared.child),
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
            child: Some(prepared.child),
            proxy_shutdown: Some(proxy_shutdown),
        });
        return Err("Stream request was superseded".to_string());
    }

    if let Some(previous) = active.take() {
        terminate_stream(previous);
    }

    *active = Some(ActiveStream {
        child: Some(prepared.child),
        proxy_shutdown: Some(proxy_shutdown),
    });

    Ok(info)
}

#[tauri::command]
async fn start_vod(
    app: tauri::AppHandle,
    url: String,
    state: tauri::State<'_, StreamState>,
) -> Result<VodInfo, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let streamlink = find_streamlink(&app)?;
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let (video_id, start_seconds) = parse_twitch_vod(&url)?;
        prepare_vod(video_id, start_seconds, streamlink)
    })
    .await
    .map_err(|error| format!("VOD worker failed: {error}"))??;

    if state.generation.load(Ordering::SeqCst) != generation {
        return Err("VOD request was superseded".to_string());
    }

    let PreparedVod {
        video_id,
        author,
        title,
        category,
        start_seconds,
        source,
    } = prepared;
    let (url, proxy_shutdown) = start_vod_proxy(source).await?;

    if state.generation.load(Ordering::SeqCst) != generation {
        let _ = proxy_shutdown.send(());
        return Err("VOD request was superseded".to_string());
    }

    let info = VodInfo {
        video_id,
        author,
        title,
        category,
        start_seconds,
        url,
    };
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Stream state is unavailable".to_string())?;

    if state.generation.load(Ordering::SeqCst) != generation {
        drop(active);
        let _ = proxy_shutdown.send(());
        return Err("VOD request was superseded".to_string());
    }

    if let Some(previous) = active.take() {
        terminate_stream(previous);
    }
    *active = Some(ActiveStream {
        child: None,
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

fn parse_twitch_vod(input: &str) -> Result<(String, u64), String> {
    let input = input.trim();
    let candidate = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&candidate).map_err(|_| "Enter a valid Twitch VOD link".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let valid_host = host == "twitch.tv" || host.ends_with(".twitch.tv");
    if url.scheme() != "https"
        || !valid_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Enter a valid Twitch VOD link".to_string());
    }

    let video_id = if host == "player.twitch.tv" {
        url.query_pairs()
            .find(|(key, _)| key == "video")
            .map(|(_, value)| value.trim_start_matches('v').to_string())
            .ok_or_else(|| "Enter a valid Twitch VOD link".to_string())?
    } else {
        let segments: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|segment| !segment.is_empty())
            .collect();
        match segments.as_slice() {
            [kind, video_id] if is_vod_path_segment(kind) => (*video_id).to_string(),
            [_channel, kind, video_id] if is_vod_path_segment(kind) => (*video_id).to_string(),
            _ => return Err("Enter a valid Twitch VOD link".to_string()),
        }
    };
    if video_id.is_empty()
        || video_id.len() > 20
        || !video_id.chars().all(|character| character.is_ascii_digit())
    {
        return Err("Enter a valid Twitch VOD link".to_string());
    }

    let start_seconds = url
        .query_pairs()
        .find(|(key, _)| key == "t")
        .map(|(_, value)| parse_vod_time(&value))
        .transpose()?
        .unwrap_or_default();
    Ok((video_id, start_seconds))
}

fn is_vod_path_segment(segment: &str) -> bool {
    ["v", "video", "videos"]
        .iter()
        .any(|candidate| segment.eq_ignore_ascii_case(candidate))
}

fn parse_vod_time(value: &str) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut number = String::new();
    let mut previous_unit = 4_u8;

    for character in value.chars() {
        if character.is_ascii_digit() {
            number.push(character);
            continue;
        }
        let (unit, multiplier) = match character.to_ascii_lowercase() {
            'h' => (3, 60_u64 * 60),
            'm' => (2, 60),
            's' => (1, 1),
            _ => return Err("The VOD start time is invalid".to_string()),
        };
        if number.is_empty() || unit >= previous_unit {
            return Err("The VOD start time is invalid".to_string());
        }
        let amount = number
            .parse::<u64>()
            .map_err(|_| "The VOD start time is invalid".to_string())?;
        total = total
            .checked_add(
                amount
                    .checked_mul(multiplier)
                    .ok_or_else(|| "The VOD start time is invalid".to_string())?,
            )
            .ok_or_else(|| "The VOD start time is invalid".to_string())?;
        number.clear();
        previous_unit = unit;
    }

    if !number.is_empty() || previous_unit == 4 {
        return Err("The VOD start time is invalid".to_string());
    }
    Ok(total)
}

fn prepare_vod(
    video_id: String,
    start_seconds: u64,
    streamlink: PathBuf,
) -> Result<PreparedVod, String> {
    let twitch_url = format!("https://www.twitch.tv/videos/{video_id}");
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
    .map_err(|error| format!("Could not inspect VOD {video_id}: {error}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("VOD {video_id} is unavailable")
        } else {
            detail
        });
    }

    let payload: StreamlinkOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Streamlink returned invalid VOD data: {error}"))?;
    let author = metadata_string(&payload.metadata, "author");
    let title = metadata_string(&payload.metadata, "title");
    let category = metadata_string(&payload.metadata, "category");
    let source = payload
        .streams
        .into_values()
        .find_map(|stream| {
            if stream.stream_type != "hls" {
                return None;
            }
            let url = Url::parse(stream.master.as_deref()?).ok()?;
            safe_vod_resource_url(&url).then(|| VodSource {
                url,
                headers: vod_request_headers(stream.headers),
            })
        })
        .ok_or_else(|| format!("VOD {video_id} has no supported HLS playlist"))?;

    Ok(PreparedVod {
        video_id,
        author,
        title,
        category,
        start_seconds,
        source,
    })
}

fn vod_request_headers(headers: HashMap<String, String>) -> HeaderMap {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        if matches!(
            name,
            header::HOST | header::CONNECTION | header::CONTENT_LENGTH | header::ACCEPT_ENCODING
        ) {
            continue;
        }
        if let Ok(value) = HeaderValue::from_str(&value) {
            result.insert(name, value);
        }
    }
    result
}

async fn start_proxy(upstream_url: String) -> Result<(String, oneshot::Sender<()>), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("Could not create the local stream relay: {error}"))?;

    let target = Arc::new(LiveProxyTarget {
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

async fn relay_stream(AxumState(target): AxumState<Arc<LiveProxyTarget>>) -> Response {
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

async fn start_vod_proxy(source: VodSource) -> Result<(String, oneshot::Sender<()>), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not create the local VOD relay: {error}"))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not bind the local VOD relay: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the VOD relay address: {error}"))?;
    let mut token_bytes = [0_u8; 16];
    getrandom::fill(&mut token_bytes)
        .map_err(|error| format!("Could not secure the local VOD relay: {error}"))?;
    let token = format!("{:032x}", u128::from_le_bytes(token_bytes));
    let initial_url = source.url.as_str().to_string();
    let resources = HashMap::from([("0".to_string(), source)]);
    let ids_by_url = HashMap::from([(initial_url, "0".to_string())]);

    let target = Arc::new(VodProxyTarget {
        client,
        token: token.clone(),
        resources: Arc::new(Mutex::new(VodResourceRegistry {
            next_id: 1,
            resources,
            ids_by_url,
        })),
    });
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::OPTIONS])
        .allow_headers(Any)
        .expose_headers(Any);
    let router = Router::new()
        .route("/{token}/resource/{id}", get(relay_vod_resource))
        .with_state(target)
        .layer(cors);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        let _ = server.await;
    });

    Ok((format!("http://{address}/{token}/resource/0"), shutdown_tx))
}

async fn relay_vod_resource(
    AxumState(target): AxumState<Arc<VodProxyTarget>>,
    AxumPath((token, id)): AxumPath<(String, String)>,
    request_headers: HeaderMap,
) -> Response {
    if token != target.token {
        return StatusCode::NOT_FOUND.into_response();
    }
    let source = match target.resources.lock() {
        Ok(resources) => resources.resources.get(&id).cloned(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Some(source) = source else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let range = request_headers.get(header::RANGE).cloned();
    let mut final_source = source.clone();
    let mut redirects = 0;
    let mut upstream = loop {
        let mut request = target
            .client
            .get(final_source.url.clone())
            .headers(final_source.headers.clone());
        if let Some(range) = &range {
            request = request.header(header::RANGE, range);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("VOD relay connection failed: {error}"),
                )
                    .into_response();
            }
        };
        if !response.status().is_redirection() {
            break response;
        }
        let next_url = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|location| final_source.url.join(location).ok());
        let Some(next_url) = next_url.filter(safe_vod_resource_url) else {
            return (
                StatusCode::BAD_GATEWAY,
                "VOD resource redirected to an unsafe URL",
            )
                .into_response();
        };
        redirects += 1;
        if redirects > 5 {
            return (
                StatusCode::BAD_GATEWAY,
                "VOD resource redirected too many times",
            )
                .into_response();
        }
        final_source.url = next_url;
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let is_playlist = final_source
        .url
        .path()
        .to_ascii_lowercase()
        .ends_with(".m3u8")
        || upstream_headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("mpegurl"));

    if status.is_success() && is_playlist {
        const MAX_PLAYLIST_SIZE: usize = 8 * 1024 * 1024;
        if upstream
            .content_length()
            .is_some_and(|length| length > MAX_PLAYLIST_SIZE as u64)
        {
            return (StatusCode::BAD_GATEWAY, "VOD playlist is too large").into_response();
        }
        let mut bytes = Vec::new();
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_PLAYLIST_SIZE => {
                    bytes.extend_from_slice(&chunk);
                }
                Ok(Some(_)) => {
                    return (StatusCode::BAD_GATEWAY, "VOD playlist is too large").into_response();
                }
                Ok(None) => break,
                Err(error) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        format!("Could not read the VOD playlist: {error}"),
                    )
                        .into_response();
                }
            }
        }
        let Ok(playlist) = std::str::from_utf8(&bytes) else {
            return (StatusCode::BAD_GATEWAY, "VOD playlist is not valid UTF-8").into_response();
        };
        let rewritten = match target.resources.lock() {
            Ok(mut resources) => {
                rewrite_vod_playlist(playlist, &final_source, &target.token, &mut resources)
            }
            Err(_) => Err("VOD resource state is unavailable".to_string()),
        };
        return match rewritten {
            Ok(playlist) => Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(playlist))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
            Err(error) => (StatusCode::BAD_GATEWAY, error).into_response(),
        };
    }

    let mut response = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn rewrite_vod_playlist(
    playlist: &str,
    source: &VodSource,
    token: &str,
    resources: &mut VodResourceRegistry,
) -> Result<String, String> {
    let mut output = String::with_capacity(playlist.len() + 256);
    for line in playlist.lines() {
        let line = if line.starts_with('#') {
            rewrite_vod_uri_attributes(line, source, token, resources)?
        } else if line.trim().is_empty() {
            String::new()
        } else {
            register_vod_uri(line.trim(), source, token, resources)?
        };
        output.push_str(&line);
        output.push('\n');
    }
    Ok(output)
}

fn rewrite_vod_uri_attributes(
    line: &str,
    source: &VodSource,
    token: &str,
    resources: &mut VodResourceRegistry,
) -> Result<String, String> {
    let mut output = String::with_capacity(line.len());
    let mut remaining = line;
    while let Some(index) = remaining.find("URI=\"") {
        let value_start = index + 5;
        output.push_str(&remaining[..value_start]);
        let after_start = &remaining[value_start..];
        let Some(value_end) = after_start.find('"') else {
            return Err("VOD playlist contains an invalid URI attribute".to_string());
        };
        output.push_str(&register_vod_uri(
            &after_start[..value_end],
            source,
            token,
            resources,
        )?);
        remaining = &after_start[value_end..];
    }
    output.push_str(remaining);
    Ok(output)
}

fn register_vod_uri(
    uri: &str,
    source: &VodSource,
    token: &str,
    resources: &mut VodResourceRegistry,
) -> Result<String, String> {
    let url = source
        .url
        .join(uri)
        .map_err(|_| "VOD playlist contains an invalid resource URL".to_string())?;
    if !safe_vod_resource_url(&url) {
        return Err("VOD playlist contains an unsafe resource URL".to_string());
    }
    let key = url.as_str().to_string();
    let id = if let Some(id) = resources.ids_by_url.get(&key) {
        id.clone()
    } else {
        if resources.resources.len() >= 50_000 {
            return Err("VOD playlist contains too many resources".to_string());
        }
        let id = resources.next_id.to_string();
        resources.next_id += 1;
        resources.resources.insert(
            id.clone(),
            VodSource {
                url,
                headers: source.headers.clone(),
            },
        );
        resources.ids_by_url.insert(key, id.clone());
        id
    };
    Ok(format!("/{token}/resource/{id}"))
}

fn safe_vod_resource_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    host != "localhost"
        && !host.ends_with(".localhost")
        && host.parse::<std::net::IpAddr>().is_err()
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
    let mut command = hidden_command(&PathBuf::from(streamlink));
    Some(
        command
            .args(["-m", "streamlink_cli"])
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
    if quality == "source" {
        return i32::MAX;
    }
    if matches!(quality, "audio" | "audio_only") {
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
    if let Some(mut child) = stream.child.take() {
        terminate_child(&mut child);
    }
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
            start_vod,
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
            twitch::get_followed_channels,
            twitch::get_available_emotes
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
    use super::{
        VodResourceRegistry, VodSource, normalize_channel, parse_twitch_vod, parse_vod_time,
        quality_score, rewrite_vod_playlist, safe_vod_resource_url,
    };
    use axum::http::HeaderMap;
    use reqwest::Url;

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
        assert!(quality_score("source") > quality_score("1080p60"));
        assert_eq!(quality_score("audio"), quality_score("audio_only"));
    }

    #[test]
    fn parses_twitch_vod_links_and_offsets() {
        assert_eq!(
            parse_twitch_vod("https://www.twitch.tv/videos/123456?t=1h2m3s").unwrap(),
            ("123456".to_string(), 3723)
        );
        assert_eq!(
            parse_twitch_vod("twitch.tv/example/v/987654").unwrap(),
            ("987654".to_string(), 0)
        );
        assert_eq!(
            parse_twitch_vod("https://player.twitch.tv/?video=v456789&parent=twitch.tv").unwrap(),
            ("456789".to_string(), 0)
        );
        assert_eq!(parse_vod_time("90m5s").unwrap(), 5405);
    }

    #[test]
    fn rejects_non_twitch_and_malformed_vod_links() {
        assert!(parse_twitch_vod("https://example.com/videos/123456").is_err());
        assert!(parse_twitch_vod("https://www.twitch.tv/videos/not-a-number").is_err());
        assert!(parse_twitch_vod("https://www.twitch.tv/example").is_err());
        assert!(parse_twitch_vod("http://www.twitch.tv/videos/123456").is_err());
        assert!(parse_vod_time("1h30").is_err());
    }

    #[test]
    fn rewrites_vod_playlist_resources_behind_the_session_path() {
        let source = VodSource {
            url: Url::parse("https://vod.example.test/path/master.m3u8?token=one").unwrap(),
            headers: HeaderMap::new(),
        };
        let mut resources = VodResourceRegistry {
            next_id: 0,
            resources: Default::default(),
            ids_by_url: Default::default(),
        };
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo/index.m3u8\n";
        let rewritten = rewrite_vod_playlist(playlist, &source, "secret", &mut resources).unwrap();

        assert!(rewritten.contains("URI=\"/secret/resource/0\""));
        assert!(rewritten.contains("/secret/resource/1"));
        assert_eq!(resources.resources.len(), 2);
        assert!(
            resources
                .ids_by_url
                .contains_key("https://vod.example.test/path/audio/index.m3u8")
        );
        assert!(
            resources
                .ids_by_url
                .contains_key("https://vod.example.test/path/video/index.m3u8")
        );
    }

    #[test]
    fn rejects_unsafe_vod_playlist_resources() {
        let source = VodSource {
            url: Url::parse("https://vod.example.test/path/master.m3u8").unwrap(),
            headers: HeaderMap::new(),
        };
        let mut resources = VodResourceRegistry {
            next_id: 0,
            resources: Default::default(),
            ids_by_url: Default::default(),
        };
        assert!(
            rewrite_vod_playlist(
                "#EXTM3U\nhttps://127.0.0.1/private\n",
                &source,
                "secret",
                &mut resources,
            )
            .is_err()
        );
        assert!(!safe_vod_resource_url(
            &Url::parse("https://[::1]/private").unwrap()
        ));
        assert!(!safe_vod_resource_url(
            &Url::parse("https://localhost/private").unwrap()
        ));
        assert!(!safe_vod_resource_url(
            &Url::parse("https://vod.example.test:8443/private").unwrap()
        ));
        assert!(safe_vod_resource_url(
            &Url::parse("https://vod.example.test/private").unwrap()
        ));
    }
}

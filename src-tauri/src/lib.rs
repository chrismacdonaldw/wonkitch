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
use std::io::Read;
#[cfg(windows)]
use std::io::Write;
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
const STREAMLINK_RESOURCE: &str = "streamlink/8.6.2-1/Python/pythonw.exe";
const STREAMLINK_RUNNER_ARGUMENT: &str = "--wonkitch-streamlink-runner";
const UNKNOWN_AD_DURATION: Duration = Duration::from_secs(360);
const MAX_AD_DURATION: Duration = Duration::from_secs(600);
const AD_GRACE: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamStatusSnapshot {
    session_id: u64,
    ad_break: bool,
    ad_remaining_seconds: Option<u64>,
    event: Option<&'static str>,
    revision: u64,
}

struct StreamStatus {
    session_id: u64,
    ad_started: Option<Instant>,
    ad_deadline: Option<Instant>,
    ad_expected_end: Option<Instant>,
    duration_hint: Option<(Duration, Instant)>,
    event: Option<&'static str>,
    revision: u64,
}

impl StreamStatus {
    fn new(session_id: u64) -> Self {
        Self {
            session_id,
            ad_started: None,
            ad_deadline: None,
            ad_expected_end: None,
            duration_hint: None,
            event: None,
            revision: 0,
        }
    }

    fn record(&mut self, event: &'static str) {
        self.event = Some(event);
        self.revision = self.revision.saturating_add(1);
    }

    fn end_ad(&mut self, event: &'static str) {
        self.ad_started = None;
        self.ad_deadline = None;
        self.ad_expected_end = None;
        self.duration_hint = None;
        self.record(event);
    }

    fn expire(&mut self, now: Instant) {
        if self.ad_deadline.is_some_and(|deadline| now >= deadline) {
            self.end_ad("ad-expired");
        }
    }

    fn begin_ad(&mut self, now: Instant) {
        self.expire(now);
        if self.ad_started.is_some() {
            return;
        }
        let duration = self
            .duration_hint
            .filter(|(_, announced)| {
                now.saturating_duration_since(*announced) <= Duration::from_secs(60)
            })
            .map(|(duration, _)| duration);
        self.ad_started = Some(now);
        self.ad_expected_end = duration.map(|duration| now + duration);
        self.ad_deadline = Some(now + duration.unwrap_or(UNKNOWN_AD_DURATION) + AD_GRACE);
        self.record("ad-start");
    }

    fn inspect_line(&mut self, line: &str, now: Instant) {
        self.expire(now);
        if let Some(message) = line.strip_prefix("[wonkitch:plugins.twitch:info] ") {
            if message == "Waiting for pre-roll ads to finish, be patient" {
                self.begin_ad(now);
            } else if let Some(duration) = message
                .strip_prefix("Detected advertisement break of ")
                .and_then(|message| {
                    message
                        .strip_suffix(" seconds")
                        .or_else(|| message.strip_suffix(" second"))
                })
                .filter(|number| {
                    !number.is_empty()
                        && number.len() <= 10
                        && number.bytes().all(|byte| byte.is_ascii_digit())
                })
                .and_then(|number| number.parse::<u64>().ok())
                .filter(|duration| *duration > 0)
                .map(|duration| Duration::from_secs(duration).min(MAX_AD_DURATION))
            {
                self.duration_hint = Some((duration, now));
                if let Some(started) = self.ad_started {
                    let expected_end = (now + duration).min(started + MAX_AD_DURATION);
                    self.ad_expected_end = Some(expected_end);
                    self.ad_deadline = Some(expected_end + AD_GRACE);
                    self.record("ad-start");
                }
            }
        } else if let Some(message) = line.strip_prefix("[wonkitch:stream.hls:info] ") {
            match message {
                "Filtering out segments and pausing stream output" => self.begin_ad(now),
                "Resuming stream output" => self.end_ad("ad-end"),
                _ => {}
            }
        } else if line
            == "[wonkitch:stream.hls:warning] Encountered a stream discontinuity. This is unsupported and will result in incoherent output data."
        {
            self.record("discontinuity");
        } else if line == "[wonkitch:cli:info] Stream ended" {
            self.end_ad("stream-ended");
        }
    }

    fn snapshot(&mut self, now: Instant) -> StreamStatusSnapshot {
        self.expire(now);
        StreamStatusSnapshot {
            session_id: self.session_id,
            ad_break: self.ad_started.is_some(),
            ad_remaining_seconds: self.ad_expected_end.map(|end| {
                end.saturating_duration_since(now)
                    .as_secs()
                    .saturating_add(u64::from(
                        end > now && end.saturating_duration_since(now).subsec_nanos() > 0,
                    ))
            }),
            event: self.event,
            revision: self.revision,
        }
    }
}

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
    status: Arc<Mutex<StreamStatus>>,
    child: Option<ManagedChild>,
    proxy_shutdown: Option<oneshot::Sender<()>>,
}

struct PreparedStream {
    status: Arc<Mutex<StreamStatus>>,
    child: Option<ManagedChild>,
    source: StreamSource,
    channel: String,
    quality: String,
    qualities: Vec<String>,
    title: String,
    category: String,
}

enum StreamSource {
    MpegTs(String),
    Hls(HlsSource),
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum StreamTransport {
    #[default]
    MpegTs,
    Hls,
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
    status: Arc<Mutex<StreamStatus>>,
    idle_timeout: Duration,
}

#[derive(Clone)]
struct HlsProxyTarget {
    client: reqwest::Client,
    token: String,
    resources: Arc<Mutex<HlsResourceRegistry>>,
}

#[derive(Clone)]
struct HlsSource {
    url: Url,
    headers: HeaderMap,
}

struct HlsResourceRegistry {
    next_id: u64,
    resources: HashMap<String, HlsSource>,
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
    url: Option<String>,
    master: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamInfo {
    session_id: u64,
    url: String,
    channel: String,
    quality: String,
    qualities: Vec<String>,
    title: String,
    category: String,
    transport: StreamTransport,
}

struct PreparedVod {
    video_id: String,
    author: String,
    title: String,
    category: String,
    start_seconds: u64,
    source: HlsSource,
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
    transport: Option<StreamTransport>,
    state: tauri::State<'_, StreamState>,
) -> Result<StreamInfo, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let streamlink = find_streamlink(&app)?;
    let transport = transport.unwrap_or_default();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_stream(
            normalize_channel(&channel)?,
            quality,
            transport,
            streamlink,
            generation,
        )
    })
    .await
    .map_err(|error| format!("Stream worker failed: {error}"))??;

    if state.generation.load(Ordering::SeqCst) != generation {
        terminate_stream(ActiveStream {
            status: prepared.status,
            child: prepared.child,
            proxy_shutdown: None,
        });
        return Err("Stream request was superseded".to_string());
    }

    let proxy_result = match prepared.source {
        StreamSource::MpegTs(url) => start_proxy(url, prepared.status.clone()).await,
        StreamSource::Hls(source) => start_hls_proxy(source).await,
    };
    let (proxy_url, proxy_shutdown) = match proxy_result {
        Ok(proxy) => proxy,
        Err(error) => {
            if let Some(mut child) = prepared.child {
                terminate_child(&mut child);
            }
            return Err(error);
        }
    };

    if state.generation.load(Ordering::SeqCst) != generation {
        terminate_stream(ActiveStream {
            status: prepared.status,
            child: prepared.child,
            proxy_shutdown: Some(proxy_shutdown),
        });
        return Err("Stream request was superseded".to_string());
    }

    let info = StreamInfo {
        session_id: generation,
        url: proxy_url,
        channel: prepared.channel.clone(),
        quality: prepared.quality.clone(),
        qualities: prepared.qualities.clone(),
        title: prepared.title.clone(),
        category: prepared.category.clone(),
        transport,
    };

    let mut active = state
        .active
        .lock()
        .map_err(|_| "Stream state is unavailable".to_string())?;

    if state.generation.load(Ordering::SeqCst) != generation {
        drop(active);
        terminate_stream(ActiveStream {
            status: prepared.status,
            child: prepared.child,
            proxy_shutdown: Some(proxy_shutdown),
        });
        return Err("Stream request was superseded".to_string());
    }

    if let Some(previous) = active.take() {
        terminate_stream(previous);
    }

    *active = Some(ActiveStream {
        status: prepared.status,
        child: prepared.child,
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
    let (url, proxy_shutdown) = start_hls_proxy(source).await?;

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
        status: Arc::new(Mutex::new(StreamStatus::new(generation))),
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

#[tauri::command]
fn get_stream_status(
    state: tauri::State<'_, StreamState>,
) -> Result<Option<StreamStatusSnapshot>, String> {
    stream_status_snapshot(&state, Instant::now())
}

fn stream_status_snapshot(
    state: &StreamState,
    now: Instant,
) -> Result<Option<StreamStatusSnapshot>, String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "Stream state is unavailable".to_string())?;
    active
        .as_ref()
        .map(|stream| {
            stream
                .status
                .lock()
                .map_err(|_| "Stream status is unavailable".to_string())
                .map(|mut status| status.snapshot(now))
        })
        .transpose()
}

fn prepare_stream(
    channel: String,
    requested_quality: String,
    transport: StreamTransport,
    streamlink: PathBuf,
    session_id: u64,
) -> Result<PreparedStream, String> {
    let status = Arc::new(Mutex::new(StreamStatus::new(session_id)));
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
        None,
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

    if matches!(transport, StreamTransport::Hls) {
        let source = live_hls_source(&payload, &selected_quality)?;
        return Ok(PreparedStream {
            status,
            child: None,
            source: StreamSource::Hls(source),
            channel,
            quality: selected_quality,
            qualities,
            title: metadata_string(&payload.metadata, "title"),
            category: metadata_string(&payload.metadata, "category"),
        });
    }

    let port = reserve_port()?;
    let upstream_url = format!("http://127.0.0.1:{port}/");
    let port_argument = format!("--player-external-http-port={port}");

    let mut child = spawn_streamlink(
        &streamlink,
        &[
            "--no-config",
            "--no-plugin-sideloading",
            "--loglevel=info",
            "--logformat=[wonkitch:{name}:{levelname}] {message}",
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
        Some(status.clone()),
    )
    .map_err(|error| format!("Could not start Streamlink: {error}"))?;

    wait_for_server(&mut child.child, port).inspect_err(|_| {
        terminate_child(&mut child);
    })?;

    Ok(PreparedStream {
        status,
        child: Some(child),
        source: StreamSource::MpegTs(upstream_url),
        channel,
        quality: selected_quality,
        qualities,
        title: metadata_string(&payload.metadata, "title"),
        category: metadata_string(&payload.metadata, "category"),
    })
}

fn live_hls_source(payload: &StreamlinkOutput, quality: &str) -> Result<HlsSource, String> {
    let stream = payload
        .streams
        .get(quality)
        .filter(|stream| stream.stream_type == "hls")
        .ok_or_else(|| format!("{quality} has no supported HLS stream"))?;
    // Use the selected rendition, rather than the master, to preserve quality
    // selection and Streamlink's H.264 codec negotiation for this WebView.
    let url = stream
        .url
        .as_deref()
        .and_then(|url| Url::parse(url).ok())
        .filter(safe_hls_resource_url)
        .ok_or_else(|| format!("{quality} has no safe HLS playlist URL"))?;
    Ok(HlsSource {
        url,
        headers: hls_request_headers(stream.headers.clone()),
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
        None,
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
            safe_hls_resource_url(&url).then(|| HlsSource {
                url,
                headers: hls_request_headers(stream.headers),
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

fn hls_request_headers(headers: HashMap<String, String>) -> HeaderMap {
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

fn live_proxy_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Could not create the local stream relay: {error}"))
}

async fn start_proxy(
    upstream_url: String,
    status: Arc<Mutex<StreamStatus>>,
) -> Result<(String, oneshot::Sender<()>), String> {
    let client = live_proxy_client()?;

    let target = Arc::new(LiveProxyTarget {
        client,
        upstream_url,
        status,
        idle_timeout: Duration::from_secs(20),
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
    let upstream = match tokio::time::timeout(
        target.idle_timeout,
        target.client.get(&target.upstream_url).send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Stream relay connection failed: {error}"),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "Stream relay connection failed: timed out",
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

    // A filtered ad deliberately produces no bytes. Keep that session's response
    // open, while still bounding unknown stalls and expiring stale ad reports.
    let chunks = futures_util::stream::unfold(Some(upstream), move |upstream| {
        let target = target.clone();
        async move {
            let mut upstream = upstream?;
            loop {
                match tokio::time::timeout(target.idle_timeout, upstream.chunk()).await {
                    Ok(Ok(Some(chunk))) => {
                        return Some((Ok::<_, std::io::Error>(chunk), Some(upstream)));
                    }
                    Ok(Ok(None)) => return None,
                    Ok(Err(error)) => return Some((Err(std::io::Error::other(error)), None)),
                    Err(_) => {
                        let ad_break = target
                            .status
                            .lock()
                            .map(|mut status| status.snapshot(Instant::now()).ad_break)
                            .unwrap_or(false);
                        if !ad_break {
                            return Some((
                                Err(std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "Stream relay stopped receiving data",
                                )),
                                None,
                            ));
                        }
                    }
                }
            }
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CACHE_CONTROL, "no-store, no-cache")
        .body(Body::from_stream(chunks))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn start_hls_proxy(source: HlsSource) -> Result<(String, oneshot::Sender<()>), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not create the local HLS relay: {error}"))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not bind the local HLS relay: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the HLS relay address: {error}"))?;
    let mut token_bytes = [0_u8; 16];
    getrandom::fill(&mut token_bytes)
        .map_err(|error| format!("Could not secure the local HLS relay: {error}"))?;
    let token = format!("{:032x}", u128::from_le_bytes(token_bytes));
    let initial_url = source.url.as_str().to_string();
    let resources = HashMap::from([("0".to_string(), source)]);
    let ids_by_url = HashMap::from([(initial_url, "0".to_string())]);

    let target = Arc::new(HlsProxyTarget {
        client,
        token: token.clone(),
        resources: Arc::new(Mutex::new(HlsResourceRegistry {
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
        .route("/{token}/resource/{id}", get(relay_hls_resource))
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

async fn relay_hls_resource(
    AxumState(target): AxumState<Arc<HlsProxyTarget>>,
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
                    format!("HLS relay connection failed: {error}"),
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
        let Some(next_url) = next_url.filter(safe_hls_resource_url) else {
            return (
                StatusCode::BAD_GATEWAY,
                "HLS resource redirected to an unsafe URL",
            )
                .into_response();
        };
        redirects += 1;
        if redirects > 5 {
            return (
                StatusCode::BAD_GATEWAY,
                "HLS resource redirected too many times",
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
            return (StatusCode::BAD_GATEWAY, "HLS playlist is too large").into_response();
        }
        let mut bytes = Vec::new();
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_PLAYLIST_SIZE => {
                    bytes.extend_from_slice(&chunk);
                }
                Ok(Some(_)) => {
                    return (StatusCode::BAD_GATEWAY, "HLS playlist is too large").into_response();
                }
                Ok(None) => break,
                Err(error) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        format!("Could not read the HLS playlist: {error}"),
                    )
                        .into_response();
                }
            }
        }
        let Ok(playlist) = std::str::from_utf8(&bytes) else {
            return (StatusCode::BAD_GATEWAY, "HLS playlist is not valid UTF-8").into_response();
        };
        let rewritten = match target.resources.lock() {
            Ok(mut resources) => {
                rewrite_hls_playlist(playlist, &final_source, &target.token, &mut resources)
            }
            Err(_) => Err("HLS resource state is unavailable".to_string()),
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

fn rewrite_hls_playlist(
    playlist: &str,
    source: &HlsSource,
    token: &str,
    resources: &mut HlsResourceRegistry,
) -> Result<String, String> {
    let mut output = String::with_capacity(playlist.len() + 256);
    for line in playlist.lines() {
        let line = if line.starts_with('#') {
            rewrite_hls_uri_attributes(line, source, token, resources)?
        } else if line.trim().is_empty() {
            String::new()
        } else {
            register_hls_uri(line.trim(), source, token, resources)?
        };
        output.push_str(&line);
        output.push('\n');
    }
    Ok(output)
}

fn rewrite_hls_uri_attributes(
    line: &str,
    source: &HlsSource,
    token: &str,
    resources: &mut HlsResourceRegistry,
) -> Result<String, String> {
    let mut output = String::with_capacity(line.len());
    let mut remaining = line;
    while let Some(index) = remaining.find("URI=\"") {
        let value_start = index + 5;
        output.push_str(&remaining[..value_start]);
        let after_start = &remaining[value_start..];
        let Some(value_end) = after_start.find('"') else {
            return Err("HLS playlist contains an invalid URI attribute".to_string());
        };
        output.push_str(&register_hls_uri(
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

fn register_hls_uri(
    uri: &str,
    source: &HlsSource,
    token: &str,
    resources: &mut HlsResourceRegistry,
) -> Result<String, String> {
    let url = source
        .url
        .join(uri)
        .map_err(|_| "HLS playlist contains an invalid resource URL".to_string())?;
    if !safe_hls_resource_url(&url) {
        return Err("HLS playlist contains an unsafe resource URL".to_string());
    }
    let key = url.as_str().to_string();
    let id = if let Some(id) = resources.ids_by_url.get(&key) {
        id.clone()
    } else {
        if resources.resources.len() >= 50_000 {
            return Err("HLS playlist contains too many resources".to_string());
        }
        let id = resources.next_id.to_string();
        resources.next_id += 1;
        resources.resources.insert(
            id.clone(),
            HlsSource {
                url,
                headers: source.headers.clone(),
            },
        );
        resources.ids_by_url.insert(key, id.clone());
        id
    };
    Ok(format!("/{token}/resource/{id}"))
}

fn safe_hls_resource_url(url: &Url) -> bool {
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
    status: Option<Arc<Mutex<StreamStatus>>>,
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

    if capture_output || status.is_some() {
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
    if let Some(status) = status {
        let pipes = Arc::new(AtomicU64::new(2));
        if let Some(stdout) = child.child.stdout.take() {
            let _ = monitor_streamlink_output(stdout, status.clone(), pipes.clone());
        }
        if let Some(stderr) = child.child.stderr.take() {
            let _ = monitor_streamlink_output(stderr, status, pipes);
        }
    }
    Ok(child)
}

fn monitor_streamlink_output(
    reader: impl Read + Send + 'static,
    status: Arc<Mutex<StreamStatus>>,
    pipes: Arc<AtomicU64>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        drain_streamlink_status(reader, &status);
        if pipes.fetch_sub(1, Ordering::SeqCst) == 1
            && let Ok(mut status) = status.lock()
        {
            status.end_ad("process-exit");
        }
    })
}

fn drain_streamlink_status(mut reader: impl Read, status: &Arc<Mutex<StreamStatus>>) {
    let mut chunk = [0_u8; 1024];
    let mut line = Vec::with_capacity(256);
    let mut oversized = false;
    let inspect = |line: &[u8]| {
        if let Ok(line) = std::str::from_utf8(line)
            && let Ok(mut status) = status.lock()
        {
            status.inspect_line(line.trim_end_matches('\r'), Instant::now());
        }
    };
    loop {
        let length = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(length) => length,
        };
        for byte in &chunk[..length] {
            if *byte == b'\n' {
                if !oversized {
                    inspect(&line);
                }
                line.clear();
                oversized = false;
            } else if line.len() < 1024 {
                line.push(*byte);
            } else {
                oversized = true;
            }
        }
    }
    if !oversized && !line.is_empty() {
        inspect(&line);
    }
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
            get_stream_status,
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
        AD_GRACE, ActiveStream, HlsResourceRegistry, HlsSource, LiveProxyTarget, MAX_AD_DURATION,
        StreamState, StreamStatus, StreamlinkOutput, UNKNOWN_AD_DURATION, drain_streamlink_status,
        live_hls_source, live_proxy_client, monitor_streamlink_output, normalize_channel,
        parse_twitch_vod, parse_vod_time, quality_score, relay_stream, rewrite_hls_playlist,
        safe_hls_resource_url, stream_status_snapshot,
    };
    use axum::{
        body::to_bytes,
        extract::State,
        http::{HeaderMap, StatusCode},
    };
    use reqwest::Url;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
            mpsc::{self, Receiver, Sender},
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    fn live_upstream(
        serve: impl FnOnce(&mut TcpStream, Receiver<()>) + Send + 'static,
    ) -> (String, Sender<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (done, finished) = mpsc::channel();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut connection = loop {
                match listener.accept() {
                    Ok((connection, _)) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "relay never connected");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("could not accept the relay: {error}"),
                }
            };
            connection
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            connection
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|value| value == b"\r\n\r\n") {
                let length = connection.read(&mut chunk).unwrap();
                assert!(length > 0, "relay closed before sending request headers");
                request.extend_from_slice(&chunk[..length]);
                assert!(request.len() < 16 * 1024);
            }
            serve(&mut connection, finished);
        });
        (url, done, worker)
    }

    fn relay_target(upstream_url: String, read_timeout: Duration) -> State<Arc<LiveProxyTarget>> {
        State(Arc::new(LiveProxyTarget {
            client: live_proxy_client().unwrap(),
            upstream_url,
            status: Arc::new(Mutex::new(StreamStatus::new(1))),
            idle_timeout: read_timeout,
        }))
    }

    #[test]
    fn stream_status_uses_only_exact_whitelisted_markers() {
        let now = Instant::now();
        let mut status = StreamStatus::new(12);
        for line in [
            "Filtering out segments and pausing stream output",
            "[wonkitch:other:info] Waiting for pre-roll ads to finish, be patient",
            "[wonkitch:plugins.twitch:info] Detected advertisement break of https://example.test/token seconds",
            "[wonkitch:plugins.twitch:info] Detected advertisement break of -5 seconds",
            "[wonkitch:plugins.twitch:info] Detected advertisement break of 0 seconds",
            "[wonkitch:stream.hls:info] Filtering out segments and pausing stream output: URL",
        ] {
            status.inspect_line(line, now);
        }
        let snapshot = status.snapshot(now);
        assert!(!snapshot.ad_break);
        assert_eq!(snapshot.revision, 0);
        status.inspect_line(
            "[wonkitch:plugins.twitch:info] Detected advertisement break of 90 seconds",
            now,
        );
        assert!(
            !status.snapshot(now).ad_break,
            "an announcement alone is not a pause"
        );
        status.inspect_line(
            "[wonkitch:stream.hls:info] Filtering out segments and pausing stream output",
            now,
        );
        let snapshot = status.snapshot(now + Duration::from_millis(500));
        assert_eq!(snapshot.session_id, 12);
        assert!(snapshot.ad_break);
        assert_eq!(snapshot.ad_remaining_seconds, Some(90));
        assert_eq!(snapshot.event, Some("ad-start"));
    }

    #[test]
    fn stream_status_bounds_unknown_and_overlong_ad_breaks() {
        let now = Instant::now();
        let mut status = StreamStatus::new(1);
        status.inspect_line(
            "[wonkitch:plugins.twitch:info] Waiting for pre-roll ads to finish, be patient",
            now,
        );
        assert!(status.snapshot(now).ad_break);
        assert_eq!(status.snapshot(now).ad_remaining_seconds, None);
        assert!(
            !status
                .snapshot(now + UNKNOWN_AD_DURATION + AD_GRACE)
                .ad_break
        );
        assert_eq!(status.event, Some("ad-expired"));
        status.inspect_line(
            "[wonkitch:plugins.twitch:info] Detected advertisement break of 999999 seconds",
            now,
        );
        status.begin_ad(now);
        assert_eq!(
            status.snapshot(now).ad_remaining_seconds,
            Some(MAX_AD_DURATION.as_secs())
        );
        status.inspect_line(
            "[wonkitch:plugins.twitch:info] Detected advertisement break of 999999 seconds",
            now + Duration::from_secs(500),
        );
        assert!(
            !status.snapshot(now + MAX_AD_DURATION + AD_GRACE).ad_break,
            "repeat reports cannot keep a stale break alive forever"
        );
    }

    #[test]
    fn stream_status_ignores_stale_duration_hints_and_clears_on_resume_or_eof() {
        let now = Instant::now();
        let mut status = StreamStatus::new(1);
        status.inspect_line(
            "[wonkitch:plugins.twitch:info] Detected advertisement break of 1 second",
            now,
        );
        status.begin_ad(now + Duration::from_secs(61));
        assert_eq!(
            status
                .snapshot(now + Duration::from_secs(61))
                .ad_remaining_seconds,
            None
        );
        status.inspect_line("[wonkitch:stream.hls:warning] Encountered a stream discontinuity. This is unsupported and will result in incoherent output data.", now + Duration::from_secs(62));
        assert_eq!(status.event, Some("discontinuity"));
        status.inspect_line(
            "[wonkitch:stream.hls:info] Resuming stream output",
            now + Duration::from_secs(62),
        );
        let snapshot = status.snapshot(now + Duration::from_secs(62));
        assert!(!snapshot.ad_break);
        assert_eq!(snapshot.event, Some("ad-end"));
        status.begin_ad(now + Duration::from_secs(63));
        status.inspect_line(
            "[wonkitch:cli:info] Stream ended",
            now + Duration::from_secs(64),
        );
        assert!(!status.snapshot(now + Duration::from_secs(64)).ad_break);
        assert_eq!(status.event, Some("stream-ended"));
    }

    #[test]
    fn stream_status_drain_discards_oversized_or_invalid_lines_and_raw_data() {
        let status = Arc::new(Mutex::new(StreamStatus::new(1)));
        let mut output = vec![b'x'; 100_000];
        output.extend_from_slice(
            b"[wonkitch:plugins.twitch:info] Waiting for pre-roll ads to finish, be patient\n",
        );
        output.extend_from_slice(b"\xff\nunknown URL https://example.test/?token=secret\n");
        output.extend_from_slice(b"[wonkitch:plugins.twitch:info] Detected advertisement break of 30 seconds\r\n[wonkitch:stream.hls:info] Filtering out segments and pausing stream output\n");
        drain_streamlink_status(std::io::Cursor::new(output), &status);
        let snapshot = status.lock().unwrap().snapshot(Instant::now());
        assert!(snapshot.ad_break);
        assert_eq!(snapshot.ad_remaining_seconds, Some(30));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("https"));
        assert!(!serialized.contains("secret"));
        assert_eq!(
            snapshot.revision, 1,
            "oversized lines must not activate the preroll marker"
        );
    }

    #[test]
    fn stream_status_follows_active_owner_even_while_new_request_is_preparing() {
        let now = Instant::now();
        let state = StreamState::default();
        assert!(stream_status_snapshot(&state, now).unwrap().is_none());
        let old = Arc::new(Mutex::new(StreamStatus::new(10)));
        old.lock().unwrap().begin_ad(now);
        *state.active.lock().unwrap() = Some(ActiveStream {
            status: old.clone(),
            child: None,
            proxy_shutdown: None,
        });
        state.generation.store(11, Ordering::SeqCst);
        assert_eq!(
            stream_status_snapshot(&state, now)
                .unwrap()
                .unwrap()
                .session_id,
            10
        );
        *state.active.lock().unwrap() = Some(ActiveStream {
            status: Arc::new(Mutex::new(StreamStatus::new(11))),
            child: None,
            proxy_shutdown: None,
        });
        old.lock().unwrap().end_ad("process-exit");
        let snapshot = stream_status_snapshot(&state, now).unwrap().unwrap();
        assert_eq!(snapshot.session_id, 11);
        assert!(!snapshot.ad_break);
        assert_eq!(snapshot.revision, 0);
    }

    #[test]
    fn stream_status_process_exit_waits_for_both_output_pipes() {
        let status = Arc::new(Mutex::new(StreamStatus::new(3)));
        let pipes = Arc::new(AtomicU64::new(2));
        monitor_streamlink_output(
            std::io::Cursor::new(
                b"[wonkitch:plugins.twitch:info] Waiting for pre-roll ads to finish, be patient\n",
            ),
            status.clone(),
            pipes.clone(),
        )
        .join()
        .unwrap();
        assert!(status.lock().unwrap().snapshot(Instant::now()).ad_break);
        monitor_streamlink_output(std::io::Cursor::new(b""), status.clone(), pipes)
            .join()
            .unwrap();
        let snapshot = status.lock().unwrap().snapshot(Instant::now());
        assert!(!snapshot.ad_break);
        assert_eq!(snapshot.event, Some("process-exit"));
    }

    #[test]
    fn live_relay_keeps_quiet_known_ad_response_until_content_resumes() {
        let (url, _done, worker) = live_upstream(|connection, _| {
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n")
                .unwrap();
            connection.flush().unwrap();
            thread::sleep(Duration::from_millis(350));
            connection.write_all(b"1\r\ny\r\n0\r\n\r\n").unwrap();
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let target = relay_target(url, Duration::from_millis(50));
                target.0.status.lock().unwrap().begin_ad(Instant::now());
                let response = relay_stream(target).await;
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(
                    &to_bytes(response.into_body(), 1024).await.unwrap()[..],
                    b"xy"
                );
            });
        worker.join().unwrap();
    }

    #[test]
    fn live_relay_stale_ad_status_does_not_preserve_stalled_response_forever() {
        let (url, done, worker) = live_upstream(|connection, finished| {
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n")
                .unwrap();
            connection.flush().unwrap();
            let _ = finished.recv_timeout(Duration::from_secs(3));
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let target = relay_target(url, Duration::from_millis(50));
                let status = target.0.status.clone();
                {
                    let mut status = status.lock().unwrap();
                    status.begin_ad(Instant::now());
                    status.ad_deadline = Some(Instant::now() + Duration::from_millis(225));
                }
                let start = Instant::now();
                let response = relay_stream(target).await;
                assert!(to_bytes(response.into_body(), 1024).await.is_err());
                assert!(start.elapsed() >= Duration::from_millis(225));
                assert!(start.elapsed() < Duration::from_secs(2));
                assert_eq!(status.lock().unwrap().event, Some("ad-expired"));
            });
        let _ = done.send(());
        worker.join().unwrap();
    }

    #[test]
    fn live_relay_times_out_upstream_that_never_sends_headers() {
        let (url, done, worker) = live_upstream(|_, finished| {
            let _ = finished.recv_timeout(Duration::from_secs(3));
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let start = Instant::now();
                let response = relay_stream(relay_target(url, Duration::from_millis(100))).await;
                assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                assert!(String::from_utf8_lossy(&body).contains("Stream relay connection failed"));
                assert!(start.elapsed() < Duration::from_secs(2));
            });
        let _ = done.send(());
        worker.join().unwrap();
    }

    #[test]
    fn live_relay_ends_a_stalled_response_body_with_an_error() {
        let (url, done, worker) = live_upstream(|connection, finished| {
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n")
                .unwrap();
            connection.flush().unwrap();
            let _ = finished.recv_timeout(Duration::from_secs(3));
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let start = Instant::now();
                let response = relay_stream(relay_target(url, Duration::from_millis(100))).await;
                assert_eq!(response.status(), StatusCode::OK);
                assert!(to_bytes(response.into_body(), 1024).await.is_err());
                assert!(start.elapsed() < Duration::from_secs(2));
            });
        let _ = done.send(());
        worker.join().unwrap();
    }

    #[test]
    fn live_relay_allows_continuous_chunks_beyond_its_read_timeout() {
        let (url, _done, worker) = live_upstream(|connection, _| {
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            for _ in 0..14 {
                connection.write_all(b"1\r\nx\r\n").unwrap();
                connection.flush().unwrap();
                thread::sleep(Duration::from_millis(75));
            }
            connection.write_all(b"0\r\n\r\n").unwrap();
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let timeout = Duration::from_millis(500);
                let start = Instant::now();
                let response = relay_stream(relay_target(url, timeout)).await;
                assert_eq!(response.status(), StatusCode::OK);
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                assert_eq!(&body[..], b"xxxxxxxxxxxxxx");
                assert!(start.elapsed() > timeout * 2);
            });
        worker.join().unwrap();
    }

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
    fn live_hls_uses_the_selected_rendition_and_preserves_request_headers() {
        let payload: StreamlinkOutput = serde_json::from_value(serde_json::json!({
            "streams": {
                "best": {
                    "type": "hls",
                    "url": "https://playlist.ttvnw.net/source.m3u8?token=best",
                    "master": "https://usher.ttvnw.net/master.m3u8"
                },
                "720p60": {
                    "type": "hls",
                    "url": "https://playlist.ttvnw.net/720.m3u8?token=selected",
                    "master": "https://usher.ttvnw.net/master.m3u8",
                    "headers": { "Referer": "https://www.twitch.tv/", "Host": "wrong.test" }
                }
            }
        }))
        .unwrap();
        let source = live_hls_source(&payload, "720p60").unwrap();
        assert_eq!(
            source.url.as_str(),
            "https://playlist.ttvnw.net/720.m3u8?token=selected"
        );
        assert_eq!(source.headers["referer"], "https://www.twitch.tv/");
        assert!(!source.headers.contains_key("host"));
        assert_eq!(
            live_hls_source(&payload, "best").unwrap().url.path(),
            "/source.m3u8"
        );
        assert!(live_hls_source(&payload, "480p").is_err());
    }

    #[test]
    fn live_hls_rejects_unsafe_or_non_hls_renditions() {
        for (stream_type, url) in [
            ("hls", "https://127.0.0.1/private"),
            ("hls", "http://playlist.ttvnw.net/live.m3u8"),
            ("http", "https://playlist.ttvnw.net/live.m3u8"),
        ] {
            let payload: StreamlinkOutput = serde_json::from_value(serde_json::json!({
                "streams": { "best": { "type": stream_type, "url": url } }
            }))
            .unwrap();
            assert!(live_hls_source(&payload, "best").is_err());
        }
    }

    #[test]
    fn rewrites_live_fragmented_mp4_initialization_and_segments() {
        let source = HlsSource {
            url: Url::parse("https://video.ttvnw.net/live/index.m3u8").unwrap(),
            headers: HeaderMap::new(),
        };
        let mut resources = HlsResourceRegistry {
            next_id: 0,
            resources: Default::default(),
            ids_by_url: Default::default(),
        };
        let playlist = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1234\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\n1234.mp4\n";
        let rewritten = rewrite_hls_playlist(playlist, &source, "secret", &mut resources).unwrap();
        assert!(rewritten.contains("#EXT-X-MAP:URI=\"/secret/resource/0\""));
        assert!(rewritten.contains("#EXT-X-MEDIA-SEQUENCE:1234"));
        assert!(rewritten.ends_with("/secret/resource/1\n"));
        assert_eq!(resources.resources["0"].url.path(), "/live/init.mp4");
        assert_eq!(resources.resources["1"].url.path(), "/live/1234.mp4");
        rewrite_hls_playlist(playlist, &source, "secret", &mut resources).unwrap();
        assert_eq!(resources.resources.len(), 2);
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
        let source = HlsSource {
            url: Url::parse("https://vod.example.test/path/master.m3u8?token=one").unwrap(),
            headers: HeaderMap::new(),
        };
        let mut resources = HlsResourceRegistry {
            next_id: 0,
            resources: Default::default(),
            ids_by_url: Default::default(),
        };
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo/index.m3u8\n";
        let rewritten = rewrite_hls_playlist(playlist, &source, "secret", &mut resources).unwrap();

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
        let source = HlsSource {
            url: Url::parse("https://vod.example.test/path/master.m3u8").unwrap(),
            headers: HeaderMap::new(),
        };
        let mut resources = HlsResourceRegistry {
            next_id: 0,
            resources: Default::default(),
            ids_by_url: Default::default(),
        };
        assert!(
            rewrite_hls_playlist(
                "#EXTM3U\nhttps://127.0.0.1/private\n",
                &source,
                "secret",
                &mut resources,
            )
            .is_err()
        );
        assert!(!safe_hls_resource_url(
            &Url::parse("https://[::1]/private").unwrap()
        ));
        assert!(!safe_hls_resource_url(
            &Url::parse("https://localhost/private").unwrap()
        ));
        assert!(!safe_hls_resource_url(
            &Url::parse("https://vod.example.test:8443/private").unwrap()
        ));
        assert!(safe_hls_resource_url(
            &Url::parse("https://vod.example.test/private").unwrap()
        ));
    }
}

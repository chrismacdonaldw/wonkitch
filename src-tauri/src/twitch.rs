use keyring::{Entry, Error as KeyringError};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const ACCESS_TOKEN_KEY: &str = "twitch-access-token";
const REFRESH_TOKEN_KEY: &str = "twitch-refresh-token";
const DEFAULT_TWITCH_CLIENT_ID: &str = "8pcv3di8jhgqgin1awujsm4ogwz73o";
const CHAT_SCOPES: &str = "user:write:chat";
const LOGIN_SCOPES: &str = "user:write:chat user:read:follows user:read:emotes";
const FOLLOWING_SCOPE: &str = "user:read:follows";
const EMOTES_SCOPE: &str = "user:read:emotes";
const VALIDATION_INTERVAL: u64 = 50 * 60;

pub struct TwitchState {
    client: Client,
    settings_path: PathBuf,
    inner: Mutex<TwitchAuth>,
}

struct TwitchAuth {
    settings: TwitchSettings,
    access_token: Option<String>,
    refresh_token: Option<String>,
    pending: Option<PendingLogin>,
    login_generation: u64,
    validated_at: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct TwitchSettings {
    version: u8,
    client_id: String,
    username: Option<String>,
    user_id: Option<String>,
    token_expires_at: Option<u64>,
    last_validated_at: Option<u64>,
    scopes: Vec<String>,
}

impl Default for TwitchSettings {
    fn default() -> Self {
        Self {
            version: 3,
            client_id: String::new(),
            username: None,
            user_id: None,
            token_expires_at: None,
            last_validated_at: None,
            scopes: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct PendingLogin {
    id: u64,
    device_code: String,
    expires_at: u64,
    scopes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchAuthStatus {
    configured: bool,
    logged_in: bool,
    client_id: Option<String>,
    username: Option<String>,
    follows_connected: bool,
    emotes_connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    login_id: u64,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum DevicePoll {
    Pending { retry_after: u64 },
    Complete { account: TwitchAuthStatus },
}

#[derive(Deserialize)]
struct DeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    scope: Vec<String>,
}

#[derive(Deserialize)]
struct ValidateResponse {
    client_id: String,
    login: String,
    user_id: String,
    scopes: Vec<String>,
    expires_in: u64,
}

#[derive(Serialize)]
struct SendChatBody<'a> {
    broadcaster_id: &'a str,
    sender_id: &'a str,
    message: &'a str,
}

#[derive(Deserialize)]
struct SendChatResponse {
    data: Vec<SendChatResult>,
}

#[derive(Deserialize)]
struct SendChatResult {
    is_sent: bool,
    drop_reason: Option<DropReason>,
}

#[derive(Deserialize)]
struct DropReason {
    message: String,
}

#[derive(Deserialize)]
struct TwitchError {
    message: Option<String>,
    error: Option<String>,
}

struct ChatCredentials {
    client_id: String,
    access_token: String,
    user_id: String,
    scopes: Vec<String>,
    generation: u64,
}

#[derive(Deserialize)]
struct Pagination {
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct FollowedStreamsResponse {
    data: Vec<FollowedStreamApi>,
    pagination: Pagination,
}

#[derive(Deserialize)]
struct FollowedStreamApi {
    user_id: String,
    user_login: String,
    user_name: String,
    title: String,
    game_name: String,
    viewer_count: u64,
    thumbnail_url: String,
}

#[derive(Deserialize)]
struct UserEmotesResponse {
    data: Vec<UserEmoteApi>,
    template: String,
    pagination: Pagination,
}

#[derive(Deserialize)]
struct UserEmoteApi {
    id: String,
    name: String,
    emote_type: String,
    format: Vec<String>,
    scale: Vec<String>,
    theme_mode: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableEmote {
    name: String,
    url: String,
    provider: &'static str,
    category: String,
    zero_width: bool,
    overlay_x: i8,
    overlay_y: i8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowedChannel {
    id: String,
    login: String,
    display_name: String,
    is_live: bool,
    title: String,
    category: String,
    viewer_count: u64,
    thumbnail_url: String,
}

enum FollowingError {
    Unauthorized,
    Message(String),
}

enum ValidationError {
    Unauthorized(String),
    Other(String),
}

impl ValidationError {
    fn into_message(self) -> String {
        match self {
            Self::Unauthorized(message) | Self::Other(message) => message,
        }
    }
}

impl TwitchState {
    pub fn load(settings_path: PathBuf) -> Self {
        let mut settings = load_settings(&settings_path);
        settings.version = 3;
        if settings.client_id.is_empty() {
            let client_id =
                option_env!("WONKITCH_TWITCH_CLIENT_ID").unwrap_or(DEFAULT_TWITCH_CLIENT_ID);
            if valid_client_id(client_id) {
                settings.client_id = client_id.to_string();
            }
        }

        let access_token = load_secret(ACCESS_TOKEN_KEY).unwrap_or_else(|error| {
            eprintln!("Could not read the Twitch access token: {error}");
            None
        });
        let refresh_token = load_secret(REFRESH_TOKEN_KEY).unwrap_or_else(|error| {
            eprintln!("Could not read the Twitch refresh token: {error}");
            None
        });
        let client = Client::builder()
            .user_agent("wonkitch/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("could not create Twitch HTTP client");

        Self {
            client,
            settings_path,
            inner: Mutex::new(TwitchAuth {
                settings,
                access_token,
                refresh_token,
                pending: None,
                login_generation: 0,
                validated_at: None,
            }),
        }
    }
}

#[tauri::command]
pub async fn get_twitch_auth_status(
    state: tauri::State<'_, TwitchState>,
) -> Result<TwitchAuthStatus, String> {
    let mut auth = state.inner.lock().await;
    if auth.settings.username.is_some()
        && auth.settings.user_id.is_some()
        && (auth.access_token.is_some() || auth.refresh_token.is_some())
    {
        ensure_auth(&state.client, &state.settings_path, &mut auth, false).await?;
    }
    Ok(auth_status(&auth))
}

#[tauri::command]
pub async fn configure_twitch_client(
    client_id: String,
    state: tauri::State<'_, TwitchState>,
) -> Result<TwitchAuthStatus, String> {
    let client_id = client_id.trim();
    if !valid_client_id(client_id) {
        return Err("Enter the Client ID from a Twitch Public application".to_string());
    }

    let mut auth = state.inner.lock().await;
    if auth.settings.client_id != client_id {
        delete_tokens()?;
        auth.access_token = None;
        auth.refresh_token = None;
        auth.pending = None;
        auth.login_generation = auth.login_generation.wrapping_add(1);
        auth.validated_at = None;
        auth.settings.username = None;
        auth.settings.user_id = None;
        auth.settings.token_expires_at = None;
        auth.settings.last_validated_at = None;
        auth.settings.scopes.clear();
        auth.settings.client_id = client_id.to_string();
    }
    save_settings(&state.settings_path, &auth.settings)?;
    Ok(auth_status(&auth))
}

#[tauri::command]
pub async fn begin_twitch_login(
    state: tauri::State<'_, TwitchState>,
) -> Result<DeviceLogin, String> {
    let (client_id, login_id) = {
        let mut auth = state.inner.lock().await;
        let client_id = configured_client_id(&auth)?;
        auth.login_generation = auth.login_generation.wrapping_add(1);
        auth.pending = None;
        (client_id, auth.login_generation)
    };
    let scopes = LOGIN_SCOPES;
    let response = state
        .client
        .post("https://id.twitch.tv/oauth2/device")
        .form(&[("client_id", client_id.as_str()), ("scopes", scopes)])
        .send()
        .await
        .map_err(|error| format!("Could not start Twitch login: {error}"))?;

    if !response.status().is_success() {
        return Err(response_error(response, "Twitch rejected the login request").await);
    }

    let login: DeviceResponse = response
        .json()
        .await
        .map_err(|error| format!("Twitch returned invalid login data: {error}"))?;
    if !login
        .verification_uri
        .starts_with("https://www.twitch.tv/activate")
    {
        return Err("Twitch returned an unexpected verification address".to_string());
    }

    let mut auth = state.inner.lock().await;
    if auth.login_generation != login_id {
        return Err("Twitch login was canceled".to_string());
    }
    auth.pending = Some(PendingLogin {
        id: login_id,
        device_code: login.device_code,
        expires_at: unix_time().saturating_add(login.expires_in),
        scopes: scopes.to_string(),
    });

    Ok(DeviceLogin {
        login_id,
        user_code: login.user_code,
        verification_uri: login.verification_uri,
        expires_in: login.expires_in,
        interval: login.interval.max(1),
    })
}

#[tauri::command]
pub async fn poll_twitch_login(
    login_id: u64,
    state: tauri::State<'_, TwitchState>,
) -> Result<DevicePoll, String> {
    let (client_id, pending) = {
        let mut auth = state.inner.lock().await;
        let client_id = configured_client_id(&auth)?;
        let pending = auth
            .pending
            .clone()
            .filter(|pending| pending.id == login_id)
            .ok_or_else(|| "There is no Twitch login in progress".to_string())?;
        if unix_time() >= pending.expires_at {
            auth.pending = None;
            return Err("The Twitch login code expired. Start again for a new code.".to_string());
        }
        (client_id, pending)
    };

    let response = state
        .client
        .post("https://id.twitch.tv/oauth2/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scopes", pending.scopes.as_str()),
            ("device_code", pending.device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not check Twitch login: {error}"))?;

    if !response.status().is_success() {
        let message = response_message(response).await;
        if message.eq_ignore_ascii_case("authorization_pending") {
            return Ok(DevicePoll::Pending { retry_after: 0 });
        }
        if message.eq_ignore_ascii_case("slow_down") {
            return Ok(DevicePoll::Pending { retry_after: 5 });
        }
        let mut auth = state.inner.lock().await;
        if auth
            .pending
            .as_ref()
            .is_some_and(|current| current.id == login_id)
        {
            auth.pending = None;
        }
        return Err(match message.as_str() {
            "access_denied" => "Twitch login was declined".to_string(),
            "invalid device code" | "expired_token" => {
                "The Twitch login code expired. Start again for a new code.".to_string()
            }
            _ => format!("Twitch login failed: {message}"),
        });
    }

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Twitch returned invalid token data: {error}"))?;
    let refresh_token = tokens
        .refresh_token
        .ok_or_else(|| "Twitch did not return a refresh token".to_string())?;
    let identity = validate_token(&state.client, &tokens.access_token)
        .await
        .map_err(ValidationError::into_message)?;
    validate_identity(&identity, &client_id, &pending.scopes)?;

    let mut auth = state.inner.lock().await;
    if auth
        .pending
        .as_ref()
        .is_none_or(|current| current.id != login_id)
    {
        return Err("Twitch login was canceled".to_string());
    }
    let previous_settings = auth.settings.clone();
    let mut next_settings = auth.settings.clone();
    next_settings.username = Some(identity.login);
    next_settings.user_id = Some(identity.user_id);
    next_settings.token_expires_at =
        Some(unix_time().saturating_add(tokens.expires_in.min(identity.expires_in)));
    next_settings.last_validated_at = Some(unix_time());
    next_settings.scopes = identity.scopes;
    save_settings(&state.settings_path, &next_settings)?;
    if let Err(error) = store_tokens(&tokens.access_token, &refresh_token) {
        let _ = save_settings(&state.settings_path, &previous_settings);
        return Err(error);
    }

    auth.access_token = Some(tokens.access_token);
    auth.refresh_token = Some(refresh_token);
    auth.settings = next_settings;
    auth.validated_at = Some(unix_time());
    auth.pending = None;

    Ok(DevicePoll::Complete {
        account: auth_status(&auth),
    })
}

#[tauri::command]
pub async fn cancel_twitch_login(
    login_id: u64,
    state: tauri::State<'_, TwitchState>,
) -> Result<(), String> {
    let mut auth = state.inner.lock().await;
    if auth.login_generation == login_id {
        auth.login_generation = auth.login_generation.wrapping_add(1);
        auth.pending = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn logout_twitch(
    state: tauri::State<'_, TwitchState>,
) -> Result<TwitchAuthStatus, String> {
    let mut auth = state.inner.lock().await;
    delete_tokens()?;
    auth.access_token = None;
    auth.refresh_token = None;
    auth.pending = None;
    auth.login_generation = auth.login_generation.wrapping_add(1);
    auth.validated_at = None;
    auth.settings.username = None;
    auth.settings.user_id = None;
    auth.settings.token_expires_at = None;
    auth.settings.last_validated_at = None;
    auth.settings.scopes.clear();
    save_settings(&state.settings_path, &auth.settings)?;
    Ok(auth_status(&auth))
}

#[tauri::command]
pub async fn send_chat_message(
    broadcaster_id: String,
    message: String,
    state: tauri::State<'_, TwitchState>,
) -> Result<(), String> {
    let broadcaster_id = broadcaster_id.trim();
    if broadcaster_id.is_empty()
        || broadcaster_id.len() > 30
        || !broadcaster_id
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err("The current Twitch chat does not have a valid room ID".to_string());
    }

    let message = message.trim();
    if message.is_empty() {
        return Err("Enter a chat message".to_string());
    }
    if message.chars().count() > 500 {
        return Err("Chat messages are limited to 500 characters".to_string());
    }
    if message.contains(['\r', '\n']) {
        return Err("Chat messages cannot contain line breaks".to_string());
    }

    let mut credentials = chat_credentials(&state, false).await?;
    let mut response = send_chat_request(&state.client, &credentials, broadcaster_id, message)
        .await
        .map_err(|error| format!("Could not send chat message: {error}"))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        credentials = chat_credentials_after_unauthorized(&state, &credentials).await?;
        response = send_chat_request(&state.client, &credentials, broadcaster_id, message)
            .await
            .map_err(|error| format!("Could not send chat message: {error}"))?;
    }

    if !response.status().is_success() {
        if response.status() == StatusCode::UNAUTHORIZED {
            clear_auth_if_current(&state, &credentials).await?;
            return Err("Your Twitch login expired. Log in again.".to_string());
        }
        return Err(response_error(response, "Twitch rejected the chat message").await);
    }
    let result: SendChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Twitch returned invalid chat data: {error}"))?;
    let sent = result
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "Twitch did not confirm the chat message".to_string())?;
    if !sent.is_sent {
        return Err(sent
            .drop_reason
            .map(|reason| reason.message)
            .unwrap_or_else(|| "Twitch did not send the chat message".to_string()));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_followed_channels(
    state: tauri::State<'_, TwitchState>,
) -> Result<Vec<FollowedChannel>, String> {
    let mut credentials = chat_credentials(&state, false).await?;
    ensure_following_scope(&credentials)?;
    match fetch_followed_channels(&state.client, &credentials).await {
        Ok(channels) => Ok(channels),
        Err(FollowingError::Unauthorized) => {
            credentials = chat_credentials_after_unauthorized(&state, &credentials).await?;
            ensure_following_scope(&credentials)?;
            match fetch_followed_channels(&state.client, &credentials).await {
                Ok(channels) => Ok(channels),
                Err(FollowingError::Unauthorized) => {
                    clear_auth_if_current(&state, &credentials).await?;
                    Err("Your Twitch login expired. Connect Twitch Following again.".to_string())
                }
                Err(error) => Err(following_error(error)),
            }
        }
        Err(error) => Err(following_error(error)),
    }
}

#[tauri::command]
pub async fn get_available_emotes(
    broadcaster_id: String,
    state: tauri::State<'_, TwitchState>,
) -> Result<Vec<AvailableEmote>, String> {
    if broadcaster_id.is_empty()
        || !broadcaster_id
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err("Wait for chat to connect before loading Twitch emotes".to_string());
    }
    let mut credentials = chat_credentials(&state, false).await?;
    ensure_emotes_scope(&credentials)?;
    match fetch_user_emotes(&state.client, &credentials, &broadcaster_id).await {
        Ok(emotes) => Ok(emotes),
        Err(FollowingError::Unauthorized) => {
            credentials = chat_credentials_after_unauthorized(&state, &credentials).await?;
            ensure_emotes_scope(&credentials)?;
            match fetch_user_emotes(&state.client, &credentials, &broadcaster_id).await {
                Ok(emotes) => Ok(emotes),
                Err(FollowingError::Unauthorized) => {
                    clear_auth_if_current(&state, &credentials).await?;
                    Err("Your Twitch login expired. Log in again.".to_string())
                }
                Err(FollowingError::Message(message)) => Err(message),
            }
        }
        Err(FollowingError::Message(message)) => Err(message),
    }
}

fn ensure_following_scope(credentials: &ChatCredentials) -> Result<(), String> {
    credentials
        .scopes
        .iter()
        .any(|scope| scope == FOLLOWING_SCOPE)
        .then_some(())
        .ok_or_else(|| {
            "Connect Twitch Following to grant the user:read:follows permission".to_string()
        })
}

fn ensure_emotes_scope(credentials: &ChatCredentials) -> Result<(), String> {
    credentials
        .scopes
        .iter()
        .any(|scope| scope == EMOTES_SCOPE)
        .then_some(())
        .ok_or_else(|| "Reconnect Twitch once to enable your Twitch emotes".to_string())
}

async fn fetch_followed_channels(
    client: &Client,
    credentials: &ChatCredentials,
) -> Result<Vec<FollowedChannel>, FollowingError> {
    let mut channels = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..100 {
        let mut request = client
            .get("https://api.twitch.tv/helix/streams/followed")
            .header("Client-Id", &credentials.client_id)
            .bearer_auth(&credentials.access_token)
            .query(&[("user_id", credentials.user_id.as_str()), ("first", "100")]);
        if let Some(after) = cursor.as_deref() {
            request = request.query(&[("after", after)]);
        }
        let response = request.send().await.map_err(|error| {
            FollowingError::Message(format!("Could not load followed streams: {error}"))
        })?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(FollowingError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(FollowingError::Message(
                response_error(response, "Twitch rejected the followed-stream request").await,
            ));
        }
        let page: FollowedStreamsResponse = response.json().await.map_err(|error| {
            FollowingError::Message(format!(
                "Twitch returned invalid followed-stream data: {error}"
            ))
        })?;
        for stream in page.data {
            if seen.insert(stream.user_id.clone()) {
                channels.push(FollowedChannel {
                    id: stream.user_id,
                    login: stream.user_login,
                    display_name: stream.user_name,
                    is_live: true,
                    title: stream.title,
                    category: stream.game_name,
                    viewer_count: stream.viewer_count,
                    thumbnail_url: stream
                        .thumbnail_url
                        .replace("{width}", "320")
                        .replace("{height}", "180"),
                });
            }
        }
        let Some(next_cursor) = page.pagination.cursor else {
            cursor = None;
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(FollowingError::Message(
                "Twitch repeated a followed-stream page cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
    if cursor.is_some() {
        return Err(FollowingError::Message(
            "Twitch returned too many followed-stream pages".to_string(),
        ));
    }

    channels.sort_by(|first, second| {
        first
            .display_name
            .to_lowercase()
            .cmp(&second.display_name.to_lowercase())
    });
    Ok(channels)
}

async fn fetch_user_emotes(
    client: &Client,
    credentials: &ChatCredentials,
    broadcaster_id: &str,
) -> Result<Vec<AvailableEmote>, FollowingError> {
    let mut emotes = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..100 {
        let mut request = client
            .get("https://api.twitch.tv/helix/chat/emotes/user")
            .header("Client-Id", &credentials.client_id)
            .bearer_auth(&credentials.access_token)
            .query(&[
                ("user_id", credentials.user_id.as_str()),
                ("broadcaster_id", broadcaster_id),
            ]);
        if let Some(after) = cursor.as_deref() {
            request = request.query(&[("after", after)]);
        }
        let response = request.send().await.map_err(|error| {
            FollowingError::Message(format!("Could not load Twitch emotes: {error}"))
        })?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(FollowingError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(FollowingError::Message(
                response_error(response, "Twitch rejected the emote request").await,
            ));
        }
        let page: UserEmotesResponse = response.json().await.map_err(|error| {
            FollowingError::Message(format!("Twitch returned invalid emote data: {error}"))
        })?;
        for emote in page.data {
            if !seen.insert(emote.id.clone()) {
                continue;
            }
            let format = if emote.format.iter().any(|value| value == "animated") {
                "animated"
            } else if emote.format.iter().any(|value| value == "static") {
                "static"
            } else {
                continue;
            };
            let theme = if emote.theme_mode.iter().any(|value| value == "dark") {
                "dark"
            } else if let Some(theme) = emote.theme_mode.first() {
                theme
            } else {
                continue;
            };
            let scale = if emote.scale.iter().any(|value| value == "2.0") {
                "2.0"
            } else if let Some(scale) = emote.scale.first() {
                scale
            } else {
                continue;
            };
            emotes.push(AvailableEmote {
                name: emote.name,
                url: page
                    .template
                    .replace("{{id}}", &emote.id)
                    .replace("{{format}}", format)
                    .replace("{{theme_mode}}", theme)
                    .replace("{{scale}}", scale),
                provider: "TWITCH",
                category: emote.emote_type,
                zero_width: false,
                overlay_x: 0,
                overlay_y: 0,
            });
        }
        let Some(next_cursor) = page.pagination.cursor else {
            cursor = None;
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(FollowingError::Message(
                "Twitch repeated an emote page cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
    if cursor.is_some() {
        return Err(FollowingError::Message(
            "Twitch returned too many emote pages".to_string(),
        ));
    }
    emotes.sort_by(|first, second| first.name.cmp(&second.name));
    Ok(emotes)
}

fn following_error(error: FollowingError) -> String {
    match error {
        FollowingError::Unauthorized => {
            "Your Twitch login expired. Connect Twitch Following again.".to_string()
        }
        FollowingError::Message(message) => message,
    }
}

async fn chat_credentials(
    state: &TwitchState,
    force_refresh: bool,
) -> Result<ChatCredentials, String> {
    let mut auth = state.inner.lock().await;
    ensure_auth(
        &state.client,
        &state.settings_path,
        &mut auth,
        force_refresh,
    )
    .await?;

    credentials_from_auth(&auth)
}

fn credentials_from_auth(auth: &TwitchAuth) -> Result<ChatCredentials, String> {
    Ok(ChatCredentials {
        client_id: configured_client_id(auth)?,
        access_token: auth
            .access_token
            .clone()
            .ok_or_else(|| "Log in to Twitch before sending chat messages".to_string())?,
        user_id: auth
            .settings
            .user_id
            .clone()
            .ok_or_else(|| "Log in to Twitch before sending chat messages".to_string())?,
        scopes: auth.settings.scopes.clone(),
        generation: auth.login_generation,
    })
}

async fn chat_credentials_after_unauthorized(
    state: &TwitchState,
    rejected: &ChatCredentials,
) -> Result<ChatCredentials, String> {
    let mut auth = state.inner.lock().await;
    if auth.login_generation != rejected.generation {
        return Err("Your Twitch login changed. Try again.".to_string());
    }
    let force_refresh = auth.access_token.as_deref() == Some(rejected.access_token.as_str());
    ensure_auth(
        &state.client,
        &state.settings_path,
        &mut auth,
        force_refresh,
    )
    .await?;
    credentials_from_auth(&auth)
}

async fn clear_auth_if_current(
    state: &TwitchState,
    rejected: &ChatCredentials,
) -> Result<(), String> {
    let mut auth = state.inner.lock().await;
    if auth.login_generation == rejected.generation
        && auth.access_token.as_deref() == Some(rejected.access_token.as_str())
    {
        clear_auth(&state.settings_path, &mut auth)?;
    }
    Ok(())
}

async fn ensure_auth(
    client: &Client,
    settings_path: &Path,
    auth: &mut TwitchAuth,
    force_refresh: bool,
) -> Result<(), String> {
    let now = unix_time();
    let expires_soon = auth
        .settings
        .token_expires_at
        .is_none_or(|expires_at| expires_at <= now.saturating_add(60));
    if force_refresh || auth.access_token.is_none() || expires_soon {
        return refresh_token(client, settings_path, auth).await;
    }
    let validation_due = auth
        .validated_at
        .is_none_or(|validated_at| validated_at <= now.saturating_sub(VALIDATION_INTERVAL));
    if !validation_due {
        return Ok(());
    }

    let access_token = auth
        .access_token
        .as_deref()
        .ok_or_else(|| "Your Twitch login expired. Log in again.".to_string())?;
    let client_id = configured_client_id(auth)?;
    let identity = match validate_token(client, access_token).await {
        Ok(identity) => identity,
        Err(ValidationError::Unauthorized(_)) => {
            return refresh_token(client, settings_path, auth).await;
        }
        Err(ValidationError::Other(message)) => return Err(message),
    };
    validate_identity(&identity, &client_id, CHAT_SCOPES)?;
    let mut next_settings = auth.settings.clone();
    next_settings.username = Some(identity.login);
    next_settings.user_id = Some(identity.user_id);
    next_settings.token_expires_at = Some(now.saturating_add(identity.expires_in));
    next_settings.last_validated_at = Some(now);
    next_settings.scopes = identity.scopes;
    save_settings(settings_path, &next_settings)?;
    auth.settings = next_settings;
    auth.validated_at = Some(now);
    Ok(())
}

async fn refresh_token(
    client: &Client,
    settings_path: &Path,
    auth: &mut TwitchAuth,
) -> Result<(), String> {
    let client_id = configured_client_id(auth)?;
    let Some(current_refresh_token) = auth.refresh_token.as_ref() else {
        clear_auth(settings_path, auth)?;
        return Ok(());
    };
    let response = client
        .post("https://id.twitch.tv/oauth2/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", current_refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not refresh Twitch login: {error}"))?;
    if !response.status().is_success() {
        let terminal = matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        );
        let message = response_error(response, "Your Twitch login could not be refreshed").await;
        if terminal {
            clear_auth(settings_path, auth)?;
            return Ok(());
        }
        return Err(message);
    }

    let tokens: TokenResponse = match response.json().await {
        Ok(tokens) => tokens,
        Err(error) => {
            clear_auth(settings_path, auth)?;
            return Err(format!("Twitch returned invalid token data: {error}"));
        }
    };
    let Some(next_refresh_token) = tokens.refresh_token else {
        clear_auth(settings_path, auth)?;
        return Ok(());
    };
    let mut next_settings = auth.settings.clone();
    next_settings.token_expires_at = Some(unix_time().saturating_add(tokens.expires_in));
    if !tokens.scope.is_empty() {
        next_settings.scopes = tokens.scope;
    }
    if let Err(error) = save_settings(settings_path, &next_settings) {
        clear_auth(settings_path, auth)?;
        return Err(error);
    }
    if let Err(error) = store_tokens(&tokens.access_token, &next_refresh_token) {
        let _ = clear_auth(settings_path, auth);
        return Err(error);
    }

    auth.access_token = Some(tokens.access_token);
    auth.refresh_token = Some(next_refresh_token);
    auth.settings = next_settings;
    let access_token = auth.access_token.as_deref().unwrap_or_default();
    let identity = match validate_token(client, access_token).await {
        Ok(identity) => identity,
        Err(ValidationError::Unauthorized(message)) => {
            clear_auth(settings_path, auth)?;
            return Err(message);
        }
        Err(ValidationError::Other(message)) => return Err(message),
    };
    if let Err(error) = validate_identity(&identity, &client_id, CHAT_SCOPES) {
        clear_auth(settings_path, auth)?;
        return Err(error);
    }

    let now = unix_time();
    let mut next_settings = auth.settings.clone();
    next_settings.username = Some(identity.login);
    next_settings.user_id = Some(identity.user_id);
    next_settings.token_expires_at = Some(
        next_settings
            .token_expires_at
            .unwrap_or(u64::MAX)
            .min(now.saturating_add(identity.expires_in)),
    );
    next_settings.last_validated_at = Some(now);
    next_settings.scopes = identity.scopes;
    save_settings(settings_path, &next_settings)?;
    auth.settings = next_settings;
    auth.validated_at = Some(now);
    Ok(())
}

async fn validate_token(
    client: &Client,
    access_token: &str,
) -> Result<ValidateResponse, ValidationError> {
    let response = client
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {access_token}"))
        .send()
        .await
        .map_err(|error| {
            ValidationError::Other(format!("Could not validate Twitch login: {error}"))
        })?;
    if !response.status().is_success() {
        let unauthorized = response.status() == StatusCode::UNAUTHORIZED;
        let message = response_error(response, "Twitch could not validate the login").await;
        return Err(if unauthorized {
            ValidationError::Unauthorized(message)
        } else {
            ValidationError::Other(message)
        });
    }
    response.json().await.map_err(|error| {
        ValidationError::Other(format!("Twitch returned invalid account data: {error}"))
    })
}

fn validate_identity(
    identity: &ValidateResponse,
    client_id: &str,
    required_scopes: &str,
) -> Result<(), String> {
    if identity.client_id != client_id {
        return Err("Twitch returned a token for a different application".to_string());
    }
    for scope in required_scopes.split_whitespace() {
        if !identity.scopes.iter().any(|granted| granted == scope) {
            return Err(format!("Twitch did not grant the {scope} permission"));
        }
    }
    if identity.login.is_empty() || identity.user_id.is_empty() {
        return Err("Twitch did not return an account identity".to_string());
    }
    Ok(())
}

async fn send_chat_request(
    client: &Client,
    credentials: &ChatCredentials,
    broadcaster_id: &str,
    message: &str,
) -> Result<Response, reqwest::Error> {
    client
        .post("https://api.twitch.tv/helix/chat/messages")
        .header("Client-Id", &credentials.client_id)
        .bearer_auth(&credentials.access_token)
        .json(&SendChatBody {
            broadcaster_id,
            sender_id: &credentials.user_id,
            message,
        })
        .send()
        .await
}

fn auth_status(auth: &TwitchAuth) -> TwitchAuthStatus {
    let logged_in = auth.settings.username.is_some()
        && auth.settings.user_id.is_some()
        && (auth.access_token.is_some() || auth.refresh_token.is_some());
    TwitchAuthStatus {
        configured: !auth.settings.client_id.is_empty(),
        logged_in,
        client_id: (!auth.settings.client_id.is_empty()).then(|| auth.settings.client_id.clone()),
        username: logged_in.then(|| auth.settings.username.clone()).flatten(),
        follows_connected: logged_in
            && auth
                .settings
                .scopes
                .iter()
                .any(|scope| scope == FOLLOWING_SCOPE),
        emotes_connected: logged_in
            && auth
                .settings
                .scopes
                .iter()
                .any(|scope| scope == EMOTES_SCOPE),
    }
}

fn clear_auth(settings_path: &Path, auth: &mut TwitchAuth) -> Result<(), String> {
    let credential_result = delete_tokens();
    auth.access_token = None;
    auth.refresh_token = None;
    auth.pending = None;
    auth.login_generation = auth.login_generation.wrapping_add(1);
    auth.validated_at = None;
    auth.settings.username = None;
    auth.settings.user_id = None;
    auth.settings.token_expires_at = None;
    auth.settings.last_validated_at = None;
    auth.settings.scopes.clear();
    let settings_result = save_settings(settings_path, &auth.settings);
    credential_result?;
    settings_result
}

fn configured_client_id(auth: &TwitchAuth) -> Result<String, String> {
    if auth.settings.client_id.is_empty() {
        Err("Configure wonkitch with a Twitch Public application Client ID first".to_string())
    } else {
        Ok(auth.settings.client_id.clone())
    }
}

fn valid_client_id(client_id: &str) -> bool {
    (20..=64).contains(&client_id.len())
        && client_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn load_settings(path: &Path) -> TwitchSettings {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents).unwrap_or_else(|error| {
            eprintln!("Could not parse Twitch settings: {error}");
            TwitchSettings::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => TwitchSettings::default(),
        Err(error) => {
            eprintln!("Could not read Twitch settings: {error}");
            TwitchSettings::default()
        }
    }
}

fn save_settings(path: &Path, settings: &TwitchSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Twitch settings path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the wonkitch settings folder: {error}"))?;
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode Twitch settings: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Could not save Twitch settings: {error}"))
}

fn credential(name: &str) -> Result<Entry, String> {
    Entry::new("wonkitch", name)
        .map_err(|error| format!("Windows Credential Manager is unavailable: {error}"))
}

fn load_secret(name: &str) -> Result<Option<String>, String> {
    match credential(name)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Windows Credential Manager could not read credentials: {error}"
        )),
    }
}

fn store_tokens(access_token: &str, refresh_token: &str) -> Result<(), String> {
    let access_entry = credential(ACCESS_TOKEN_KEY)?;
    let refresh_entry = credential(REFRESH_TOKEN_KEY)?;
    access_entry.set_password(access_token).map_err(|error| {
        format!("Windows Credential Manager could not save credentials: {error}")
    })?;
    if let Err(error) = refresh_entry.set_password(refresh_token) {
        let _ = access_entry.delete_credential();
        let _ = refresh_entry.delete_credential();
        return Err(format!(
            "Windows Credential Manager could not save credentials: {error}"
        ));
    }
    Ok(())
}

fn delete_tokens() -> Result<(), String> {
    for name in [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY] {
        match credential(name)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "Windows Credential Manager could not remove credentials: {error}"
                ));
            }
        }
    }
    Ok(())
}

async fn response_error(response: Response, fallback: &str) -> String {
    let status = response.status();
    let message = response_message(response).await;
    if message.is_empty() {
        format!("{fallback} ({status})")
    } else {
        format!("{fallback}: {message}")
    }
}

async fn response_message(response: Response) -> String {
    let text = response.text().await.unwrap_or_default();
    serde_json::from_str::<TwitchError>(&text)
        .ok()
        .and_then(|error| error.message.or(error.error))
        .unwrap_or_else(|| text.trim().to_string())
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_TWITCH_CLIENT_ID, valid_client_id};

    #[test]
    fn validates_twitch_client_ids() {
        assert!(valid_client_id("123456789012345678901234567890"));
        assert!(valid_client_id(DEFAULT_TWITCH_CLIENT_ID));
        assert!(!valid_client_id("too-short"));
        assert!(!valid_client_id("invalid_client_id_with_symbols"));
    }
}

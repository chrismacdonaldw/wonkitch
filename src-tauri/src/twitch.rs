use keyring::{Entry, Error as KeyringError};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const ACCESS_TOKEN_KEY: &str = "twitch-access-token";
const REFRESH_TOKEN_KEY: &str = "twitch-refresh-token";
const DEFAULT_TWITCH_CLIENT_ID: &str = "8pcv3di8jhgqgin1awujsm4ogwz73o";
const TWITCH_SCOPES: &str = "user:read:chat user:write:chat";

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
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct TwitchSettings {
    version: u8,
    client_id: String,
    username: Option<String>,
    user_id: Option<String>,
    token_expires_at: Option<u64>,
}

impl Default for TwitchSettings {
    fn default() -> Self {
        Self {
            version: 1,
            client_id: String::new(),
            username: None,
            user_id: None,
            token_expires_at: None,
        }
    }
}

struct PendingLogin {
    device_code: String,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchAuthStatus {
    configured: bool,
    logged_in: bool,
    client_id: Option<String>,
    username: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
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
}

impl TwitchState {
    pub fn load(settings_path: PathBuf) -> Self {
        let mut settings = load_settings(&settings_path);
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
            }),
        }
    }
}

#[tauri::command]
pub async fn get_twitch_auth_status(
    state: tauri::State<'_, TwitchState>,
) -> Result<TwitchAuthStatus, String> {
    let auth = state.inner.lock().await;
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
        auth.settings.username = None;
        auth.settings.user_id = None;
        auth.settings.token_expires_at = None;
        auth.settings.client_id = client_id.to_string();
    }
    save_settings(&state.settings_path, &auth.settings)?;
    Ok(auth_status(&auth))
}

#[tauri::command]
pub async fn begin_twitch_login(
    state: tauri::State<'_, TwitchState>,
) -> Result<DeviceLogin, String> {
    let mut auth = state.inner.lock().await;
    let client_id = configured_client_id(&auth)?;
    let response = state
        .client
        .post("https://id.twitch.tv/oauth2/device")
        .form(&[("client_id", client_id.as_str()), ("scopes", TWITCH_SCOPES)])
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

    auth.pending = Some(PendingLogin {
        device_code: login.device_code,
        expires_at: unix_time().saturating_add(login.expires_in),
    });

    Ok(DeviceLogin {
        user_code: login.user_code,
        verification_uri: login.verification_uri,
        expires_in: login.expires_in,
        interval: login.interval.max(1),
    })
}

#[tauri::command]
pub async fn poll_twitch_login(state: tauri::State<'_, TwitchState>) -> Result<DevicePoll, String> {
    let mut auth = state.inner.lock().await;
    let client_id = configured_client_id(&auth)?;
    let pending = auth
        .pending
        .as_ref()
        .ok_or_else(|| "There is no Twitch login in progress".to_string())?;
    if unix_time() >= pending.expires_at {
        auth.pending = None;
        return Err("The Twitch login code expired. Start again for a new code.".to_string());
    }

    let response = state
        .client
        .post("https://id.twitch.tv/oauth2/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scopes", TWITCH_SCOPES),
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
        auth.pending = None;
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
    let identity = validate_token(&state.client, &tokens.access_token).await?;
    validate_identity(&identity, &client_id)?;
    store_tokens(&tokens.access_token, &refresh_token)?;

    auth.access_token = Some(tokens.access_token);
    auth.refresh_token = Some(refresh_token);
    auth.settings.username = Some(identity.login);
    auth.settings.user_id = Some(identity.user_id);
    auth.settings.token_expires_at =
        Some(unix_time().saturating_add(tokens.expires_in.min(identity.expires_in)));
    auth.pending = None;
    save_settings(&state.settings_path, &auth.settings)?;

    Ok(DevicePoll::Complete {
        account: auth_status(&auth),
    })
}

#[tauri::command]
pub async fn cancel_twitch_login(state: tauri::State<'_, TwitchState>) -> Result<(), String> {
    state.inner.lock().await.pending = None;
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
    auth.settings.username = None;
    auth.settings.user_id = None;
    auth.settings.token_expires_at = None;
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
        credentials = chat_credentials(&state, true).await?;
        response = send_chat_request(&state.client, &credentials, broadcaster_id, message)
            .await
            .map_err(|error| format!("Could not send chat message: {error}"))?;
    }

    if !response.status().is_success() {
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

async fn chat_credentials(
    state: &TwitchState,
    force_refresh: bool,
) -> Result<ChatCredentials, String> {
    let mut auth = state.inner.lock().await;
    let expires_soon = auth
        .settings
        .token_expires_at
        .is_none_or(|expires_at| expires_at <= unix_time().saturating_add(60));
    if force_refresh || auth.access_token.is_none() || expires_soon {
        refresh_token(&state.client, &state.settings_path, &mut auth).await?;
    }

    Ok(ChatCredentials {
        client_id: configured_client_id(&auth)?,
        access_token: auth
            .access_token
            .clone()
            .ok_or_else(|| "Log in to Twitch before sending chat messages".to_string())?,
        user_id: auth
            .settings
            .user_id
            .clone()
            .ok_or_else(|| "Log in to Twitch before sending chat messages".to_string())?,
    })
}

async fn refresh_token(
    client: &Client,
    settings_path: &Path,
    auth: &mut TwitchAuth,
) -> Result<(), String> {
    let client_id = configured_client_id(auth)?;
    let current_refresh_token = auth
        .refresh_token
        .as_ref()
        .ok_or_else(|| "Your Twitch login expired. Log in again.".to_string())?;
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
        return Err(response_error(response, "Your Twitch login could not be refreshed").await);
    }

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Twitch returned invalid token data: {error}"))?;
    let next_refresh_token = tokens
        .refresh_token
        .ok_or_else(|| "Twitch did not rotate the refresh token".to_string())?;
    let identity = validate_token(client, &tokens.access_token).await?;
    validate_identity(&identity, &client_id)?;
    store_tokens(&tokens.access_token, &next_refresh_token)?;

    auth.access_token = Some(tokens.access_token);
    auth.refresh_token = Some(next_refresh_token);
    auth.settings.username = Some(identity.login);
    auth.settings.user_id = Some(identity.user_id);
    auth.settings.token_expires_at =
        Some(unix_time().saturating_add(tokens.expires_in.min(identity.expires_in)));
    save_settings(settings_path, &auth.settings)
}

async fn validate_token(client: &Client, access_token: &str) -> Result<ValidateResponse, String> {
    let response = client
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {access_token}"))
        .send()
        .await
        .map_err(|error| format!("Could not validate Twitch login: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "Twitch could not validate the login").await);
    }
    response
        .json()
        .await
        .map_err(|error| format!("Twitch returned invalid account data: {error}"))
}

fn validate_identity(identity: &ValidateResponse, client_id: &str) -> Result<(), String> {
    if identity.client_id != client_id {
        return Err("Twitch returned a token for a different application".to_string());
    }
    for scope in TWITCH_SCOPES.split_whitespace() {
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
    }
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
    credential(ACCESS_TOKEN_KEY)?
        .set_password(access_token)
        .map_err(|error| {
            format!("Windows Credential Manager could not save credentials: {error}")
        })?;
    if let Err(error) = credential(REFRESH_TOKEN_KEY)?.set_password(refresh_token) {
        let _ = credential(ACCESS_TOKEN_KEY)?.delete_credential();
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

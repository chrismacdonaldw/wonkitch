use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct PreferencesState {
    path: PathBuf,
    current: Mutex<AppPreferences>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppPreferences {
    version: u8,
    accent_color: String,
    chat_background: String,
    chat_text_color: String,
    reduced_motion: bool,
    chat_font_size: u8,
    chat_font_family: String,
    line_density: String,
    show_timestamps: bool,
    timestamp_format: String,
    timestamp_seconds: bool,
    show_badges: bool,
    alternating_rows: bool,
    adjust_username_colors: bool,
    chat_width: u16,
    max_messages: u16,
    pause_on_hover: bool,
    show_system_messages: bool,
    emote_size: u8,
    twitch_emotes: bool,
    ffz_emotes: bool,
    bttv_emotes: bool,
    seven_tv_emotes: bool,
    highlight_mentions: bool,
    highlight_color: String,
    highlight_terms: Vec<String>,
    highlight_users: Vec<String>,
    blocked_terms: Vec<String>,
    blocked_users: Vec<String>,
    blocked_behavior: String,
    desktop_notifications: bool,
    notification_sound: bool,
    notification_sound_mode: String,
    custom_sound_name: String,
    taskbar_alert: bool,
    unread_count: bool,
    notification_volume: u8,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            version: 3,
            accent_color: "#9146ff".to_string(),
            chat_background: "#0f1013".to_string(),
            chat_text_color: "#bfc3cb".to_string(),
            reduced_motion: false,
            chat_font_size: 14,
            chat_font_family: "Segoe UI".to_string(),
            line_density: "comfortable".to_string(),
            show_timestamps: true,
            timestamp_format: "24".to_string(),
            timestamp_seconds: false,
            show_badges: true,
            alternating_rows: true,
            adjust_username_colors: true,
            chat_width: 380,
            max_messages: 250,
            pause_on_hover: false,
            show_system_messages: true,
            emote_size: 28,
            twitch_emotes: true,
            ffz_emotes: true,
            bttv_emotes: true,
            seven_tv_emotes: true,
            highlight_mentions: true,
            highlight_color: "#9146ff".to_string(),
            highlight_terms: Vec::new(),
            highlight_users: Vec::new(),
            blocked_terms: Vec::new(),
            blocked_users: Vec::new(),
            blocked_behavior: "collapse".to_string(),
            desktop_notifications: false,
            notification_sound: false,
            notification_sound_mode: "chime".to_string(),
            custom_sound_name: String::new(),
            taskbar_alert: false,
            unread_count: true,
            notification_volume: 70,
        }
    }
}

impl PreferencesState {
    pub fn load(path: PathBuf) -> Self {
        let preferences = match fs::read(&path) {
            Ok(contents) => serde_json::from_slice(&contents).unwrap_or_else(|error| {
                eprintln!("Could not parse wonkitch preferences: {error}");
                AppPreferences::default()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppPreferences::default(),
            Err(error) => {
                eprintln!("Could not read wonkitch preferences: {error}");
                AppPreferences::default()
            }
        };

        Self {
            path,
            current: Mutex::new(normalize(preferences)),
        }
    }
}

#[tauri::command]
pub fn get_preferences(
    state: tauri::State<'_, PreferencesState>,
) -> Result<AppPreferences, String> {
    state
        .current
        .lock()
        .map(|preferences| preferences.clone())
        .map_err(|_| "Preferences are unavailable".to_string())
}

#[tauri::command]
pub fn save_preferences(
    preferences: AppPreferences,
    state: tauri::State<'_, PreferencesState>,
) -> Result<AppPreferences, String> {
    let preferences = normalize(preferences);
    save(&state.path, &preferences)?;
    let mut current = state
        .current
        .lock()
        .map_err(|_| "Preferences are unavailable".to_string())?;
    *current = preferences.clone();
    Ok(preferences)
}

#[tauri::command]
pub fn reset_preferences(
    state: tauri::State<'_, PreferencesState>,
) -> Result<AppPreferences, String> {
    let preferences = AppPreferences::default();
    save(&state.path, &preferences)?;
    let mut current = state
        .current
        .lock()
        .map_err(|_| "Preferences are unavailable".to_string())?;
    *current = preferences.clone();
    Ok(preferences)
}

fn normalize(mut preferences: AppPreferences) -> AppPreferences {
    let defaults = AppPreferences::default();
    if preferences.version < 2 && preferences.notification_volume == 50 {
        preferences.notification_volume = defaults.notification_volume;
    }
    preferences.version = 3;
    preferences.accent_color = normalize_color(preferences.accent_color, &defaults.accent_color);
    preferences.chat_background =
        normalize_color(preferences.chat_background, &defaults.chat_background);
    preferences.chat_text_color =
        normalize_color(preferences.chat_text_color, &defaults.chat_text_color);
    preferences.highlight_color =
        normalize_color(preferences.highlight_color, &defaults.highlight_color);
    preferences.chat_font_size = preferences.chat_font_size.clamp(11, 24);
    preferences.emote_size = preferences.emote_size.clamp(18, 48);
    preferences.chat_width = preferences.chat_width.clamp(260, 640);
    preferences.max_messages = preferences.max_messages.clamp(50, 500);
    preferences.notification_volume = preferences.notification_volume.min(100);

    if !["Segoe UI", "Arial", "Consolas", "Georgia"]
        .contains(&preferences.chat_font_family.as_str())
    {
        preferences.chat_font_family = defaults.chat_font_family;
    }
    if !["compact", "comfortable", "spacious"].contains(&preferences.line_density.as_str()) {
        preferences.line_density = defaults.line_density;
    }
    if !["12", "24"].contains(&preferences.timestamp_format.as_str()) {
        preferences.timestamp_format = defaults.timestamp_format;
    }
    if !["collapse", "remove"].contains(&preferences.blocked_behavior.as_str()) {
        preferences.blocked_behavior = defaults.blocked_behavior;
    }
    if !["chime", "pulse", "custom"].contains(&preferences.notification_sound_mode.as_str()) {
        preferences.notification_sound_mode = defaults.notification_sound_mode;
    }
    preferences.custom_sound_name = preferences
        .custom_sound_name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();

    preferences.highlight_terms = normalize_rules(preferences.highlight_terms);
    preferences.highlight_users = normalize_rules(preferences.highlight_users);
    preferences.blocked_terms = normalize_rules(preferences.blocked_terms);
    preferences.blocked_users = normalize_rules(preferences.blocked_users);
    preferences
}

fn normalize_color(color: String, fallback: &str) -> String {
    let color = color.trim().to_ascii_lowercase();
    if color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        color
    } else {
        fallback.to_string()
    }
}

fn normalize_rules(rules: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for rule in rules.into_iter().take(100) {
        let rule = rule.trim().chars().take(120).collect::<String>();
        if !rule.is_empty() && !normalized.iter().any(|existing| existing == &rule) {
            normalized.push(rule);
        }
    }
    normalized
}

fn save(path: &Path, preferences: &AppPreferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Preferences path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the wonkitch settings folder: {error}"))?;
    let contents = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("Could not encode preferences: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Could not save preferences: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{AppPreferences, normalize};

    #[test]
    fn normalizes_invalid_preferences() {
        let preferences = normalize(AppPreferences {
            accent_color: "purple".to_string(),
            chat_font_size: 2,
            chat_width: 10,
            max_messages: 5000,
            line_density: "tiny".to_string(),
            highlight_terms: vec![" test ".to_string(), "test".to_string()],
            ..AppPreferences::default()
        });

        assert_eq!(preferences.accent_color, "#9146ff");
        assert_eq!(preferences.chat_font_size, 11);
        assert_eq!(preferences.chat_width, 260);
        assert_eq!(preferences.max_messages, 500);
        assert_eq!(preferences.line_density, "comfortable");
        assert_eq!(preferences.highlight_terms, vec!["test"]);
    }
}

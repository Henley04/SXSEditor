use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

// ==================== State ====================

#[derive(Default, Serialize, Deserialize, Clone)]
struct AppSettings {
    locale: Option<String>,
    theme_id: Option<String>,
    device_mode: Option<String>,
    preferred_device_id: Option<i32>,
    preferred_device_type: Option<String>,
    model_device_mapping: Option<HashMap<String, String>>,
    update_channel: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<AppSettings>,
    model_dir: Mutex<Option<PathBuf>>,
    singers: Mutex<Vec<SingerInfo>>,
    projects: Mutex<Vec<ProjectInfo>>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct SingerInfo {
    id: String,
    name: String,
    track_name: String,
    avatar_path: Option<String>,
    model_path: Option<String>,
    config_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ProjectInfo {
    id: String,
    name: String,
    path: Option<String>,
    modified: String,
}

// ==================== Tauri Commands ====================

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_model_dir(state: tauri::State<AppState>) -> Result<String, String> {
    let dir = state.model_dir.lock().map_err(|e| e.to_string())?;
    Ok(dir.clone().unwrap_or_default().to_string_lossy().to_string())
}

#[tauri::command]
fn set_model_dir(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let mut dir = state.model_dir.lock().map_err(|e| e.to_string())?;
    *dir = Some(PathBuf::from(path));
    Ok(())
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn save_settings(state: tauri::State<AppState>, settings: AppSettings) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    *s = settings;
    Ok(())
}

#[tauri::command]
fn get_singers(state: tauri::State<AppState>) -> Result<Vec<SingerInfo>, String> {
    let singers = state.singers.lock().map_err(|e| e.to_string())?;
    Ok(singers.clone())
}

#[tauri::command]
fn save_singer(state: tauri::State<AppState>, singer: SingerInfo) -> Result<(), String> {
    let mut singers = state.singers.lock().map_err(|e| e.to_string())?;
    if let Some(pos) = singers.iter().position(|s| s.id == singer.id) {
        singers[pos] = singer;
    } else {
        singers.push(singer);
    }
    Ok(())
}

#[tauri::command]
fn delete_singer(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let mut singers = state.singers.lock().map_err(|e| e.to_string())?;
    singers.retain(|s| s.id != id);
    Ok(())
}

#[tauri::command]
fn get_projects(state: tauri::State<AppState>) -> Result<Vec<ProjectInfo>, String> {
    let projects = state.projects.lock().map_err(|e| e.to_string())?;
    Ok(projects.clone())
}

#[tauri::command]
fn save_project(state: tauri::State<AppState>, project: ProjectInfo) -> Result<(), String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    if let Some(pos) = projects.iter().position(|p| p.id == project.id) {
        projects[pos] = project;
    } else {
        projects.push(project);
    }
    Ok(())
}

#[tauri::command]
fn delete_project(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let mut projects = state.projects.lock().map_err(|e| e.to_string())?;
    projects.retain(|p| p.id != id);
    Ok(())
}

#[tauri::command]
fn get_locale(state: tauri::State<AppState>) -> Result<String, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.locale.clone().unwrap_or_else(|| "zh-CN".to_string()))
}

#[tauri::command]
fn save_locale(state: tauri::State<AppState>, locale: String) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.locale = Some(locale);
    Ok(())
}

// ==================== Model Download Commands ====================

#[derive(Serialize, Deserialize, Clone)]
struct ModelInfo {
    name: String,
    size: u64,
    downloaded: bool,
    progress: f64,
}

#[tauri::command]
async fn check_models() -> Result<Vec<ModelInfo>, String> {
    // Simplified model checking - in production, this would check a remote server
    Ok(vec![
        ModelInfo { name: "soulx-singer-base".into(), size: 250_000_000, downloaded: false, progress: 0.0 },
        ModelInfo { name: "soulx-singer-jp".into(), size: 200_000_000, downloaded: false, progress: 0.0 },
        ModelInfo { name: "sifigan-vocoder".into(), size: 50_000_000, downloaded: false, progress: 0.0 },
    ])
}

#[tauri::command]
async fn download_model(app: tauri::AppHandle, model_name: String) -> Result<(), String> {
    // Simplified download - in production, this would stream from a URL
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let model_dir = app_dir.join("models").join(&model_name);
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;
    // TODO: Implement actual download logic
    Ok(())
}

// ==================== Theme Commands ====================

#[derive(Serialize, Deserialize, Clone)]
struct ThemeInfo {
    id: String,
    name: String,
    author: Option<String>,
    version: Option<String>,
    description: Option<String>,
}

#[tauri::command]
fn list_themes() -> Vec<ThemeInfo> {
    vec![
        ThemeInfo {
            id: "default".into(),
            name: "Default Dark".into(),
            author: Some("SXSEditor".into()),
            version: Some("1.0.0".into()),
            description: Some("Default dark theme for SXSEditor-Pad".into()),
        },
        ThemeInfo {
            id: "light".into(),
            name: "Default Light".into(),
            author: Some("SXSEditor".into()),
            version: Some("1.0.0".into()),
            description: Some("Default light theme for SXSEditor-Pad".into()),
        },
    ]
}

// ==================== App Builder ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_model_dir,
            set_model_dir,
            get_settings,
            save_settings,
            get_singers,
            save_singer,
            delete_singer,
            get_projects,
            save_project,
            delete_project,
            get_locale,
            save_locale,
            check_models,
            download_model,
            list_themes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SXSEditor-Pad");
}
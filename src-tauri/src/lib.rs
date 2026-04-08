use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewUrl, WebviewWindowBuilder,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TAB_CHROME_HEIGHT: u32 = 120; // Titlebar + Tabbar + Navbar

#[derive(Default)]
struct TabRegistry {
    tabs: Mutex<HashMap<u32, TabRecord>>,
}

#[derive(Clone, Default)]
struct TabRecord {
    label: String,
    title: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabTitleUpdatedPayload {
    tab_id: u32,
    title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabUrlUpdatedPayload {
    tab_id: u32,
    url: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TabRegistry::default())
        .invoke_handler(tauri::generate_handler![
            open_url,
            close_tab,
            report_tab_change
        ])
        .run(tauri::generate_context!())
        .expect("error while running Caliginous");
}

#[tauri::command(rename_all = "camelCase")]
fn open_url(
    app: AppHandle,
    state: State<'_, TabRegistry>,
    tab_id: u32,
    url: String,
) -> Result<(), String> {
    let parsed = parse_webview_url(&url)?;
    let label = tab_label(tab_id);

    // If webview already exists, navigate it
    if let Some(window) = app.get_webview_window(&label) {
        match parsed {
            WebviewUrl::External(u) => {
                window.navigate(u).map_err(|e| e.to_string())?;
            }
            WebviewUrl::App(_) => {
                return Err("cannot navigate existing tab to app URL".into());
            }
        }
        let _ = window.set_focus();
        return Ok(());
    }

    // Otherwise create it
    create_tab_window(&app, &state, tab_id, parsed, &label)
}

#[tauri::command(rename_all = "camelCase")]
fn close_tab(app: AppHandle, state: State<'_, TabRegistry>, tab_id: u32) -> Result<(), String> {
    let label = tab_label(tab_id);

    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "tab registry lock poisoned".to_string())?;
        tabs.remove(&tab_id);
    }

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No tab webview found for tabId {tab_id}"))?;

    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn report_tab_change(
    app: AppHandle,
    state: State<'_, TabRegistry>,
    tab_id: u32,
    title: String,
    url: String,
) -> Result<(), String> {
    let mut emit_title = None::<String>;
    let mut emit_url = None::<String>;

    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "tab registry lock poisoned".to_string())?;

        let record = tabs.entry(tab_id).or_insert_with(|| TabRecord {
            label: tab_label(tab_id),
            ..TabRecord::default()
        });

        if record.url != url {
            record.url = url.clone();
            emit_url = Some(url);
        }

        if !title.is_empty() && record.title != title {
            record.title = title.clone();
            emit_title = Some(title);
        }
    }

    if let Some(title) = emit_title {
        app.emit_to(
            MAIN_WINDOW_LABEL,
            "tab-title-updated",
            TabTitleUpdatedPayload { tab_id, title },
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(url) = emit_url {
        app.emit_to(
            MAIN_WINDOW_LABEL,
            "tab-url-updated",
            TabUrlUpdatedPayload { tab_id, url },
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn create_tab_window(
    app: &AppHandle,
    state: &State<'_, TabRegistry>,
    tab_id: u32,
    target_url: WebviewUrl,
    label: &str,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let main_size = main_window
        .inner_size()
        .map_err(|e| format!("failed to read main window size: {e}"))?;

    let content_height = main_size.height.saturating_sub(TAB_CHROME_HEIGHT);

    let tab = WebviewWindowBuilder::new(app, label, target_url)
        .parent(&main_window)?
        .position(Position::Physical(PhysicalPosition::new(
            0_i32,
            TAB_CHROME_HEIGHT as i32,
        )))
        .inner_size(Size::Physical(PhysicalSize::new(
            main_size.width,
            content_height,
        )))
        .initialization_script(&tab_bridge_script(tab_id))
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    let _ = tab.set_focus();

    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tab registry lock poisoned".to_string())?;

    tabs.insert(
        tab_id,
        TabRecord {
            label: label.to_string(),
            title: String::new(),
            url: String::new(),
        },
    );

    Ok(())
}

fn parse_webview_url(input: &str) -> Result<WebviewUrl, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("url cannot be empty".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = tauri::Url::parse(trimmed).map_err(|e| e.to_string())?;
        return Ok(WebviewUrl::External(url));
    }
    // Default to https if no protocol
    let url = tauri::Url::parse(&format!("https://{}", trimmed)).map_err(|e| e.to_string())?;
    Ok(WebviewUrl::External(url))
}

fn tab_label(tab_id: u32) -> String {
    format!("tab-{}", tab_id)
}

fn tab_bridge_script(tab_id: u32) -> String {
    format!(
        r#"
(() => {{
  const TAB_ID = {tab_id};
  const invoke = window.TAURI?.core?.invoke || window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {{
    return;
  }}

  let lastTitle = null;
  let lastUrl = null;

  const emit = () => {{
    const title = document.title || '';
    const url = String(location.href || '');

    if (title === lastTitle && url === lastUrl) {{
      return;
    }}

    lastTitle = title;
    lastUrl = url;

    invoke('report_tab_change', {{ tabId: TAB_ID, title, url }})
      .catch(() => {{}});
  }};

  const wrapHistoryMethod = (methodName) => {{
    const original = history[methodName];
    if (typeof original !== 'function') {{
      return;
    }}
    history[methodName] = function(...args) {{
      const result = original.apply(this, args);
      queueMicrotask(emit);
      return result;
    }};
  }};

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');

  window.addEventListener('DOMContentLoaded', emit);
  window.addEventListener('load', emit);
  window.addEventListener('hashchange', emit);
  window.addEventListener('popstate', emit);
  window.addEventListener('pageshow', emit);
  
  // Simple interval fallback
  setInterval(emit, 1000);
  emit();
}})();
"#
    )
}
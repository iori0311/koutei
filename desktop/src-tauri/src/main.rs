// 取り付け工程表（デスクトップ版）。画面はブラウザ版と同じ HTML。右に AI のパネルがあり、同梱の Codex に工程表の操作を頼める
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod codex;
mod files;

use codex::{AiEvent, Client};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
struct Ai {
    client: Mutex<Option<Arc<Client>>>,
    thread: Mutex<Option<String>>,
    active: Mutex<Option<String>>,
    busy: AtomicBool,
    uncertain: AtomicBool,
    stopping: AtomicBool,
}
#[derive(Serialize)]
struct Connection { connected: bool, authenticated: bool, email: Option<String>, message: String }

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("この画面からは使えません。".into()) }
}

// Codex を起動する（はじめて使うとき）。ログイン情報は、このアプリ専用の場所に置く
async fn client(app: &tauri::AppHandle, state: &Ai) -> Result<Arc<Client>, String> {
    let mut slot = state.client.lock().await;
    if let Some(c) = slot.as_ref() { return Ok(c.clone()); }
    let binary = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(codex::BINARY_NAME)
    } else {
        app.path().resource_dir().map_err(|_| "Codex の場所がわかりません。")?.join(codex::BINARY_NAME)
    };
    let home = app.path().app_data_dir().map_err(|_| "アプリのデータの場所がわかりません。")?.join("codex-home");
    let c = Client::start(&binary, &home).await?;
    *slot = Some(c.clone());
    Ok(c)
}

#[tauri::command]
async fn ai_connect(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, Ai>) -> Result<Connection, String> {
    main_window(&window)?;
    let c = client(&app, &state).await?;
    if c.probe {
        return Ok(Connection { connected: true, authenticated: true, email: Some("（確かめ用の偽のモデル）".into()), message: "確かめ用の偽のモデルにつないでいます。".into() });
    }
    let account = c.rpc("account/read", json!({"refreshToken": false})).await?;
    let authenticated = !account["account"].is_null();
    Ok(Connection {
        connected: true,
        authenticated,
        email: account["account"]["email"].as_str().map(str::to_owned),
        message: if authenticated { "ChatGPT でログインしています。".into() } else { "ChatGPT でログインすると、頼めるようになります。".into() },
    })
}

#[tauri::command]
async fn ai_login(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, Ai>) -> Result<String, String> {
    main_window(&window)?;
    let c = client(&app, &state).await?;
    let result = c.rpc("account/login/start", json!({"type": "chatgpt"})).await?;
    let url = result["authUrl"].as_str().ok_or("ログインのページを開けません。")?;
    if !url.starts_with("https://auth.openai.com/") && !url.starts_with("https://auth.chatgpt.com/") {
        return Err("ログインのページを確かめられませんでした。".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|_| "ブラウザを開けませんでした。")?;
    Ok("ブラウザでログインしてください。".into())
}

#[tauri::command]
async fn ai_logout(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, Ai>) -> Result<(), String> {
    main_window(&window)?;
    if state.busy.load(Ordering::SeqCst) { return Err("回答が終わるか、止めてからにしてください。".into()); }
    let c = client(&app, &state).await?;
    c.rpc("account/logout", Value::Null).await?;
    *state.thread.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn ai_reset(window: tauri::WebviewWindow, state: State<'_, Ai>) -> Result<(), String> {
    main_window(&window)?;
    if state.busy.load(Ordering::SeqCst) { return Err("回答が終わるか、止めてからにしてください。".into()); }
    *state.thread.lock().await = None;
    if state.uncertain.swap(false, Ordering::SeqCst) { *state.client.lock().await = None; }
    Ok(())
}

#[tauri::command]
async fn ai_stop(window: tauri::WebviewWindow, state: State<'_, Ai>) -> Result<(), String> {
    main_window(&window)?;
    state.stopping.store(true, Ordering::SeqCst);
    let c = state.client.lock().await.clone();
    let thread = state.thread.lock().await.clone();
    let turn = state.active.lock().await.clone();
    if let (Some(c), Some(thread), Some(turn)) = (c, thread, turn) {
        c.cancel_tools(&turn).await;
        c.rpc("turn/interrupt", json!({"threadId": thread, "turnId": turn})).await?;
    }
    Ok(())
}

#[tauri::command]
async fn ai_resolve_tool(window: tauri::WebviewWindow, state: State<'_, Ai>, id: Value, result: Value) -> Result<(), String> {
    main_window(&window)?;
    let c = state.client.lock().await.clone().ok_or("Codex につないでいません。")?;
    let thread = state.thread.lock().await.clone().ok_or("会話がありません。")?;
    let turn = state.active.lock().await.clone().ok_or("回答はもう終わっています。")?;
    c.resolve_tool(id, result, &thread, &turn).await
}

// 頼む：1 回分の回答が終わるまで、途中の文字・道具の呼び出しを画面へ送り続ける
#[tauri::command]
async fn ai_send(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, Ai>, input: String, images: Option<Vec<String>>, on_event: Channel<AiEvent>) -> Result<(), String> {
    main_window(&window)?;
    codex::validate_input(&input)?;
    let images = images.unwrap_or_default();
    codex::validate_images(&images)?;
    if state.uncertain.load(Ordering::SeqCst) { return Err("前の回答がどうなったかわかりません。「新しい会話」から始め直してください。".into()); }
    if state.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("回答を作っているところです。".into()); }
    let _guard = BusyGuard(&state.busy);
    state.stopping.store(false, Ordering::SeqCst);
    let c = client(&app, &state).await?;
    let thread = {
        let mut slot = state.thread.lock().await;
        if slot.is_none() { *slot = Some(c.start_thread().await?); }
        slot.clone().unwrap()
    };
    let mut events = c.subscribe();
    let mut items = vec![json!({"type": "text", "text": input})];
    for url in &images { items.push(json!({"type": "image", "url": url})); }
    let params = json!({"threadId": thread, "model": codex::MODEL, "effort": codex::EFFORT, "input": items});
    let started = match c.rpc("turn/start", params).await {
        Ok(s) => s,
        Err(e) => { state.uncertain.store(true, Ordering::SeqCst); return Err(e); }
    };
    let turn = started["turn"]["id"].as_str().ok_or("回答の ID がわかりません。")?.to_owned();
    *state.active.lock().await = Some(turn.clone());
    if state.stopping.load(Ordering::SeqCst) { let _ = c.rpc("turn/interrupt", json!({"threadId": thread, "turnId": turn})).await; }
    let mut order = Vec::<String>::new();
    let mut text = std::collections::HashMap::<String, String>::new();
    let send = |e: AiEvent| on_event.send(e).map_err(|_| "画面とのつながりが切れました。".to_owned());
    let result: Result<(), String> = async {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(900), events.recv()).await
                .map_err(|_| "Codex からの返事が途切れました。".to_owned())?
                .map_err(|_| "Codex とのやりとりに抜けがありました。".to_owned())?;
            let method = event["method"].as_str().unwrap_or("");
            let p = &event["params"];
            if method == "koutei/disconnected" { return Err("Codex との接続が切れました。".into()); }
            if method == "koutei/toolDenied" {
                let _ = c.rpc("turn/interrupt", json!({"threadId": thread, "turnId": turn})).await;
                return Err("工程表の操作のほかの操作を求められたので止めました。「新しい会話」から始め直してください。".into());
            }
            if p.get("threadId").and_then(|v| v.as_str()).is_some_and(|id| id != thread) || p.get("turnId").and_then(|v| v.as_str()).is_some_and(|id| id != turn) { continue; }
            if method == "item/tool/call" {
                let mut e = AiEvent::new("tool", None, None);
                e.request = Some(json!({"id": event["id"], "tool": p["tool"], "arguments": p["arguments"]}));
                send(e)?;
                continue;
            }
            if method == "item/agentMessage/delta" {
                let id = p["itemId"].as_str().unwrap_or("answer").to_owned();
                if !text.contains_key(&id) { order.push(id.clone()); }
                text.entry(id).or_default().push_str(p["delta"].as_str().unwrap_or(""));
            } else if method == "item/completed" && p["item"]["type"] == "agentMessage" {
                let id = p["item"]["id"].as_str().unwrap_or("answer").to_owned();
                if !text.contains_key(&id) { order.push(id.clone()); }
                text.insert(id, p["item"]["text"].as_str().unwrap_or("").to_owned());
            } else if method == "turn/completed" {
                let status = p["turn"]["status"].as_str().unwrap_or("failed");
                if status == "failed" {
                    send(AiEvent::new("error", Some(p["turn"]["error"]["message"].as_str().unwrap_or("回答を作れませんでした。").to_owned()), None))?;
                } else {
                    send(AiEvent::new("complete", None, Some(status.into())))?;
                }
                return Ok(());
            } else {
                continue;
            }
            let answer = order.iter().filter_map(|id| text.get(id)).cloned().collect::<Vec<_>>().join("\n\n");
            send(AiEvent::new("delta", Some(answer), None))?;
        }
    }.await;
    c.cancel_tools(&turn).await;
    *state.active.lock().await = None;
    if result.is_err() {
        state.uncertain.store(true, Ordering::SeqCst);
        let _ = c.rpc("turn/interrupt", json!({"threadId": thread, "turnId": turn})).await;
    }
    result
}

// ---- アプリの更新 ----
// GitHub のリリース（公開したもの）の latest.json を見て、新しい版があれば落として入れ、開き直す。
// 落とした中身は、リリースのときに付けた署名で確かめる（公開鍵は tauri.conf.json の plugins.updater）
#[derive(Default)]
struct Updates {
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}
#[derive(Serialize)]
struct UpdateInfo { version: String, current: String }

fn update_error(what: &str, e: impl std::fmt::Display) -> String { format!("{what}（{e}）") }

#[tauri::command]
async fn update_check(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, Updates>) -> Result<Option<UpdateInfo>, String> {
    main_window(&window)?;
    let found = app.updater().map_err(|e| update_error("アップデートを確かめられませんでした", e))?
        .check().await.map_err(|e| update_error("アップデートを確かめられませんでした", e))?;
    let info = found.as_ref().map(|u| UpdateInfo { version: u.version.clone(), current: u.current_version.clone() });
    *state.update.lock().await = found;
    *state.bytes.lock().await = None;
    Ok(info)
}

// 新しい版を落とす。進み具合は on_progress に（受け取った量, 全体の量）で知らせる
#[tauri::command]
async fn update_download(window: tauri::WebviewWindow, state: State<'_, Updates>, on_progress: Channel<(u64, Option<u64>)>) -> Result<(), String> {
    main_window(&window)?;
    let update = state.update.lock().await.clone().ok_or("アップデートが見つかっていません。")?;
    let mut got = 0u64;
    let bytes = update.download(|n, total| { got += n as u64; let _ = on_progress.send((got, total)); }, || {})
        .await.map_err(|e| update_error("アップデートをダウンロードできませんでした", e))?;
    *state.bytes.lock().await = Some(bytes);
    Ok(())
}

// 落とした版を入れて、アプリを開き直す（画面は保存を済ませてから呼ぶ）。Windows では入れる途中でアプリが閉じ、入れ終わると開く
#[tauri::command]
async fn update_apply(app: tauri::AppHandle, window: tauri::WebviewWindow, ai: State<'_, Ai>, state: State<'_, Updates>) -> Result<(), String> {
    main_window(&window)?;
    let update = state.update.lock().await.clone().ok_or("アップデートが見つかっていません。")?;
    let bytes = state.bytes.lock().await.take().ok_or("アップデートをまだダウンロードしていません。")?;
    if let Some(c) = ai.client.lock().await.take() { c.kill(); }
    update.install(&bytes).map_err(|e| update_error("アップデートをインストールできませんでした", e))?;
    app.restart();
}

// 確かめ用（開発用のビルドだけ）：KOUTEI_UPDATE_SELFTEST があれば、起動してすぐ更新を確かめて入れ、開き直す
#[cfg(debug_assertions)]
fn update_selftest(app: &tauri::AppHandle) {
    if std::env::var_os("KOUTEI_UPDATE_SELFTEST").is_none() { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?.ok_or("新しい版がない")?;
            eprintln!("selftest: {} -> {}", update.current_version, update.version);
            let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
            update.install(&bytes).map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        }.await;
        match result {
            Ok(()) => { eprintln!("selftest: installed, restarting"); app.restart(); }
            Err(e) => { eprintln!("selftest: {e}"); std::process::exit(3); }
        }
    });
}

// 印刷（アプリの画面では window.print() の代わりに、ここから印刷の画面を出す）
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    window.print().map_err(|_| "印刷の画面を出せませんでした。".into())
}

fn main() {
    tauri::Builder::default()
        .manage(Ai::default())
        .manage(files::Files::default())
        .manage(Updates::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            update_selftest(_app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_connect, ai_login, ai_logout, ai_reset, ai_stop, ai_resolve_tool, ai_send, print_page,
            update_check, update_download, update_apply,
            files::file_pick_save, files::file_pick_open, files::file_stat, files::file_read, files::file_write
        ])
        .run(tauri::generate_context!())
        .expect("取り付け工程表を起動できませんでした");
}

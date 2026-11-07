// デスクトップ版の保存データ（JSON）の読み書き。ブラウザの File System Access API の代わり（画面の desktop-files.js から呼ぶ）
//   ・読み書きできるのは、保存・開くのダイアログでユーザーが選んだ .json だけ。選んだファイルは覚えておき、次に起動したときもつなぎ直せる
//   ・書き込みは一時ファイルに書いてから置き換える（途中で読まれても壊れない）
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
pub struct Files {
    allowed: Mutex<Option<HashSet<PathBuf>>>,
}
#[derive(Serialize)]
pub struct Picked { path: String, name: String }
#[derive(Serialize)]
pub struct Stat { modified: f64, size: u64 }
#[derive(Serialize)]
pub struct Read { modified: f64, size: u64, text: String }

fn list_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|_| "設定の場所がわかりません。")?.join("files.json"))
}
// 選んだことのあるファイルの一覧（初めて使うときにディスクから読む）
fn with_allowed<T>(app: &AppHandle, files: &Files, f: impl FnOnce(&mut HashSet<PathBuf>) -> T) -> Result<T, String> {
    let mut slot = files.allowed.lock().unwrap();
    if slot.is_none() {
        let list: Vec<PathBuf> = std::fs::read_to_string(list_path(app)?).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        *slot = Some(list.into_iter().collect());
    }
    Ok(f(slot.as_mut().unwrap()))
}
fn allow(app: &AppHandle, files: &Files, path: &Path) -> Result<(), String> {
    let list = with_allowed(app, files, |set| { set.insert(path.to_path_buf()); set.iter().cloned().collect::<Vec<_>>() })?;
    let file = list_path(app)?;
    if let Some(dir) = file.parent() { std::fs::create_dir_all(dir).map_err(|_| "設定を保存できません。")?; }
    std::fs::write(&file, serde_json::to_string(&list).unwrap()).map_err(|_| "設定を保存できません。".into())
}
fn check(app: &AppHandle, files: &Files, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) && with_allowed(app, files, |set| set.contains(&p))?;
    if ok { Ok(p) } else { Err("このファイルは、保存・開くで選んだファイルではありません。".into()) }
}
fn stat_of(p: &Path) -> Result<Stat, String> {
    let m = std::fs::metadata(p).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "NotFoundError: ファイルが見つかりません。".to_owned() } else { "ファイルを読めません。".to_owned() })?;
    let modified = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    Ok(Stat { modified, size: m.len() })
}
fn picked(path: PathBuf) -> Picked {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Picked { path: path.to_string_lossy().into_owned(), name }
}

#[tauri::command]
pub async fn file_pick_save(app: AppHandle, files: State<'_, Files>, suggested: String) -> Result<Option<Picked>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(&suggested).add_filter("取り付け工程表のデータ", &["json"]).save_file(move |p| { let _ = tx.send(p); });
    let Some(p) = rx.await.map_err(|_| "保存先を選べませんでした。")? else { return Ok(None) };
    let mut path = p.into_path().map_err(|_| "保存先を選べませんでした。")?;
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) { path.set_extension("json"); }
    allow(&app, &files, &path)?;
    Ok(Some(picked(path)))
}

#[tauri::command]
pub async fn file_pick_open(app: AppHandle, files: State<'_, Files>) -> Result<Option<Picked>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("取り付け工程表のデータ", &["json"]).pick_file(move |p| { let _ = tx.send(p); });
    let Some(p) = rx.await.map_err(|_| "ファイルを選べませんでした。")? else { return Ok(None) };
    let path = p.into_path().map_err(|_| "ファイルを選べませんでした。")?;
    allow(&app, &files, &path)?;
    Ok(Some(picked(path)))
}

#[tauri::command]
pub fn file_stat(app: AppHandle, files: State<'_, Files>, path: String) -> Result<Stat, String> {
    stat_of(&check(&app, &files, &path)?)
}

#[tauri::command]
pub fn file_read(app: AppHandle, files: State<'_, Files>, path: String) -> Result<Read, String> {
    let p = check(&app, &files, &path)?;
    let st = stat_of(&p)?;
    if st.size as usize > MAX_BYTES { return Err("ファイルが大きすぎます。".into()); }
    let text = std::fs::read_to_string(&p).map_err(|_| "ファイルを読めません。")?;
    Ok(Read { modified: st.modified, size: st.size, text })
}

#[tauri::command]
pub fn file_write(app: AppHandle, files: State<'_, Files>, path: String, text: String) -> Result<Stat, String> {
    let p = check(&app, &files, &path)?;
    if text.len() > MAX_BYTES { return Err("保存する中身が大きすぎます。".into()); }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = p.with_file_name(format!(".{}.{}.tmp", name, std::process::id()));
    std::fs::write(&tmp, text.as_bytes()).map_err(|_| "ファイルに書き込めません。")?;
    if std::fs::rename(&tmp, &p).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err("ファイルに書き込めません。".into());
    }
    stat_of(&p)
}

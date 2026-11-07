// 同梱する Codex の版と SHA-256（codex.json の、このビルドの対象の分）を、プログラムに埋め込む
fn main() {
    println!("cargo:rerun-if-changed=codex.json");
    let target = std::env::var("TARGET").expect("TARGET");
    let pins: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("codex.json").expect("codex.json を読めません")).expect("codex.json の形が正しくありません");
    let sha = pins["targets"][&target]["sha256"].as_str().unwrap_or_else(|| panic!("codex.json に {target} の Codex がありません"));
    let version = pins["version"].as_str().expect("codex.json の version");
    println!("cargo:rustc-env=KOUTEI_CODEX_SHA256={sha}");
    println!("cargo:rustc-env=KOUTEI_CODEX_VERSION=codex-cli {version}");
    tauri_build::build()
}

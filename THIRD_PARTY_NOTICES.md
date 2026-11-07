# 同梱しているもの

## OpenAI Codex（デスクトップ版のインストーラーに同梱）

- 版：0.153.4。[openai/codex のリリース](https://github.com/openai/codex/releases/tag/rust-v0.153.4)の実行ファイルを、手を加えずに同梱しています（SHA-256 は [`desktop/src-tauri/codex.json`](desktop/src-tauri/codex.json)）
- ライセンス：Apache License 2.0（[`desktop/src-tauri/licenses/codex-LICENSE.txt`](desktop/src-tauri/licenses/codex-LICENSE.txt)）
- NOTICE：[`desktop/src-tauri/licenses/codex-NOTICE.txt`](desktop/src-tauri/licenses/codex-NOTICE.txt)

インストールしたアプリの中にも、同じものが `licenses/` に入っています。

## デスクトップ版のライブラリ

デスクトップ版は [Tauri](https://tauri.app/)（MIT / Apache-2.0）と、Rust のライブラリを使っています。使っているものと版は [`desktop/src-tauri/Cargo.lock`](desktop/src-tauri/Cargo.lock) のとおりです。

ブラウザ版（HTML）と MCP サーバーは、ほかのライブラリを使っていません。

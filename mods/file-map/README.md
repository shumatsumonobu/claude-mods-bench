# file-map

Claude Code の mod（Claude Code の動きや画面を変えられるプラグイン）  
このセッションで Claude が読んだファイル・書き換えたファイルを、画面の右にフォルダごとの一覧で表示

## 課題

長いセッションで Claude があちこちのファイルを読み書きすると、どこを見て判断し、どこを書き換えたかが追えなくなる  
レビューのときに、変更の全体像が見えない

## 導入

Claude Code 2.1.287 以降が必要（`claude --version` で確認）  
早期公開のときに `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` を設定していたら削除（2.1.287 以降は無視される、[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

1. このリポジトリを marketplace（プラグインの配布元）として登録

   ```
   /plugin marketplace add shumatsumonobu/claude-mods-bench
   ```

2. file-map を入れる

   ```
   /plugin install file-map@claude-mods-bench
   ```

3. Claude Code を起動し直す ── 次の起動から有効、初回に作業フォルダの信頼を求められたら承認  
   開いたままのセッションなら、`/reload-plugins` でも読み込める（[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

## 動作

Claude が最初にファイルを読み書きした時点で、画面の右に一覧が自動で開く  
フォルダ名は水色、書き換えたファイルは緑、読んだだけのファイルは白  
プロンプトの上の1行には、件数を表示

![画面の右のファイルの一覧と、プロンプトの上の件数](../../screenshots/filemap-pane.png)

閉じたあとは、`m`（1行の右の `m: Open`）か `/map` で開き直せる

各ファイルの右に回数を表示 ── `read N` は読んだ回数、`edited N` は書き換えた回数、`created` は新しく作ったファイル  
見出しの `read` と `edited` は、読んだファイルと書き換えたファイルの数（読んでから書き換えたファイルは両方に入る）

```
File map · read 2 / edited 1
./
  README.md · read 1
src/
  math.js · read 1 · edited 1
```

数えるのは Claude のファイル操作のツール（Read・Write・Edit・MultiEdit・NotebookEdit）だけ  
`ls` や `grep` のような検索は数えない  
サブエージェントが読み書きしたファイルも入る（ヘッドレスで1回確認）

## 設計上の理由

mod は Claude Code の中で動くため、shell hook（`settings.json` に定義する従来のフック）では書けない次のことができる

- **画面の右に一覧を開ける** ── shell hook は結果を返すだけで、画面に表示を描く手段が無い  
  mod なら `ui.render` と `$.ui.open` で、画面の右に一覧を開き、プロンプトの上の1行に件数を出せる
- **Claude に問い合わせずに開ける** ── `/map` は mod の関数がその場で動き、Claude への問い合わせが起きない  
  会話にも何も返さないので、トークンを使わずに、いつでも開ける

## 仕様上の注意

実測（Claude Code 2.1.285 と 2.1.289）

- **`/map` を対話で使えるのは Claude Code 2.1.287 以降**  
  2.1.285 では対話のコマンド一覧に出ず、`/map` が Unknown command になった、2.1.289 では使えた  
  2.1.287 で mod が正式公開された（[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）
- **一覧が自動で開くのは、端末の横幅が144文字以上のとき**  
  mod が自分で開く表示の制限で、mod-permissions の一覧で実測  
  `/map` で開けば、どの幅でも表示（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）
- **プロンプトの上の1行は、Claude Code 本体の知らせが優先される**  
  利用枠が逼迫すると、本体がその場所に使用量の知らせを出し、件数の1行は出ない  
  一覧は `/map` で開ける
- **数えるのはこのセッションの間だけ** ── セッションを越えて残さない

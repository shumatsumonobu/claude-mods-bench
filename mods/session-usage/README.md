# session-usage

Claude Code の mod（Claude Code の動きや画面を変えられるプラグイン）  
週の利用上限を、どのセッションがどれだけ使ったかを、セッションをまたいで画面の右にグラフで表示

## 課題

週の利用上限に近づいても、どのセッションが使ったのかが分からない  
作者の直近7日の記録を料金の比率で数えると、93セッションのうち上位5セッションで52%、下位半分の46セッションは合わせて0.4%  
長く続けた数本のセッションが、気づかないうちに大半を使っていた

## 導入

Claude Code 2.1.287 以降が必要（`claude --version` で確認）  
早期公開のときに `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` を設定していたら削除（2.1.287 以降は無視される、[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

1. このリポジトリを marketplace（プラグインの配布元）として登録

   ```
   /plugin marketplace add shumatsumonobu/claude-mods-bench
   ```

2. session-usage を入れる

   ```
   /plugin install session-usage@claude-mods-bench
   ```

3. Claude Code を起動し直す ── 次の起動から有効、初回に作業フォルダの信頼を求められたら承認  
   開いたままのセッションなら、`/reload-plugins` でも読み込める（[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

## 動作

起動すると、画面の右に今週の使用量をセッション別に表示  
上は曜日×時間帯の使用量で、使った時間帯ほど明るい緑  
下はセッションごとの棒グラフで、作業フォルダ名・最初のプロンプト・割合・料金

![セッション別の使用量](../../screenshots/session-usage.png)

プロンプトの上の1行には、このセッションの割合と、7日の利用上限の消費率を表示  
閉じたあとは、`u`（1行の右の `u: Open`）か `/session-usage` で開き直せる

棒グラフと割合の範囲は、7日の利用上限が前回リセットされてから今まで  
上の色の表は、暦の上の直近7日  
セッション同士は料金（`/cost` と同じ集計）で比べる

## 設計上の理由

mod は Claude Code の中で動くため、shell hook（`settings.json` に定義する従来のフック）では書けない次のことができる

- **料金と利用上限を、返事のたびに読める** ── mod は `$.session.usage()` で、セッションの料金と、5時間・7日の利用上限の消費率を読める  
  モデルへの問い合わせは起きない  
  shell hook の入力には、料金も利用上限の消費率も入っていない（[公式の hooks のページ](https://code.claude.com/docs/en/hooks)で読んだ範囲）
- **画面の右に開ける** ── shell hook は画面に表示を描けない（[公式の hooks のページ](https://code.claude.com/docs/en/hooks)）  
  mod なら `ui.render` で、画面の右に色の表と棒グラフを描き、プロンプトの上の1行にも出せる
- **セッションをまたいで集計できる** ── mod の保存領域（`$.store`）は、同じマシンで動く全セッションで共有される（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）  
  各セッションが返事のたびに自分の料金を書き込み、どのセッションからでも全部を並べて見られる

## 仕様上の注意

実測（2026-10-07、Claude Code 2.1.289）と、公式ドキュメントを読んだ範囲

- **この mod 自体はトークンを使わない**  
  モデルを呼ばず、Claude が読む場所にも書かない  
  `/session-usage` は画面の右を開くだけで、会話には何も返さない（ヘッドレスで実行して料金 0、1回）
- **入れる前のセッションは数えない**  
  記録は mod を入れてから、各セッションが自分で書き込む  
  Claude Code のセッションの記録ファイルは、mod から読める大きさ（1ファイル4 MiB まで）を超えることが多いため、さかのぼって数えない（作者の直近7日では107件のうち28件が超え、最大408 MiB）
- **この mod を入れていないセッションは数えない** ── 別のマシンや claude.ai での使用も入らない
- **セッションの割合は料金の比** ── 7日の利用上限の消費率はアカウント全体の数字のまま出し、セッションには割り振らない
- **サブエージェントの料金も、呼び出したセッションに入る** ── セッションの料金はサブエージェントの分を含んでいた（ヘッドレスで1回）
- **記録は8日で消す**
- **右の表示が自動で開くのは、端末の横幅が144文字以上のとき**  
  mod が自分で開く表示の制限（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）  
  `/session-usage` で開けば、どの幅でも表示

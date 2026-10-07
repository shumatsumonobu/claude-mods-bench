# CLAUDE.md

Claude Code の mod（Claude Code の動きや画面を変えられるプラグイン）のうち、個人開発で実際に困ることに効くものを作って公開するリポジトリ

- **読者** ── Claude Code を使う日本の開発者、個人開発が中心
- **成果物** ── mod 本体と、`/plugin` でそのまま入れられる README
- **判断の基準** ── `.claude/rules/` が SoT

## ルールの置き場

| ファイル | いつ読むか |
|---|---|
| [.claude/rules/workflow.md](.claude/rules/workflow.md) | 作業を始める前 ── どこで作り、いつ完了とするか |
| [.claude/rules/mods.md](.claude/rules/mods.md) | mod を実装するとき ── 仕様と落とし穴 |
| [.claude/rules/docs.md](.claude/rules/docs.md) | ドキュメントを書くとき ── 構成と文体 |

ルールを足すときは新しいファイルを作らず、各ファイルの冒頭の「このファイルに足すもの」で行き先を決める

## 最重要の方針

**導入は `/plugin` の数行で済むこと**

- 読者は `/plugin marketplace add` と `/plugin install` で入れる
- 完成した mod は `mods/<name>/` に置き、`.claude-plugin/marketplace.json` に載せる
- 1 mod = 1ディレクトリで完結、marketplace.json の `source` が mod ごとのディレクトリを指す
- 実装は `hooks/register.ts` の1ファイルにまとめ、mod 同士でコードを共有しない（重複は許容）

**作るのは実験場、リポジトリには通ったものだけ**

- 実験場 `c:/dev/mods-bench/mods/<name>/` で作って試し、通ったものをリポジトリの `mods/<name>/` へ写す
- 小さな直しも同じ順番で、リポジトリを先に書き換えない（詳しくは workflow.md）

## 現在の状態

作業の状態は、手元の `WIP.md`（公開しない、`.gitignore` 済み）  
完成した mod は `mods/` にある

# 作業の進め方

このファイルに足すもの ── どこで作り、どの順で進め、いつ完了とするか  
実装の仕様は mods.md、ドキュメントの書き方は docs.md

## 1本ずつ完成させる

複数の mod に同時に手を付けない  
1本が完了条件を満たしてから次へ

## 題材の選び方

作る前に、次を全部満たすか確かめる

- 個人開発で実際に困っていること
- mod でしかできないこと（shell hook で足りるなら mod にしない）
- Claude Code 本体・公式のサンプル・既存の mod に、同じものが無いこと
- 効いたかどうかが、はっきり分かること
- 作者が自分の環境で試せること（たとえば従量課金の上限は Max プランでは試せない）

速くなる・書きやすくなる、といった程度の差は理由にしない  
shell hook でも書けるものを mod で書き直しても、読者にとって入れる理由にならない

困っているかは、作者の手元のセッションの記録（`~/.claude/projects/` の jsonl）で数えてから決める  
詰まりレーダーは、直近60日の279セッションで同じ失敗が2回以上続いたのが5セッションしかなく、作るのをやめた

## 作る場所

**実験はリポジトリの外でやり、通ったものだけ持ってくる** ── 実験場は `c:/dev/mods-bench`

mod は実際に動くので、作りかけの mod は誤判定する  
止めるはずの操作を通せば、そのセッションがこのリポジトリのファイルを消しうるため、リポジトリの外で動かす

**順番は、実験場で作る → 通ったらリポジトリの `mods/` へ写す**  
小さな直しも同じ順番で、リポジトリを先に書き換えない

| やること | 場所 |
|---|---|
| コードと README を書く・直す、`claude plugin test` を回す | 実験場の `c:/dev/mods-bench/mods/<name>/` |
| 対話セッションで動かす（`/config`、画面、実機のコマンド） | 実験場の、mod と同じ名前のテスト用プロジェクト（`c:/dev/mods-bench/<name>/`）、実験場の marketplace（`mods-bench-dev`）から `/plugin install --scope project` で1本だけ入れる |
| 通ったものを置く | リポジトリの `mods/<name>/`、写したあとリポジトリ側でも `claude plugin test` を回す |
| README の導入手順そのものを試す | 実験場で、`/plugin marketplace add <リポジトリのパス>` と `/plugin install` を使って再現する |

`/plugin` で入れた mod は、入れたときの版で写しが保存される（[公式の Create a mod のページ](https://code.claude.com/docs/en/plugins/mods/create)）  
実験場で直したら、`plugin.json` の `version` を上げて入れ直す

持ってくるのは通ったファイルだけで、実験場のディレクトリごとコピーしない

## 完了条件

3つすべてを満たして1本完了

1. **テストが通る** ── `claude plugin test mods/<name>` が 0 fail
2. **README の6節が埋まる** ── 構成は docs.md
3. **設計上の理由が書ける** ── shell hook で届かない点を、具体的に言えること

3が書けない mod は作らない  
shell hook で足りるなら、mod にする理由が無い

## 検証の作法

- **動作例は実際に出た文字列を使う** ── 作文しない、テストの出力か実際のセッションのログから取る
- **できないと書く前に、公式ドキュメントを読む** ── 1回の失敗した実測を根拠に否定しない、テストの方法のほうが間違っている場合がある
- **思ったとおり動かないときは、まずバージョンを見る** ── 2.1.285 で `/map` が出なかった原因は、mod がまだ早期公開だったこと（2.1.287 で正式公開）
- **型定義は、mod を `--plugin-dir` で読み込んで書き出す** ── 読み込むたびに、その mod の `.claude-plugin/types/` に書き出される（[公式の Create a mod のページ](https://code.claude.com/docs/en/plugins/mods/create)、実測1回）  
  イベント名・引数・返り値を推測で書かない
- **`claude -p` の実験には、利用者のグローバル CLAUDE.md が効く** ── 確認を求める指示があると、頼んだ編集を Claude が実行せずに確認を返す  
  実験のプロンプトに、確認は要らない、と書いて打ち消す
- **Git Bash で `claude -p "/コマンド"` を打つと、`/` で始まる引数が Windows のパスに書き換えられる** ── `MSYS_NO_PATHCONV=1` を付け、ほかのパスは `C:/...` の形で渡す

## 対話セッションを頼むとき

画面に出るもの（ボタン・プロンプトの上の1行・画面の右）、`/config`、対話のコマンド一覧、初めてのフォルダの信頼承認は、対話セッションでしか確かめられない  
その場合はユーザーに実行を頼む

- **作業ディレクトリは実験場** ── このリポジトリで起動させない
- **手順は mod 1本ぶんずつ渡す** ── 起動の `cd` から、打つ文、撮るタイミングとファイル名まで
- **撮る前に、表示が正しいかを確かめる** ── 確かめる前に保存を頼むと、直したあとに撮り直しになる
- **スクリーンショットは全部同じ端末幅・同じ拡大率** ── 画面の右に出るものは、横幅144文字以上ないと写らない

## テストの書き方

`tests/register.test.ts` に置く

```typescript
import { describe, expect, test, tier } from 'claude-code/testing'

tier('user')

describe('register', () => {
  test('説明', async ($: any, on: any) => {
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const r = await $.tool.call({ tool: 'Bash', command: 'rm .env' })
    expect(r.deny).toContain('保護対象')
  })
})
```

- テストの `on` は mod の下に座る ── mod が `next(e)` を呼んだときの答えを、ここで用意する
- ほかのプラグインの `$` 呼び出しはテストから流せない ── フックの関数を書き出し（export）、偽の `$` で直接呼ぶ
- `expect` に `toBeCloseTo` は無い ── 小数は丸めてから `toBe` で比べる

`tier` は mod が座る位置で、`prepend` / `user` / `append` / `builtin` の4つから選ぶ

| tier | 誰が入れた mod か |
|---|---|
| `prepend` | 管理者が前に置く managed プラグイン、最も外側 |
| `user` | 利用者が自分で入れるもの、**このリポジトリの mod はここ** |
| `append` | 管理者が後ろに置く managed プラグイン、`user` より内側 |
| `builtin` | Claude Code に同梱されているもの |

実際の層は5つで、`builtin` の内側にエンジン自身の `core` がある  
プラグインは `core` に座れないため、`tier()` の選択肢は4つ（層の詳しいことは mods.md）

## コミット

**ユーザーが明示的に指示するまで実行しない** ── プランの承認はコミットの引き金にならない

## 実行環境

2.1.287 からは、スイッチを付けずにテストが通る（2.1.289 で実測、複数回）

```bash
claude plugin test mods/<name>
```

環境変数が要るときは、`~/.claude/settings.json` を触らず、コマンドに直接付けるか `.claude/settings.json` に書く

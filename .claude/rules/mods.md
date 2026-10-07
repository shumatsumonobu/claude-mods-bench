# mod の作り方

このファイルに足すもの ── Claude Code 側の仕様と、実装で踏んだ落とし穴  
進め方は workflow.md、ドキュメントの書き方は docs.md

**各節の冒頭に根拠を書く** ── 実測したものと、型定義やドキュメントを読んだだけのものを混ぜない

型定義は、mod を `--plugin-dir` で読み込むと、その mod の `.claude-plugin/types/` に書き出される（[公式の Create a mod のページ](https://code.claude.com/docs/en/plugins/mods/create)、実測1回）  
公式リポジトリの `mods/types/claude-code.d.ts` と同じもので、先頭の行に書き出した版が載る

## mod とは

根拠: [公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)

Claude Code の中で動く関数を持つプラグイン  
従来の shell hook が出来事のたびに外部のプログラムを起動して文字を受け渡すのに対し、mod は処理を包む形で前後に手を入れられる

```typescript
on('tool.call', async ($, e, next) => {
  // 呼び出しの前
  const result = await next(e)
  // 呼び出しの後 ── result を書き換えて返せる
  return result
})
```

## ファイル構成

根拠: 実測

```
<name>/
  .claude-plugin/plugin.json   マニフェスト、置き方によって要否が変わる（下の表）
  hooks/hooks.json             { "modules": ["./register.ts"] }
  hooks/register.ts            本体、export function register(on: On, options?: PluginOptions)
  tests/register.test.ts       テスト
  README.md
```

`plugin.json` の `name` が使われる先（根拠: 型定義 `PluginOptions` と `PluginRegisterInput`）

- 設定の保存キー ── `settings.json` の `pluginConfigs[<name>@<marketplace>].options`（キーは下の出自のキーと同じ形）
- 出自のキー ── marketplace から入れたら `<name>@<marketplace>`、`--plugin-dir` なら `<name>@inline`、組み込みなら `<name>@builtin`
- `plugin.register` で、ほかの mod が名前を見るときの対象

`version` と `description` は表示だけに使われる

**実装は1ファイルにまとめる** ── mod 同士でコードを共有しない（重複は許容）  
公式の組み込み mod は逆で、補助の関数を1ディレクトリ1つずつに分けている（`diff` は約25ディレクトリ）  
1ファイルにまとめる決まりは、もとは README に全文を貼って導入させるためだった  
2026-10 に導入を `/plugin` に変えたので、この理由はもう当てはまらない

## 読み込まれる置き方

根拠: 実測

| 置き方 | `plugin.json` | 結果 |
|---|---|---|
| プロジェクトの `.claude/skills/<name>/` | 必要 | 読まれる、初回に作業フォルダの信頼承認が要る |
| `~/.claude/skills/<name>/` | 必要 | 読まれる |
| `--plugin-dir <dir>` | 不要 | 読まれる |
| marketplace から `/plugin install` | 必要 | 読まれる |
| プロジェクトの `.claude/hooks/` | ── | 読まれない |
| `settings.json` の `hooks.modules` | ── | 読まれない |

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` は、2.1.285 では必要だった（実測）  
2.1.287 からは mod が既定で有効になり、このスイッチは無視される（[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

`claude -p` では、信頼の確認の画面が出ない

- まだ信頼していないフォルダでは、プロジェクトの `.claude/skills/` に置いた mod は読まれない
- 一度対話セッションで信頼したフォルダなら、`claude -p` でも読まれる（2026-10-07 までに5回）
- `/plugin install --scope project` で入れた mod は、信頼していないフォルダでも `claude -p` で読まれた（1回）
- `/plugin install --scope project` で入れた mod は、そのプロジェクトのサブフォルダで起動すると読み込まれなかった（2.1.295、ヘッドレスで1回）
- 確実に読ませるなら `--plugin-dir` を使う

## ツール呼び出しを包む

根拠: 実測

### 返り値の形

```typescript
{ deny: string }                                   // 拒否 ── 文字列がエラーとしてモデルに届く
{ result: unknown, context?: readonly string[] }   // 結果 ── context はモデルへの補足
{ isError: true, result: unknown, text?: string }  // エラー
```

### 止めるときは理由を書く

根拠: 実測（1回）

`{ deny: '理由' }` の文字列は、エラーとしてモデルに届く  
理由を書くと、モデルは止められた理由を受け入れ、別の方法で回り込もうとしない（下は `rm` を止めたときのモデルの返事）  
理由を書かずに止めると、モデルは原因が分からず、別の経路を試す

```
infra/main.tf はまだ消えてない。rm をフックに止められた。
止めた理由は、パターン **/infra/** に一致する保護対象だから

ユーザーが意図して入れた保護なので、別の方法で回り込んで消すことはしない
```

### `ref` を持ち越すと、書き換えが届かない

`next(e)` が返したオブジェクトをそのまま返すと、core は元のメッセージを使い回す  
結果を差し替えるときは、`{ result, context }` を新しく作って返す

```typescript
// 効かない ── ref が残るので core が元のメッセージを使う
return { ...answer, result: masked }

// 効く
return { result: masked, context: ['書き換えた'] }
```

### `context` は文字列の配列

単一の文字列を返すと、`returned a context that is not a list of texts` で弾かれる  
上限は、1つで100,000文字、合わせて200,000文字（根拠: 型定義 `ToolCallResult`）、超えると先頭とパスに切られる

### 結果の形はツールごとに違う

| ツール | 結果 |
|---|---|
| Bash | `{ stdout, stderr, interrupted, ... }` |
| Read | `{ type: 'text', file: { filePath, content, numLines, ... } }` |

形を知らずに済ませたいなら、結果を再帰的にたどって文字列だけ加工する  
core はフックの答えをツールの出力の形に照合するので（根拠: 型定義 `ToolCallResult`）、形が違うと通らない  
Bash のエラーを `{ isError, result: 文字列, text }` で作り直して返すと、Bash の出力の形（オブジェクト）で検査されて落ち、モデルには次の文が届いた（実測1回）  
単体テストは形を検査しないので、拾えない

```
tool.call step resolved Bash with a result that does not match its output shape
```

### 長い結果は、mod に届く前に切られている

根拠: 実測（2026-09-28、Claude Code 2.1.281、3回）

Bash の出力が一定を超えると、Claude Code が全文をファイルに保存し、切り詰めた結果を返す  
mod が `next(e)` で受け取るのは、切り詰めたあとのもの

| 出力の大きさ | mod が受け取った `stdout` | `text` |
|---|---|---|
| 10KB | 4,009文字 101行 | 4,009文字 |
| 29.9KB | 11,770文字 295行 | 2,238文字 |
| 99.6KB | 11,770文字 295行 | 2,238文字 |

29.9KB と 99.6KB で3項目とも同じ値 ── 出力が3倍以上違っても変わらないので、上限とみる  
境目は 10KB と 29.9KB の間（未測定）、WebFetch でも同じ挙動（`Output too large (58.4KB). Full output saved to: ...`）

**結果を縮めるための mod には意味が無い** ── 本体が同じことをやっている  
[公式の tools-reference](https://code.claude.com/docs/en/tools-reference) の Output limits の節に、成功したコマンドは約30,000文字を超えるとファイルのパスと先頭最大2,000文字のプレビューになるとある  
失敗したコマンドは約10,000文字ぶんの頭と尻（同じ節）、mod が受け取る `stdout` の11,770文字は、この節に書かれていない  
届く量は `bashOutputMaxChars`（2.1.261 以降、最大128,000文字）で変えられる  
結果を書き換える価値があるのは、大きさではなく中身を変えるとき（秘密の値の伏せ字など）

### 引数は構造化されて届く

| ツール | 引数 |
|---|---|
| Bash | `command`, `timeout` |
| Write / Edit | `file_path` ほか |
| NotebookEdit | `notebook_path` |

シェルの文字列を正規表現で照合しなくて済むのも、mod の利点

### サブエージェントの呼び出しも届く

根拠: 実測（Claude Code 2.1.289、ヘッドレスで1回）

- サブエージェントのツール呼び出しも、mod の `tool.call` に来る ── イベントに `agentId` が付く
- 本体の呼び出しには `agentId` が無い ── サブエージェントを起動する `Agent` の呼び出しも同じ
- サブエージェントの引き渡しも、`SubagentHandback` というツールの呼び出しとして来る

### shell hook との差

根拠: [公式の hooks のページ](https://code.claude.com/docs/en/hooks)と CHANGELOG

- 成功した結果の差し替えは、shell hook でもできる ── `PostToolUse` の `updatedToolOutput` が 2.1.121 から全ツールに効く
- 差が出るのはエラーのほう ── `PostToolUseFailure` で返せるのは `additionalContext` だけで、モデルが読むエラー文は差し替えられない
- 止めるだけなら、shell hook でもできる ── `PreToolUse` の `permissionDecisionReason` が Claude に届く

## フックが失敗したとき

根拠: 型定義 `EngineEventOf` と `HookBudget`、debug ログで1回確認

**失敗したら、何もしなかった扱い** ── 例外を投げる・持ち時間を超える・形の違う答えを返す、のどれかで、そのフックは居なかった扱いになる  
下のフックと core がその場所で走り、最後に呼んだ `next` の結果があればそれが使われる

> a hook that fails (throws, overruns its budget: HookBudget, answers a wrong shape) is skipped:
> the hooks beneath and core run in its place, or its last `next` result stands

`next(e)` のあとで例外を投げたフックでは、debug ログに次の行が出て、ツールの結果はそのままモデルに届いた（実測1回）

```
hook failed: errorKind=HooksError errorChars=87 (tool.call; skipped; its last next() run's result stands)
```

**止めるための mod は、落ちたら止めない** ── 判定の途中で例外を投げると、止めるはずのコマンドが実行される

持ち時間の実数

| 値 | 意味 |
|---|---|
| `ms: 10_000` | 1回のイベントで、フックが自分のコードに使える時間 |
| `catchMs: 1_000` | `.catch` のハンドラの猶予、呼ばれた時点から数え直す |
| `lingerMs: 5_000` | `next.signal` が中断されたあとに残れる時間 |

時計は `next` と `$` を待っている間は止まり、自分のコードが走っている間だけ進む

### `.catch` で塞ぐ

```typescript
on('tool.call', { tool: 'Bash' }, async ($, e, next) => { ... })
  .catch(() => ({ deny: '判定できなかったため止めました' }))
```

失敗したときに同じ `($, e, next)` で呼び直され、猶予内に返した値がそのイベントの結果になる  
`undefined` を返すと、フックは居なかった扱い

- 1つの登録に1つだけ、2つ目は例外
- `register()` が返ったあとに付けると例外
- `engine.create` には付けられない
- ハンドラの中の `next` は、失敗前に呼んでいれば、下をもう一度走らせずに同じ結果を返す
- 失敗の理由は `next.error`（`kind` が `'throw'` か `'timeout'`）

## イベントは2系統

根拠: [公式のリファレンス](https://code.claude.com/docs/en/plugins/mods/reference)（2.1.289）と型定義

名前の形がどちらも `noun.verb` で混ざるが、別物で返り値の形が違う

| 系統 | 何か | 返り値 |
|---|---|---|
| Claude Code が上げるイベント | 本体が処理の途中で上げる（`tool.call` `prompt.submit` `turn.step` `ui.render` など） | イベントごと、`tool.call` は `{ result }` か `{ deny }` |
| `$` の呼び出し | `$.fs.read()` のようなメソッドの呼び出しが、そのままイベントになる | `{ value }` か `{ deny }` |
| プラグインが足した機能 | ほかの mod が `$` に足した機能（`telemetry` の `$.telemetry` など） | `{ value }` か `{ deny }` |

一覧は版ごとに増える（2.1.281 の型定義では38個と55個、2.1.289 の[公式のリファレンス](https://code.claude.com/docs/en/plugins/mods/reference)には `prompt.compose` `session.append` `ui.fault` などが加わっている）  
使う前に[公式のリファレンス](https://code.claude.com/docs/en/plugins/mods/reference)か、書き出した型定義を開いて確かめる  
引数と返り値を実際に確かめたのは、`tool.call` `session.start` `turn.complete` `plugin.register` `ui.render` `command.run` `prompt.submit` `prompt.context`

**自分以外のプラグインの `$` 呼び出しも捕まえられる** ── `next.origin` が呼び出し元を指すので、監査ログが1つの関数で書ける  
自分の呼び出しも自分のフックを通る（型定義には飛ばされるとあるが、実測では通った）ので、自分の分は名前で除く

### 従来の shell hook もイベント

`classic.PreToolUse` のように、`classic.*` で見える

### パターンの書き方

```typescript
on('tool.call', ($, e, next) => { ... })              // 名前ひとつ
on('classic.*', ($, e, next) => { ... })              // 名前空間
on('*', ($, e, next) => { ... })                      // 全部
on('!tool.*', ($, e, next) => { ... })                // 除外
on('tool.call', { tool: 'Bash' }, async ($, e, next) => { ... })  // 条件で絞る
```

同じ登録を繰り返すと例外  
どのイベントで呼ばれたかは `next.event`

## 層と `next.to`

根拠: 型定義 `TIERS`、**未実測**

外側が内側を包み、外側のほうが権限が強い（Koa と同じ形）

> The chain's five tiers, outermost first: earlier is outer is more authority, and same-event
> hooks nest in this order and no other way.

| 層 | 誰のものか |
|---|---|
| `prepend` | 管理者が前に置く managed プラグイン、最も外側 |
| `user` | 利用者が自分で入れるもの、**このリポジトリの mod はここ** |
| `append` | 管理者が後ろに置く managed プラグイン、`user` より内側 |
| `builtin` | Claude Code に同梱されているプラグイン |
| `core` | エンジン自身、最も内側 |

プラグインが座れるのは `core` 以外の4つ（`PluginTier`）で、テストの `tier()` が4つなのはこのため

`next.to(e, tier)` で層を飛ばして下へ渡せるが、managed の層以外からは拒否される  
`sec-default` は `next.to(e, 'append')` で `user` の層を飛ばし、組織の設定を守っている

呼び出し元と対象の出自も読める ── `next.origin.tier` が呼び出し元の層、`e.provider` が対象の出自

## 設定を受け取る

根拠: 実測（2026-09-28、対話セッションで `/config` から値を入れて確認）

`plugin.json` の `userConfig` で項目を宣言し、`register(on, options?)` の第2引数で受け取る

```json
"userConfig": {
  "patterns": {
    "type": "string",
    "title": "保護パターン",
    "description": "カンマ区切りのグロブ",
    "required": false,
    "default": "**/.env,**/*.pem"
  }
}
```

```typescript
export function register(on: On, options?: PluginOptions) {
  const patterns = String(options?.patterns ?? '').split(',')
}
```

- `/config` に行として出て、読者がその場で変えられる ── 表示は `<title> · <plugin名>`、`description` は選んだときの説明として出る
- **値を変えると、mod がその場で読み直される** ── 再起動は要らない、画面に `options changed — reloaded (2 hooks: session.start, tool.call)` と出る
- `title` を付けないと、行の名前が出ない ── `description` に例を書いておくと、選んだ画面で書式が分かる
- 保存先はユーザーの `~/.claude/settings.json` の `pluginConfigs[<name>@<marketplace>].options`（2.1.295 で1回確認、`security-scan@mods-bench-dev` のキーで入った）  
  プロジェクトの `.claude/settings.json` に書いても読まれない（[公式の settings のページ](https://code.claude.com/docs/en/settings-reference#pluginconfigs)で、`pluginConfigs` は user と managed のみ）  
  2026-09-28 にプロジェクトの設定に入ったと書いていたのは誤りか、版で変わったか、未確認
- 値は宣言した `type` に照合されてから、モジュールが読まれる ── 必須の項目が空なら、読み込みが項目名付きで失敗する
- `options` を宣言した文字列の項目は、`/config` が選択肢として描く ── 宣言外の値は未設定として扱われ、`default` が効く

環境変数やコードの直接の書き換えより、こちらを使う  
`/config` の行は、真偽値・選択肢・文字列・数値の4種類で、正規表現の並びのような構造は収まらない（実測）

## 状態を持つ

根拠: 実測（セッションを越えて残ることを1回、セッション同士で共有されることを session-usage で確認、2026-10-07）、JSON の扱いは型定義 `EngineInterface` の `store`

`$.store` はこのプラグイン専用のキーと値の保存領域で、**セッションと読み直しを越えて残り、同じマシンの全セッションで共有される**

```typescript
const count = Number((await $.store.get('count')) ?? 0) + 1
await $.store.set('count', count)
```

- `get` / `set` / `delete` / `keys`、`keys` は入れた順
- JSON のデータだけ ── `get` は `JSON.parse(JSON.stringify(value))` を読み戻すので、Date は ISO の文字列、`undefined` の項目は消え、Map と Set は `{}` になる
- 関数・循環参照・合計4MiB超は拒否される
- セッション同士で同じキーを読んで書くと、あとの書き込みが前を消す ── セッションごとに別のキーにする（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）
- 保存先は `~/.claude/plugins/store/` の下の、プラグインと出自ごとの JSON ファイル ── プロジェクトの中に置きたいなら `$.fs.write` を使う  
  置き方ごとに別のファイルになる ── `--plugin-dir` なら `<name>_inline-<ハッシュ>.json`、`.claude/skills/` なら `<name>_skills-dir-<ハッシュ>.json`（実測）

## `$.model.fork` の制約

根拠: 実測

会話の文脈を持った Claude に、モデルにもユーザーにも見えない形で1問投げられる

```typescript
const reply = await $.model.fork({ prompt: '...' })
```

**ただしフォークはツールを使えない**（`A model fork cannot use tools`）  
調べさせることはできず、文脈から答えるだけ

## mod は `$` の外に出られない

根拠: 実測（1回）

mod から、素の `fetch` や Node の組み込みモジュールは使えず、外とやり取りするには `$` を通るしかない

| 試したこと | 結果 |
|---|---|
| `globalThis.fetch(...)` | `globalThis.fetch is undefined` |
| `import('node:child_process')` | `cannot import "node:child_process"` |
| `import('node:fs')` | `cannot import "node:fs"` |
| `$.process.run(['node', '--version'])` | 通った |

外に出られないことは、見張れるという意味で、安全という意味ではない  
`$` そのものが、ファイル・コマンド・通信に届く  
公式も、mod は利用者の権限で動くので、信頼できる作者と marketplace のものだけ入れるよう書いている（[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）

使える `$` も、コードの静的スキャンに載ったものだけで、載っていない呼び出しは実行時に拒否される

```
$.http.fetch refused: its hooks module does not call it (host rule; the scan lists no calls)
```

- スキャンの結果は `claude plugin validate` の `calls:` で見られる
- スキャンのために書き方も縛られる ── `on()` のイベント名は文字列そのまま、名前で渡すフックはファイルの一番外側で宣言した関数でないと、読み込みで落ちる

```
the event name passed to on() is not a string literal
the hook "record" is not a function declared at the top of this file
```

## ターンの途中でモデルと effort を差し替える

根拠: 実測（Claude Code 2.1.281、各1〜2回）

`turn.step` は、モデルへの1回の問い合わせごとに上がる  
引数の `model` と `effort` を差し替えて `next` に渡すと、そのまま使われる

| 差し替え | 結果 |
|---|---|
| `model` を Haiku に | 出力の `modelUsage` と transcript の `model` が `claude-haiku-4-5-20251001` だけになった |
| `effort` を `low` / なし（`xhigh`） / `max` | 同じ問題で思考トークン 328 / 561 / 1,176、所要 4.3 / 6.3 / 11.0 秒 |
| 2手目だけ `max`、3手目で戻す | キャッシュの読み込みは差し替えなしと同じ 23,255 トークン、途中で変えてもキャッシュは切れない |

`turn.step` は流れてくるイベントなので、フックは `async function*` で書く（普通の `async` 関数だと読み込みで落ちる）

```typescript
on('turn.step', async function* ($, e, next) {
  return yield* next({ ...e, effort: 'max' })
})
```

同じ失敗が続いたら effort を上げる mod を試したが、詰まりが再現せず、効き目は示せなかった（Opus `low` 6回・Sonnet `low` 3回とも、同じ直し方を繰り返した回は無かった）

## 画面を描く

根拠: 実測（mod-permissions・file-map・session-usage を作ったとき、Claude Code 2.1.285 と 2.1.289）と、[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)

画面は `ui.render` のイベントで描く  
mod が足せる場所は、`AbovePrompt`（プロンプトのすぐ上の1行）と `Pane`（画面の右に開く領域）  
中身は `$.ui.resolve(e)` から取る `Box` `Text` `Button` などを組んで返す  
本体がもともと描いている部分（メッセージ、ツールの行、スピナーなど）も描き換えられる（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）

```typescript
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  const { Box, Text } = $.ui.resolve(e)
  const theirs = await next(e)
  const ours = Text({ children: '...' })
  return theirs ? Box({ flexDirection: 'column', children: [ours, theirs] }) : ours
})
```

- **プロンプトの上の1行は、入れた mod 全部で1か所を使う** ── 自分の表示を返すときも、`await next(e)` で受け取った他の mod の分を並べる（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）  
  並べずに返すと、内側の mod の表示が消える  
  このリポジトリの3本は並べる作りで、1つのプロジェクトに3本入れたとき、3行が縦に並んだ（2026-10-07、実測1回）  
  mod-permissions だけは、確認の欄を出している間はほかの mod の表示を並べない（ほかの mod のボタンとキーが重ならないように）
- **利用枠が逼迫すると、本体がプロンプトの上に使用量の知らせを出す** ── その間はプラグインの `AbovePrompt` のイベントが来ず、表示は出ない
- **mod が自分で開いた右の表示は、端末の横幅が144文字より狭いと出ない** ── debug ログに `ui.open ... waits unplaced (unasked below 144)` と出る  
  コマンドやボタンなど、ユーザーの操作で開いたものはどの幅でも出る（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）  
  このリポジトリの mod は、広い端末を前提にする
- **右の表示は、コマンドを待たずに自動で開く** ── 中身ができた時点で開く（session-usage は起動時、file-map は最初の読み書き）  
  自動で開くときは `focus` を付けず、プロンプトへの入力を奪わない  
  コマンドやボタンで開くときだけ `focus: true` を付ける  
  ユーザーが閉じたら、そのセッションでは開き直さない（閉じたのがユーザーかは `ui.close` の `e.origin.kind === 'person'`、[公式のリファレンス](https://code.claude.com/docs/en/plugins/mods/reference)、未実測）
- **`$.ui.open` の `focus` と `closeOnEscape` は `true` しか受け付けない** ── 付けないときは項目ごと省く（[公式の interface のページ](https://code.claude.com/docs/en/plugins/mods/interface)）
- **`Text` に余白は付けられない** ── `marginTop` などを渡すと `Text prop "marginTop" is not allowed` で表示されず、余白は `Box` で取る  
  `Text` と `Box` に付けられる属性の一覧は、claude.exe のコードから抜き出した（テストの `ALLOWED`）
- **属性の値に `undefined` を渡すと表示されない**（`... prop "color" is undefined`） ── 付けたり付けなかったりする属性は、条件付きで足す（`...(cond ? { color: 'green' } : {})`）
- **色つきのマス目は `Raster` で描ける**（session-usage で実測） ── `cells` は、1マスごとに文字・文字の色・背景の色の3つの数を `Uint32Array` に並べ、base64 にしたもの  
  `Raster` は端末だけで、デスクトップアプリでは描かれないので、`e.surface` を見て出し分ける
- **テストで押下まで確かめられる** ── `$.ui.mount({ plugin, surface: 'terminal', component, props, viewport })` で組み立て、`drawn()` で描いた中身、`press({ key })` でボタンを押す

### スラッシュコマンドを足す

根拠: 実測と、[公式の Use the mods API のページ](https://code.claude.com/docs/en/plugins/mods/api)

`$.command.register({ name, description })` で `/コマンド` を足せる  
`session.start` で登録し、`command.run` で受け取る  
関数がその場で動き、Claude への問い合わせは起きない

```typescript
on('session.start', async ($, e, next) => {
  const r = await next(e)
  await $.command.register({ name: 'map', description: '...' })
  return r
})
on('command.run', { command: 'map' }, async ($, e) => {
  // 画面に描くだけなら {} を返す
  return {}
})
```

- **返した `text` は会話に入り、Claude が読む**（[公式の Use the mods API のページ](https://code.claude.com/docs/en/plugins/mods/api)） ── 画面に描くだけのコマンドは `{}` を返し、トークンを使わない
- **対話のコマンド一覧に出るのは Claude Code 2.1.287 以降** ── 2.1.285 では `claude -p "/map"` では動くのに、対話では Unknown command になった（公式サンプルの `/replay` も同じ）  
  2.1.287 で mod が正式公開された
- **本体のコマンドと同じ名前は登録できない** ── `$.command.register` が例外を投げ、そのフックの残りも動かない（[公式の Use the mods API のページ](https://code.claude.com/docs/en/plugins/mods/api)）

### 答えを待つ間、呼び出しを止めておく

根拠: 実測

フックが自分のコードに使える時間は10秒だが、`$` を呼んで待っている時間は数えない  
`$.process.run(['sleep', '0.25'])` を繰り返し、ボタンが押されるまで止めておく（Blast Radius と同じ）  
画面の無いセッション（`session.start` の `isInteractive` が false）では聞けないので、止めるか通すかを先に決める

### ほかのプラグインの登録を見る

根拠: 実測（2026-10-07、Claude Code 2.1.289）

`plugin.register` のイベントで、あとから読み込まれる mod のフックと、使う `$` が分かる（引数の `uses`）

- **自分より後に読み込まれた mod しか見えない**
- `.claude/skills/` に置いた mod は、名前の順に読み込まれる（ディレクトリ名とプラグイン名をそろえて試した）
- `/plugin` で入れた mod 同士は、`settings.json` の `enabledPlugins` に並んだ順（入れた順）で、名前の順ではない（入れる順を変えて3回）
- `--plugin-dir` で読み込んだ mod は、`/plugin` で入れた mod より先に読み込まれる（1回）
- 見るのは利用者が入れた mod だけにする（`next.origin.tier === 'user'`） ── 同梱や管理者のプラグインを止めると、指示ファイルの読み込みなど本体の機能が壊れる

## 画像の描画

根拠: [公式のリファレンス](https://code.claude.com/docs/en/plugins/mods/reference)、**未実測**

画像は `Image` の部品で描く  
渡せるのは PNG か RGBA のバイト列（2 MiB まで）か、ファイルのパス  
描けるのは端末だけで、PNG を作る処理は自前で用意する

## 参照

- **型定義** ── mod を `--plugin-dir` で読み込むと `.claude-plugin/types/` に書き出される、公式リポジトリなら `mods/types/claude-code.d.ts`
- **組み込み mod のソース** ── 公式リポジトリの `mods/`（`diff` `agents-md` `sec-default` `telemetry`、[公式の mods の概要のページ](https://code.claude.com/docs/en/plugins/mods/overview)）、実装の作法はここを見る
- **公式ドキュメント** ── mods の概要・Create a mod・Draw in the interface・Use the mods API・Mods reference（code.claude.com/docs/en/plugins/mods/）

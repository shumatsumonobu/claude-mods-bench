import type { On, PluginOptions } from 'claude-code'

/**
 * 自分の名前、plugin.json の name とそろえる
 * 自分の `$` 呼び出しも自分のフックを通るので、この名前の呼び出しは見張らずに通す
 */
const SELF = 'mod-permissions'

/** 入れたときの一覧を画面の右に開くときの ID */
const CARD_PANE = 'mod-permissions-cards'
/** 答えを待つ間、`sleep` で止める1回の秒数 */
const POLL_SECONDS = '0.25'
/** ログに残す行数の上限 */
const LOG_LIMIT = 1000

/** 確認する操作の種類 */
type Kind = 'net' | 'run' | 'write' | 'config' | 'read' | 'mcp' | 'env' | 'settings' | 'prompt'
/** 確認の欄での答え ── 今回だけ許可、常に許可、拒否 */
type Choice = 'once' | 'always' | 'deny'

/** 何をしようとしているかの動詞句、確認の欄とログに出す（`${plugin} wants to ...`） */
const KIND_LABEL: Record<Kind, string> = {
  net: 'make a network request',
  run: 'run a command',
  write: 'write outside the project',
  config: 'change Claude Code settings or instructions',
  read: 'read outside the project',
  mcp: 'call an MCP tool',
  env: 'read an environment variable',
  settings: 'read Claude Code settings',
  prompt: 'submit a prompt on your behalf',
}

/**
 * 常に許可すると、中身を問わず何でも通ってしまう種類
 * 確認の欄に赤字で注記する
 */
const BLANK_CHECK: Partial<Record<Kind, string>> = {
  run: 'this command runs with any arguments. Allowing node or bash allows anything they can do',
  net: 'this plugin may send anything to this host',
}

/**
 * mod が使う `$` を、できることの言葉に直す（入れたときの一覧に出す）
 * ここに載せたものは、下で必ず確認の対象にする ── 一覧に出すだけで止めないと、守れないものを守れるように見せてしまう
 */
const CALL_LABEL: Record<string, string> = {
  'http.fetch': 'make network requests',
  'process.run': 'run commands',
  'process.spawn': 'run commands',
  'fs.write': 'write files',
  'fs.read': 'read files',
  'mcp.call': 'call MCP tools (incl. sending email)',
  'env.get': 'read environment variables (may hold secrets)',
  'settings.read': 'read Claude Code settings',
  'prompt.submit': 'submit prompts on your behalf',
}

/** mod が受け取るイベントを、見て書き換えられるものの言葉に直す（入れたときの一覧に出す） */
const EVENT_LABEL: Record<string, string> = {
  '*': 'see and rewrite every event',
  'tool.call': 'see and rewrite tool calls and results',
  'prompt.submit': 'see and rewrite submitted prompts',
  'prompt.context': 'see and rewrite CLAUDE.md and other instructions',
  'turn.step': 'see and rewrite model responses',
}

/** 確認している1件 ── だれが、何を、どこに、の内容と、ボタンで決まった答え */
type Ask = { plugin: string; kind: Kind; target: string; detail: string; choice: Choice | null }
/** 入れたときの一覧に出す mod 1つ ── 名前、版、新しく入ったか、できること */
type Card = { name: string; version: string; isNew: boolean; abilities: string[] }

/** 許可していない操作をどうするか（`/config` の When not allowed） */
let mode = 'ask'
/** 答えを待つ時間（ミリ秒、`/config` の Seconds to wait） */
let waitMs = 60_000
/** 画面のあるセッションか、画面が無いと確認できない */
let interactive = true
/** プロジェクトの場所 */
let root = ''
/** いま確認の欄に出している1件、無ければ null */
let held: Ask | null = null
/** 入れたときの一覧に出す mod */
let cards: Card[] = []
/** 一覧に出した mod のできること、一覧を閉じたときに見たものとして保存する */
const shown: Record<string, string[]> = {}
/** プロンプトの上の1行に出す、許可した数と止めた数 */
const counts = { allowed: 0, denied: 0 }
/**
 * 答えが無いまま時間切れになったプラグイン
 * そのセッションの間は確認せずに止める（席を外している人を、何度も待たせない）
 */
const silenced = new Set<string>()

/** ログへの追記を1本ずつ順に流す、読んで書く間に別の追記が割り込むと片方が消えるため */
let queue: Promise<unknown> = Promise.resolve()

/** パスの区切りを `/` にそろえ、末尾の `/` を取る */
export function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** パスのフォルダ部分 */
export function dirOf(path: string): string {
  const p = norm(path)
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : p
}

/** プロジェクトの中のパスか、Windows に合わせて大文字と小文字を区別しない */
export function inside(path: string, base: string): boolean {
  if (base === '') return false
  const p = norm(path).toLowerCase()
  const b = norm(base).toLowerCase()
  return p === b || p.startsWith(b + '/')
}

/**
 * プロジェクトの中の、設定や指示のファイルか（`.claude/` の下と、`CLAUDE.md` `AGENTS.md` `CLAUDE.local.md`）
 * ここを書き換えられると、次のセッションの設定や指示が変わる
 * たとえば `.claude/settings.json` に mod-permissions を無効にする設定を書かれると、以降この mod は何も止めなくなる
 * そのため、プロジェクトの中でも、ここへの書き込みだけは確認する
 */
export function isConfig(path: string, base: string): boolean {
  if (!inside(path, base)) return false
  const rel = norm(path).toLowerCase().slice(norm(base).length)
  return rel.includes('/.claude/') || /\/(claude|agents)\.md$/.test(rel) || /\/claude\.local\.md$/.test(rel)
}

/** URL のホスト名、URL として読めなければそのまま */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 実行するコマンドの名前（引数の1つ目の、パスを除いた部分） */
export function commandOf(argv: unknown): string {
  const first = Array.isArray(argv) ? String(argv[0] ?? '') : String(argv ?? '')
  return norm(first).split('/').pop() ?? first
}

/**
 * この呼び出しを見張るか、見張るなら呼び出し元の名前、見張らないなら null
 * 見張るのは、利用者が自分で入れた mod（tier が user）だけ
 * 自分の呼び出しと、Claude Code に同梱されたプラグインや管理者が入れたプラグイン（builtin・prepend・append）は通す
 * 後者を止めると、指示ファイルの読み込みのような本体の動きまで壊れるため
 */
export function policed(next: any): string | null {
  const o = next?.origin
  const plugin = typeof o?.plugin === 'string' ? o.plugin : ''
  if (plugin === '' || plugin === SELF) return null
  if (o?.tier !== 'user') return null
  return plugin
}

/** mod が使う `$` と受け取るイベントから、入れたときの一覧に並べるできることを作る、重なりは1つにまとめる */
export function abilitiesOf(uses: { calls?: string[]; events?: string[] } | undefined): string[] {
  const out = [
    ...(uses?.events ?? []).map((e) => EVENT_LABEL[e]),
    ...(uses?.calls ?? []).map((c) => CALL_LABEL[c]),
  ].filter((s): s is string => typeof s === 'string')
  return [...new Set(out)]
}

/** 前に見た版から増えたできることだけを返す、初めて見る mod なら全部 */
export function addedAbilities(now: string[], before: string[] | undefined): string[] {
  if (before === undefined) return now
  return now.filter((a) => !before.includes(a))
}

/**
 * プロジェクトの場所
 * ファイルを直すと mod はその場で読み直され、そのときは session.start が来ないので、空なら取りに行く
 */
async function rootOf($: any): Promise<string> {
  if (root === '') root = norm(String(await $.session.root()))
  return root
}

/** ログ（`.claude/mod-permissions.log`）に1行足す、上限を超えた古い行は捨てる */
async function log($: any, line: string) {
  const file = `${await rootOf($)}/.claude/mod-permissions.log`
  const stamp = new Date().toISOString()
  const run = async () => {
    const prev = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
    const lines = [...prev.split('\n').filter((l) => l !== ''), `${stamp} ${line}`]
    await $.fs.write(file, lines.slice(-LOG_LIMIT).join('\n') + '\n')
  }
  await (queue = queue.then(run, run))
}

/** 止めたときに、止められた mod と Claude に届く文 */
function refusal(plugin: string, kind: Kind, target: string, why: string): string {
  return `mod-permissions: blocked ${plugin} from trying to ${KIND_LABEL[kind]} (${target}). ${why}`
}

/**
 * 許すかを決める、通すなら null、止めるなら理由を返す
 * 常に許可と拒否は `$.store` に保存し、次のセッションでも確認しない
 * 画面の無いセッションでは確認できないので止める
 * 確認するときは呼び出しを止めたまま待ち、プロンプトの上の欄のボタンで決める
 * 待つのは `$` の中（`sleep`）なので、フックの持ち時間には数えられない
 */
export async function gate($: any, plugin: string, next: any, kind: Kind, target: string, detail: string): Promise<string | null> {
  const key = `${plugin} ${kind} ${target}`
  const grants: Record<string, string> = ((await $.store.get('grants')) as Record<string, string> | undefined) ?? {}

  const settle = async (allow: boolean, note: string) => {
    if (allow) counts.allowed++
    else counts.denied++
    $.ui.invalidate('ui.render')
    await log($, `${plugin} ${KIND_LABEL[kind]} ${detail} ${note}`).catch(() => {})
  }

  if (grants[key] === 'always') {
    await settle(true, 'allowed (rule)')
    return null
  }
  if (grants[key] === 'never') {
    await settle(false, 'blocked (rule)')
    return refusal(plugin, kind, target, 'denied before')
  }
  if (mode === 'log only') {
    await settle(true, 'logged only')
    return null
  }
  if (silenced.has(plugin)) {
    await settle(false, 'blocked (silenced this session)')
    return refusal(plugin, kind, target, 'no answer earlier, blocked for the rest of this session')
  }
  if (mode === 'block' || !interactive) {
    await settle(false, 'blocked (cannot ask)')
    return refusal(plugin, kind, target, mode === 'block' ? 'settings block anything not allowed' : 'cannot ask in a screenless session')
  }

  // 1件ずつ確認する、先に確認しているものがあれば、答えが出るまで待つ
  while (held !== null) {
    if (next.signal?.aborted) return refusal(plugin, kind, target, 'turn interrupted')
    await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
  }
  const mine: Ask = { plugin, kind, target, detail, choice: null }
  held = mine

  // 確認の欄はプロンプトの上に出す、画面の右は端末が狭いと開かず、何も見えないまま待つことになるため
  let choice: Choice | 'timeout' | 'interrupted' | 'error'
  try {
    $.ui.invalidate('ui.render')
    const startedAt = await $.clock.now()
    while (mine.choice === null) {
      if (next.signal?.aborted) break
      if ((await $.clock.now()) - startedAt > waitMs) break
      await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
    }
    choice = mine.choice ?? (next.signal?.aborted ? 'interrupted' : 'timeout')
  } catch {
    choice = 'error'
  } finally {
    if (held === mine) held = null
    $.ui.invalidate('ui.render')
  }

  if (choice === 'always') {
    await $.store.set('grants', { ...grants, [key]: 'always' })
  }
  if (choice === 'once' || choice === 'always') {
    await settle(true, choice === 'always' ? 'allowed (always)' : 'allowed (once)')
    return null
  }
  if (choice === 'deny') {
    await $.store.set('grants', { ...grants, [key]: 'never' })
  }
  if (choice === 'timeout') silenced.add(plugin)
  const why = {
    deny: 'denied by user',
    timeout: `no answer within ${Math.round(waitMs / 1000)}s`,
    interrupted: 'turn interrupted',
    error: 'error while asking',
  }[choice]
  await settle(false, why)
  return refusal(plugin, kind, target, why)
}

/** ほかの mod の通信（`$.http.fetch`）を、宛先のホストごとに確認する */
export async function onFetch($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const url = String(e.url ?? '')
  const why = await gate($, plugin, next, 'net', hostOf(url), url.slice(0, 200))
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod のコマンド実行（`$.process.run`）を、コマンドの名前ごとに確認する */
export async function onRun($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const argv = Array.isArray(e.argv) ? e.argv.map(String) : [String(e.argv ?? '')]
  const why = await gate($, plugin, next, 'run', commandOf(argv), argv.join(' ').slice(0, 200))
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod の、出力を流し続けるコマンド実行（`$.process.spawn`）を確認する */
export async function* onSpawn($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return yield* next(e)
  const argv = Array.isArray(e.argv) ? e.argv.map(String) : [String(e.argv ?? '')]
  const why = await gate($, plugin, next, 'run', commandOf(argv), argv.join(' ').slice(0, 200))
  if (why !== null) return { deny: why }
  return yield* next(e)
}

/** ほかの mod のファイルの書き込み（`$.fs.write`）を確認する、プロジェクトの中は設定や指示のファイルだけ */
export async function onWrite($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const path = String(e.path ?? '')
  const base = await rootOf($)
  // プロジェクトの中でも、設定や指示のファイルは確認する、それ以外のプロジェクトの中の書き込みは通す
  if (inside(path, base)) {
    if (!isConfig(path, base)) return next(e)
    const why = await gate($, plugin, next, 'config', norm(path).slice(norm(base).length + 1), norm(path))
    return why === null ? next(e) : { deny: why }
  }
  const why = await gate($, plugin, next, 'write', dirOf(path), norm(path))
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod の、プロジェクトの外のファイルの読み取り（`$.fs.read`）を、フォルダごとに確認する */
export async function onRead($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const path = String(e.path ?? '')
  if (inside(path, await rootOf($))) return next(e)
  const why = await gate($, plugin, next, 'read', dirOf(path), norm(path))
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod の MCP ツールの呼び出し（`$.mcp.call`）を、サーバーとツールごとに確認する */
export async function onMcp($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const target = `${String(e.server ?? '')}/${String(e.tool ?? '')}`
  const why = await gate($, plugin, next, 'mcp', target, target)
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod の環境変数の読み取り（`$.env.get`）を、変数の名前ごとに確認する */
export async function onEnv($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const name = String(e.name ?? '')
  const why = await gate($, plugin, next, 'env', name, name)
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod の、Claude Code の設定の読み取り（`$.settings.read`）を確認する */
export async function onSettings($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const source = String(e.source ?? '')
  const why = await gate($, plugin, next, 'settings', source, source)
  return why === null ? next(e) : { deny: why }
}

/** ほかの mod が、利用者の代わりにプロンプトを送ること（`$.prompt.submit`）を確認する */
export async function onPrompt($: any, e: any, next: any) {
  const plugin = policed(next)
  if (plugin === null) return next(e)
  const text = String(e.text ?? '')
  const why = await gate($, plugin, next, 'prompt', plugin, text.slice(0, 200))
  return why === null ? next(e) : { deny: why }
}

/** 自分より後に読み込まれる mod のできることを控え、前に見た版から増えたものを入れたときの一覧に出す */
export async function onRegister($: any, e: any, next: any) {
  if (e.name !== SELF && e.tier === 'user') {
    const abilities = abilitiesOf(e.uses)
    const seen: Record<string, string[]> = ((await $.store.get('abilities')) as Record<string, string[]> | undefined) ?? {}
    const added = addedAbilities(abilities, seen[e.name])
    if (added.length > 0) {
      cards.push({ name: String(e.name), version: String(e.version ?? ''), isNew: seen[e.name] === undefined, abilities: added })
      shown[e.name] = abilities
    }
  }
  return next(e)
}

/** セッションの始まり ── 画面があるかを見て、入れたときの一覧に出すものがあれば画面の右に開く */
export async function onStart($: any, e: any, next: any) {
  interactive = e.isInteractive !== false
  silenced.clear()
  root = norm(String(e.cwd ?? (await $.session.root())))
  if (interactive && cards.length > 0) {
    await $.ui.open({ id: CARD_PANE, title: 'Mod permissions', rows: 4 + cards.length * 3 })
    $.ui.invalidate('ui.render')
  }
  return next(e)
}

/** 最初のプロンプトを送ったら入れたときの一覧を閉じ、見せたできることを見たものとして保存する */
export async function onTurn($: any, e: any, next: any) {
  if (cards.length > 0 && interactive) {
    const seen: Record<string, string[]> = ((await $.store.get('abilities')) as Record<string, string[]> | undefined) ?? {}
    await $.store.set('abilities', { ...seen, ...shown })
    cards = []
    try {
      await $.ui.close({ id: CARD_PANE })
    } catch {
      // 開いていなかった
    }
  }
  return next(e)
}

/** 確認の欄、ボタンは描いた時点の1件にだけ答える */
export function drawAsk(t: any, ask: Ask) {
  const { Box, Text, Button } = t
  const answer = (choice: Choice) => () => {
    if (ask.choice === null) ask.choice = choice
  }
  const caution = BLANK_CHECK[ask.kind]
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'yellow',
    paddingX: 1,
    children: [
      Text({ key: 'title', bold: true, color: 'yellow', children: `${ask.plugin} wants to ${KIND_LABEL[ask.kind]}` }),
      Text({ key: 'target', children: [Text({ dimColor: true, children: 'Target  ' }), Text({ bold: true, children: ask.target })], wrap: 'truncate-end' }),
      Text({ key: 'detail', children: [Text({ dimColor: true, children: 'Detail  ' }), Text({ children: ask.detail })], wrap: 'truncate-end' }),
      Box({
        key: 'buttons',
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: 'once', label: 'Allow once', hotkey: '1', plain: true, onPress: answer('once') }),
          Button({ key: 'always', label: 'Always allow', hotkey: '2', plain: true, onPress: answer('always') }),
          Button({ key: 'deny', label: 'Deny', hotkey: '3', plain: true, autoFocus: true, onPress: answer('deny') }),
        ],
      }),
      caution ? Text({ key: 'caution', color: 'red', children: `Always allow: ${caution}` }) : null,
      Text({ key: 'hint', dimColor: true, children: 'Press 1, 2 or 3, or click a button. This call is paused until you answer.' }),
    ],
  })
}

/** 入れたときの一覧 ── 新しく入った mod と、更新で増えたできること */
export function drawCards(t: any, list: Card[]) {
  const { Box, Text } = t
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    children: [
      Text({ key: 'title', bold: true, color: 'cyan', children: 'Mod permissions · new plugins / newly added access' }),
      ...list.map((c, i) =>
        Box({
          key: `c${i}`,
          flexDirection: 'column',
          marginTop: 1,
          children: [
            Text({ key: 'name', bold: true, children: `${c.name} ${c.version} ${c.isNew ? '(new)' : '(added)'}` }),
            ...c.abilities.map((a, j) => Text({ key: `a${j}`, ...(c.isNew ? {} : { color: 'magenta' }), children: `  · ${a}` })),
          ],
        }),
      ),
      Box({ key: 'hint', marginTop: 1, children: [Text({ dimColor: true, children: "You'll be asked the first time each is used. Closes when you send your next prompt." })] }),
    ],
  })
}

/** プロンプトの上の1行 ── 止めた数と許可した数、まだ何も確認していなければ出さない */
export function drawBand(t: any, c: { allowed: number; denied: number }) {
  if (c.allowed === 0 && c.denied === 0) return null
  const { Box, Text } = t
  return Box({
    paddingX: 1,
    children: [
      Text({ key: 'name', bold: true, color: 'cyan', children: 'Mod permissions · ' }),
      Text({ key: 'denied', ...(c.denied > 0 ? { color: 'red' } : {}), children: `blocked ${c.denied}` }),
      Text({ key: 'sep', dimColor: true, children: ' · ' }),
      Text({ key: 'allowed', children: `allowed ${c.allowed}` }),
    ],
  })
}

/** 画面の右に、入れたときの一覧を描く */
export function onPane($: any, e: any, next: any) {
  if (e.requestId === CARD_PANE && cards.length > 0) return drawCards($.ui.resolve(e), cards)
  return next(e)
}

/**
 * プロンプトの上の1行を描く ── 確認している最中はその欄、それ以外は止めた数と許可した数
 * 確認している最中は、ほかの mod のボタンとキーが重ならないよう、確認の欄だけを出す
 * それ以外は、ほかの mod の表示を消さないよう、自分の1行の下に並べる
 */
export async function onBand($: any, e: any, next: any) {
  const t = $.ui.resolve(e)
  if (held !== null) return drawAsk(t, held)
  const ours = drawBand(t, counts)
  const theirs = await next(e)
  if (ours === null) return theirs
  if (!theirs) return ours
  return t.Box({ flexDirection: 'column', children: [ours, theirs] })
}

/**
 * mod の入口 ── 入れたほかの mod が外とやり取りしようとしたら、mod ごとに許すかを決める
 * mod は `$` を通さずに外とやり取りできない（素の fetch は無く、node:child_process と node:fs は import できない）
 * 確認するもの ── 通信、コマンド実行、プロジェクトの外の読み書き、プロジェクトの中の設定や指示のファイルの書き換え、MCP の呼び出し、環境変数の読み取り、設定の読み取り、利用者の代わりのプロンプト送信
 * 確認しないもの ── プロジェクトの中のふつうの読み書き（外へ出す手段を押さえているので、読んでも外へは出せない）、`$.model.*` などモデルへの問い合わせ
 * 見張るのは利用者が入れた mod だけで、同梱や管理者のプラグインは通す
 */
export function register(on: On, options?: PluginOptions) {
  mode = String(options?.mode ?? 'ask')
  waitMs = Number(options?.waitSeconds ?? 60) * 1000
  on('http.fetch', onFetch)
  on('process.run', onRun)
  on('process.spawn', onSpawn)
  on('fs.write', onWrite)
  on('fs.read', onRead)
  on('mcp.call', onMcp)
  on('env.get', onEnv)
  on('settings.read', onSettings)
  on('prompt.submit', onPrompt)
  on('plugin.register', onRegister)
  on('session.start', onStart)
  on('turn.start', onTurn)
  on('ui.render', { component: 'Pane' }, onPane)
  on('ui.render', { component: 'AbovePrompt' }, onBand)
}

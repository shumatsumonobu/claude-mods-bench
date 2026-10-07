import type { On, PluginOptions } from 'claude-code'

/** 画面の右に開く表示の ID、`ui.render` で自分の表示かを見分けるのにも使う */
const PANE_ID = 'security-scan'

/** 調べるファイルの拡張子、ここに無いもの（文書や画像など）は Semgrep に渡さない */
const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|php|rb|go|java|kt|cs|rs|swift|scala|vue|svelte|html|yml|yaml|tf|sh)$/i

/** 見つかった問題1件 ── 同じ行に当たったルールは1件にまとめる */
export type Finding = {
  /** 誤検知として覚えるときのキー、ルールごとに1つ ── ルール・ファイル・その行の中身（行番号がずれても同じになる） */
  keys: string[]
  path: string
  line: number
  /** 当たったルールの短い名前（`node_sqli_injection` など） */
  rules: string[]
  /** 当たったルールのうち、いちばん高い深刻度 */
  severity: string
  /** いちばん深刻なルールの説明 */
  message: string
  /** その行のソース */
  code: string
}

type Action = 'fix' | 'ignore' | 'later' | 'next' | 'prev' | 'undo'

/** 今ふるい分けている一覧と、表示しているカードの位置 */
let findings: Finding[] = []
let cur = 0
/** 直前に誤検知にしたカードと、その位置 ── Undo で戻す */
let lastIgnored: { f: Finding; at: number } | null = null
/** 調べている最中か、調べたファイルの数、最後のエラー */
let scanning = false
let scannedFiles = 0
let lastError = ''
/** Semgrep が起動できなかったか ── 入れ方を案内する */
let missing = false
/** 設定 ── Semgrep の実行ファイルとルールの組 */
let semgrep = 'semgrep'
let rules: string[] = []
/** プロジェクトの場所 */
let root = ''

/** 深刻度の順位、小さいほど深刻 */
const rank = (s: string) => (s === 'ERROR' ? 0 : s === 'WARNING' ? 1 : 2)

/** パスの区切りを `/` にそろえ、プロジェクトからの相対にする */
export function relPath(base: string, path: string): string {
  const p = path.replace(/\\/g, '/')
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '')
  return b !== '' && p.toLowerCase().startsWith(b.toLowerCase() + '/') ? p.slice(b.length + 1) : p
}

/** `git status --porcelain` の出力から、変更中・未追跡のコードのファイルを取り出す（消したファイルは除く） */
export function changedFiles(porcelain: string): string[] {
  const files: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    if (status.includes('D')) continue
    let path = line.slice(3).trim()
    // 名前の変更は `旧 -> 新` の形で来るので、新しいほうを取る
    if (path.includes(' -> ')) path = path.split(' -> ')[1]
    path = path.replace(/^"|"$/g, '')
    if (CODE_EXT.test(path)) files.push(path)
  }
  return files
}

/**
 * Semgrep の JSON を、ふるい分けの一覧にする
 * 同じ行に当たったルールは1件にまとめ、誤検知として覚えたルールは除く
 */
export function parseResults(json: string, base: string, readLine: (path: string, line: number) => string, ignored: Set<string> = new Set()): Finding[] {
  const out = JSON.parse(json)
  const byLine = new Map<string, Finding>()
  for (const r of out.results ?? []) {
    const path = relPath(base, String(r.path ?? ''))
    const line = Number(r.start?.line ?? 0)
    const rule = String(r.check_id ?? '').split('.').pop() ?? ''
    const code = readLine(path, line)
    const key = `${rule}|${path}|${code.trim()}`
    if (ignored.has(key)) continue
    const severity = String(r.extra?.severity ?? 'INFO')
    const message = firstSentence(String(r.extra?.message ?? ''))
    const f = byLine.get(`${path}:${line}`)
    if (!f) {
      byLine.set(`${path}:${line}`, { keys: [key], path, line, rules: [rule], severity, message, code })
      continue
    }
    if (f.keys.includes(key)) continue
    f.keys.push(key)
    f.rules.push(rule)
    // いちばん深刻なルールの深刻度と説明を出す
    if (rank(severity) < rank(f.severity)) {
      f.severity = severity
      f.message = message
    }
  }
  // 深刻度の高い順、同じなら場所の順
  return [...byLine.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line)
}

/** 説明の最初の1文、長ければ切る */
export function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  const end = s.search(/[.。](\s|$)/)
  const one = end > 0 ? s.slice(0, end + 1) : s
  return one.length > 160 ? one.slice(0, 157) + '...' : one
}

/** Claude に渡す文 ── 誤検知もありうることを添えて、本物なら直してもらう */
export function fixPrompt(f: Finding): string {
  return [
    'Semgrep reported this possible security issue. Check whether it is real, and if it is, fix it with the smallest change.',
    `${f.path}:${f.line} (${f.rules.join(', ')}, ${f.severity})`,
    f.message,
    `Code: ${f.code.trim()}`,
  ].join('\n')
}

/** 深刻度を、使う人に伝わる言葉にする */
export function riskLabel(severity: string): string {
  return severity === 'ERROR' ? 'High risk' : severity === 'WARNING' ? 'Medium risk' : 'Low risk'
}

/** 件数の言い方 */
const issues = (n: number) => `${n} possible issue${n === 1 ? '' : 's'}`

/** 画面の右に出すカード */
export function drawPane(t: any, onAction: (a: Action) => void) {
  const { Box, Text, Button } = t
  const head = (text: string) => Text({ key: 'title', bold: true, color: 'red', children: text })
  const frame = (children: any[]) => Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'red', paddingX: 1, children })
  const undo = lastIgnored ? [Button({ key: 'undo', label: 'Undo', hotkey: 'u', plain: true, onPress: () => onAction('undo') })] : []

  if (scanning) return frame([head('Security scan · scanning'), Text({ key: 'msg', dimColor: true, children: 'Running Semgrep on the changed files...' })])
  if (missing)
    return frame([
      head('Security scan · Semgrep not found'),
      Text({ key: 'install', children: 'Install it once:  uv tool install semgrep   (or: pipx install semgrep)' }),
      Text({ key: 'path', children: 'Installed somewhere else? Set the path in /config:' }),
      Text({ key: 'row', dimColor: true, children: `  Semgrep command · security-scan  (now: ${semgrep})` }),
      Text({ key: 'then', children: 'Then run /scan.' }),
    ])
  if (lastError !== '') return frame([head('Security scan · scan failed'), Text({ key: 'msg', children: lastError })])
  if (findings.length === 0) {
    const msg = scannedFiles === 0 ? 'No changed code files. Run /scan after editing code.' : `Nothing found in ${scannedFiles} changed file${scannedFiles === 1 ? '' : 's'}.`
    return frame([head(`Security scan · ${issues(0)}`), Text({ key: 'msg', dimColor: true, children: msg }), ...(undo.length ? [Box({ key: 'buttons', marginTop: 1, children: undo })] : [])])
  }

  const f = findings[cur]
  const sevColor = f.severity === 'ERROR' ? { color: 'red' } : f.severity === 'WARNING' ? { color: 'yellow' } : {}
  return frame([
    head(`Security scan · ${issues(findings.length)}`),
    Box({
      key: 'card',
      flexDirection: 'column',
      marginTop: 1,
      children: [
        Text({ key: 'where', bold: true, children: `${cur + 1} of ${findings.length} · ${f.path} line ${f.line}` }),
        Text({ key: 'risk', bold: true, ...sevColor, children: riskLabel(f.severity) }),
        Text({ key: 'code', dimColor: true, wrap: 'truncate-end', children: `  ${f.code.trim()}` }),
        Text({ key: 'msg', children: f.message }),
        Text({ key: 'rule', dimColor: true, children: `Semgrep rule: ${f.rules.join(', ')}` }),
      ],
    }),
    // ボタンは、このカードへの操作と、カードの移動の2行に分ける（折り返すと行の間に空行が入るため）
    Box({
      key: 'actions',
      marginTop: 1,
      gap: 2,
      children: [
        Button({ key: 'fix', label: 'Ask Claude to fix', hotkey: 'f', plain: true, onPress: () => onAction('fix') }),
        Button({ key: 'ignore', label: 'Not a problem', hotkey: 'x', plain: true, onPress: () => onAction('ignore') }),
        Button({ key: 'later', label: 'Skip for now', hotkey: 'l', plain: true, onPress: () => onAction('later') }),
      ],
    }),
    Box({
      key: 'moves',
      gap: 2,
      children: [
        Button({ key: 'prev', label: 'Back', hotkey: 'p', plain: true, onPress: () => onAction('prev') }),
        Button({ key: 'next', label: 'Next', hotkey: 'n', plain: true, onPress: () => onAction('next') }),
        ...undo,
      ],
    }),
    Text({ key: 'hint', dimColor: true, children: '"Not a problem" hides this in later scans. /scan reset brings them back.' }),
  ])
}

/** プロンプトの上の1行 ── ふるい分けが残っているときだけ */
export function drawBand(t: any, onOpen: () => void) {
  if (findings.length === 0) return null
  const { Box, Text, Button } = t
  return Box({
    gap: 2,
    paddingX: 1,
    children: [
      Text({ key: 'label', bold: true, color: 'red', children: `Security scan · ${issues(findings.length)}` }),
      Button({ key: 'open', label: 'Open', hotkey: 'v', plain: true, onPress: onOpen }),
    ],
  })
}

/** 誤検知として覚えたキーの一覧 */
async function ignoredKeys($: any): Promise<string[]> {
  const v = await $.store.get('ignored')
  return Array.isArray(v) ? v : []
}

/** カードのボタンの処理 */
export async function act($: any, a: Action) {
  if (a === 'undo') {
    if (!lastIgnored) return
    const { f, at } = lastIgnored
    const keys = await ignoredKeys($)
    await $.store.set('ignored', keys.filter((k) => !f.keys.includes(k)))
    findings.splice(Math.min(at, findings.length), 0, f)
    cur = Math.min(at, findings.length - 1)
    lastIgnored = null
    $.ui.invalidate('ui.render')
    return
  }
  if (findings.length === 0) return
  const f = findings[cur]
  if (a === 'next') cur = (cur + 1) % findings.length
  else if (a === 'prev') cur = (cur - 1 + findings.length) % findings.length
  else if (a === 'later') {
    findings.splice(cur, 1)
    findings.push(f)
    if (cur >= findings.length) cur = 0
  } else {
    const at = cur
    findings.splice(cur, 1)
    if (cur >= findings.length) cur = 0
    if (a === 'ignore') {
      const keys = await ignoredKeys($)
      await $.store.set('ignored', [...keys, ...f.keys.filter((k) => !keys.includes(k))])
      lastIgnored = { f, at }
    } else {
      // 返事を待つと Claude の作業が終わるまで止まるので、待たずに送る
      void $.prompt.submit({ text: fixPrompt(f) })
      $.ui.toast(`Sent to Claude: ${f.path}:${f.line}`)
    }
  }
  $.ui.invalidate('ui.render')
}

/** 誤検知として覚えたものを全部忘れる */
export async function resetIgnored($: any) {
  await $.store.set('ignored', [])
  lastIgnored = null
}

/** 変更中のファイルを Semgrep で調べ、誤検知として覚えたものを除いて一覧にする */
export async function scan($: any) {
  scanning = true
  lastError = ''
  missing = false
  lastIgnored = null
  $.ui.invalidate('ui.render')
  try {
    // git status のパスはリポジトリの一番上からの相対なので、Semgrep もそこを起点に動かす（サブフォルダで起動しても取り違えない）
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root })
    if (top.exitCode !== 0) {
      scannedFiles = 0
      findings = []
      cur = 0
      return
    }
    const base = String(top.stdout ?? '').trim()
    const st = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: base })
    const files = changedFiles(String(st.stdout ?? ''))
    scannedFiles = files.length
    if (files.length === 0) {
      findings = []
      cur = 0
      return
    }
    const argv = [semgrep, 'scan', '--json', '--quiet', '--metrics=off', ...rules.flatMap((r) => ['--config', r]), ...files]
    const r = await $.process.run(argv, { cwd: base, timeoutMs: 5 * 60_000 })
    if (String(r.stdout ?? '').trim() === '') throw new Error(String(r.stderr ?? '').trim().split('\n').pop() || `semgrep exited with ${r.exitCode}`)
    // その行の中身を読むため、見つかったファイルだけ先に読んでおく
    const sources = new Map<string, string[]>()
    const raw = JSON.parse(String(r.stdout))
    for (const p of new Set<string>((raw.results ?? []).map((x: any) => relPath(base, String(x.path ?? ''))))) {
      try {
        sources.set(p, String(await $.fs.read(`${base}/${p}`)).split(/\r?\n/))
      } catch {
        sources.set(p, [])
      }
    }
    const readLine = (path: string, line: number) => sources.get(path)?.[line - 1] ?? ''
    findings = parseResults(String(r.stdout), base, readLine, new Set(await ignoredKeys($)))
    cur = 0
  } catch (err: any) {
    const text = String(err?.message ?? err)
    // 起動できなかったときは入れ方を案内し、それ以外の失敗はエラーの文を出す
    if (/ENOENT|not found/i.test(text)) missing = true
    else lastError = `Could not run Semgrep: ${text.slice(0, 200)}`
  } finally {
    scanning = false
    $.ui.invalidate('ui.render')
  }
}

/**
 * 画面の右を開く
 * コマンドやボタンで開くときだけキーボードを渡し、自動で開くときはプロンプトへの入力を奪わない
 */
async function openPane($: any, asked: boolean) {
  const pane = { id: PANE_ID, title: 'Security scan', closeOnEscape: true, columns: 60 }
  await $.ui.open(asked ? { ...pane, focus: true } : pane)
}

/** mod の入口 ── 変更中のファイルの脆弱性を Semgrep で調べ、画面の右でふるい分けて、本物だけ Claude に直させる */
export function register(on: On, options?: PluginOptions) {
  semgrep = String(options?.semgrep ?? 'semgrep') || 'semgrep'
  rules = String(options?.rules ?? 'p/nodejsscan,p/owasp-top-ten')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  on('session.start', async ($: any, e: any, next: any) => {
    root = String(e.cwd ?? '')
    const r = await next(e)
    await $.command.register({ name: 'scan', description: 'Security scan: scan changed files with Semgrep and review the issues', argumentHint: '[reset]', immediate: true })
    // 画面の無いセッション（claude -p）では結果を見る人がいないので、自動では調べない
    if (e.isInteractive === false) return r
    // 起動を待たせないよう、開いて調べるのはタイマーで後から
    $.clock.after(500, async () => {
      await openPane($, false)
      await scan($)
    })
    return r
  })

  on('command.run', { command: 'scan' }, async ($: any, e: any) => {
    if (root === '') root = String(await $.session.cwd())
    if (String(e.args ?? '').trim() === 'reset') await resetIgnored($)
    await openPane($, true)
    await scan($)
    // 文字を返すと会話に入り Claude が読むので、何も返さず画面に描くだけにする
    return {}
  })

  on('ui.render', { component: 'Pane' }, ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e)
    return drawPane($.ui.resolve(e), (a) => void act($, a))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const t = $.ui.resolve(e)
    const ours = drawBand(t, () => void openPane($, true))
    const theirs = await next(e)
    if (ours === null) return theirs
    if (!theirs) return ours
    // ほかの mod の表示を消さないよう、自分の1行の下に並べる
    return t.Box({ flexDirection: 'column', children: [ours, theirs] })
  })
}

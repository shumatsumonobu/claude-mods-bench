import type { On } from 'claude-code'

/** 画面の右に開く一覧の ID、`ui.render` で自分の一覧かを見分けるのにも使う */
const PANE_ID = 'file-map'

/**
 * 一覧に載せるツール
 * 読むのは Read、書くのは Write・Edit・MultiEdit・NotebookEdit
 * それ以外（Glob・Grep・Bash など）は載せない
 */
const READ_TOOLS = new Set(['Read'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** ファイル1つの記録 ── 読んだ回数、書き換えた回数、新しく作ったか */
type Entry = { reads: number; writes: number; created: boolean }

/** このセッションで触ったファイル、キーはプロジェクトからの相対パス */
const touched = new Map<string, Entry>()
/** プロジェクトの場所、相対パスを作る基準 */
let root = ''
/** 一覧を開いているか */
let isOpen = false
/** 画面の右に置けず、プロンプトの上の1行に一覧を出しているか（コマンドやボタンで開いたときだけ） */
let inBand = false
/** 最初の読み書きで一度だけ自動で開くための印 */
let autoOpened = false
/** ユーザーが自分で閉じたか、閉じたらこのセッションでは自動で開き直さない */
let closedByUser = false

/** パスの区切りを `/` にそろえ、末尾の `/` を取る */
export function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** プロジェクトからの相対パス、プロジェクトの外なら絶対パスのまま */
export function relPath(base: string, path: string): string {
  const p = norm(path)
  const b = norm(base)
  if (b !== '' && (p === b || p.startsWith(b + '/'))) return p.slice(b.length + 1) || p
  return p
}

/** ツールの呼び出しから、触ったファイルのパスと、読んだか書いたかを取り出す、対象外なら null */
export function fileOf(e: any): { path: string; kind: 'read' | 'write'; created: boolean } | null {
  const tool = String(e?.tool ?? '')
  const path = String(e?.file_path ?? e?.notebook_path ?? '')
  if (path === '') return null
  if (READ_TOOLS.has(tool)) return { path, kind: 'read', created: false }
  if (WRITE_TOOLS.has(tool)) return { path, kind: 'write', created: tool === 'Write' }
  return null
}

/**
 * 触った記録を1件足す
 * created は Write のときだけ立てる（読まずに書いたなら、新しく作った可能性が高い）
 */
export function record(map: Map<string, Entry>, rel: string, kind: 'read' | 'write', created: boolean) {
  const e = map.get(rel) ?? { reads: 0, writes: 0, created: false }
  if (kind === 'read') e.reads++
  else {
    e.writes++
    if (created && e.reads === 0) e.created = true
  }
  map.set(rel, e)
}

/** 相対パスのフォルダ部分、プロジェクト直下なら `.` */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i > 0 ? rel.slice(0, i) : '.'
}

/** 相対パスのファイル名部分 */
function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(i + 1) : rel
}

/**
 * 一覧に出す行
 * フォルダごとにまとめ、書き換えたファイルを先に、触った回数の多い順に並べる
 */
export function rows(map: Map<string, Entry>): { dir: string; files: { name: string; e: Entry }[] }[] {
  const byDir = new Map<string, { name: string; e: Entry }[]>()
  for (const [rel, e] of map) {
    const d = dirOf(rel)
    const list = byDir.get(d) ?? []
    list.push({ name: baseOf(rel), e })
    byDir.set(d, list)
  }
  return [...byDir.keys()]
    .sort()
    .map((dir) => ({
      dir,
      files: byDir.get(dir)!.sort((a, b) => {
        const wa = a.e.writes > 0 ? 1 : 0
        const wb = b.e.writes > 0 ? 1 : 0
        if (wa !== wb) return wb - wa
        return b.e.reads + b.e.writes - (a.e.reads + a.e.writes) || a.name.localeCompare(b.name)
      }),
    }))
}

/** 読んだファイル数、書き換えたファイル数、合計 ── 読んでから書き換えたファイルは両方に数える */
function counts(map: Map<string, Entry>) {
  let read = 0
  let wrote = 0
  for (const e of map.values()) {
    if (e.reads > 0) read++
    if (e.writes > 0) wrote++
  }
  return { read, wrote, total: map.size }
}

/** ファイル1行の表示 ── ファイル名と、読んだ回数・書き換えた回数（新しく作ったなら created） */
export function fileLabel(name: string, e: Entry): string {
  const marks: string[] = []
  if (e.reads > 0) marks.push(`read ${e.reads}`)
  if (e.writes > 0) marks.push(e.created ? 'created' : `edited ${e.writes}`)
  return `${name} · ${marks.join(' · ')}`
}

/** 画面の右に出す一覧 ── フォルダ名は水色、書き換えたファイルは緑、読んだだけのファイルは白 */
export function drawMap(t: any, map: Map<string, Entry>) {
  const { Box, Text } = t
  const c = counts(map)
  const groups = rows(map)
  const body =
    map.size === 0
      ? [Text({ key: 'empty', dimColor: true, children: 'No files read or edited yet' })]
      : groups.flatMap((g, gi) => [
          Box({
            key: `g${gi}`,
            flexDirection: 'column',
            marginTop: gi === 0 ? 0 : 1,
            children: [
              Text({ key: 'dir', bold: true, color: 'cyan', children: `${g.dir}/` }),
              ...g.files.map((f, fi) =>
                Text({ key: `f${fi}`, ...(f.e.writes > 0 ? { color: 'green' } : {}), children: `  ${fileLabel(f.name, f.e)}` }),
              ),
            ],
          }),
        ])
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    children: [
      Text({ key: 'title', bold: true, color: 'cyan', children: `File map · read ${c.read} / edited ${c.wrote}` }),
      Box({ key: 'body', flexDirection: 'column', marginTop: 1, children: body }),
    ],
  })
}

/** プロンプトの上の1行 ── 触ったファイルの数と、一覧を開くボタン、まだ何も触っていなければ出さない */
export function drawHint(t: any, map: Map<string, Entry>, onOpen: () => void) {
  if (map.size === 0) return null
  const { Box, Text, Button } = t
  const c = counts(map)
  return Box({
    gap: 2,
    paddingX: 1,
    children: [
      Text({ key: 'label', bold: true, color: 'cyan', children: `File map · ${c.total} file${c.total === 1 ? '' : 's'} (read ${c.read} / edited ${c.wrote})` }),
      Button({ key: 'open', label: 'Open', hotkey: 'm', plain: true, onPress: onOpen }),
    ],
  })
}

/**
 * 一覧を開く
 * コマンドやボタンで開くときだけキーボードを渡し、自動で開くときはプロンプトへの入力を奪わない
 */
async function openMap($: any, asked: boolean) {
  isOpen = true
  $.ui.invalidate('ui.render')
  await $.clock.sleep(200)
  const pane = { id: PANE_ID, title: 'File map', closeOnEscape: true, rows: 22, columns: 50 }
  const placed = await $.ui.open(asked ? { ...pane, focus: true } : pane)
  inBand = asked && placed?.isPlaced === false
  $.ui.invalidate('ui.render')
}

/** mod の入口 ── Claude のファイルの読み書きを数え、画面の右の一覧とプロンプトの上の1行に出す */
export function register(on: On) {
  on('session.start', async ($: any, e: any, next: any) => {
    root = norm(String(e.cwd ?? ''))
    autoOpened = false
    closedByUser = false
    const r = await next(e)
    await $.command.register({ name: 'map', description: 'File map: files read and edited this session' })
    return r
  })

  on('command.run', { command: 'map' }, async ($: any, e: any) => {
    closedByUser = false
    await openMap($, true)
    // 文字を返すと会話に入り Claude が読むので、何も返さず画面に描くだけにする
    return {}
  })

  // 数えるのは Claude のツール呼び出しだけ（サブエージェントの分も届く）、記録の失敗で実行は止めない
  on('tool.call', async ($: any, e: any, next: any) => {
    const answer = await next(e)
    try {
      const f = fileOf(e)
      if (f && (answer?.isError !== true)) {
        if (root === '') root = norm(String(await $.session.cwd().catch(() => '')))
        record(touched, relPath(root, f.path), f.kind, f.created)
        $.ui.invalidate('ui.render')
        if (!autoOpened && !closedByUser) {
          autoOpened = true
          await openMap($, false)
        }
      }
    } catch {
      // 記録の失敗で実行は止めない
    }
    return answer
  })

  // ターンの終わりにも描き直す、途中で頼んだ描き直しは待機中の画面に残らないことがある
  on('turn.complete', async ($: any, e: any, next: any) => {
    const r = await next(e)
    $.ui.invalidate('ui.render')
    return r
  })

  on('ui.render', { component: 'Pane' }, ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e)
    return drawMap($.ui.resolve(e), touched)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const t = $.ui.resolve(e)
    const ours =
      isOpen && inBand
        ? drawMap(t, touched)
        : drawHint(t, touched, () => {
            closedByUser = false
            void openMap($, true)
          })
    const theirs = await next(e)
    if (ours === null) return theirs
    if (!theirs) return ours
    // ほかの mod の表示を消さないよう、自分の表示の下に並べる
    return t.Box({ flexDirection: 'column', children: [ours, theirs] })
  })

  on('ui.close', ($: any, e: any, next: any) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) {
      isOpen = false
      if (e.origin?.kind === 'person') closedByUser = true
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })
}

import type { On } from 'claude-code'

/** 画面の右に開く表示の ID、コマンド名と `ui.render` での見分けにも使う */
const PANE_ID = 'session-usage'
/** 時間の長さ（ミリ秒） */
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
/** 記録を残す期間、7日の窓より少し長く持ち、それより古いセッションの記録は消す */
const KEEP_MS = 8 * DAY
/** この時間内に返事があったセッションに、active の印を付ける */
const ACTIVE_MS = 5 * 60 * 1000
/** 棒グラフに出すセッションの数、残りは1行にまとめる */
const TOP = 6

/** セッション1つの記録、保存領域にセッションごとのキー（`s:<id>`）で置き、セッション同士の書き込みがぶつからないようにする */
export type Rec = {
  /** セッションの ID（`$.session.id()`） */
  id: string
  /** 作業フォルダの最後のディレクトリ名 */
  project: string
  /** 最初のプロンプトの先頭 */
  title: string
  /** 最後に返事が終わった時刻（ミリ秒） */
  lastAt: number
  /** `$.session.usage()` の料金（ドル）、セッションの累計 */
  usd: number
  /** 時間ごとの料金の増分、キーはその時間の始まり（ミリ秒）の文字列 */
  hours: Record<string, number>
}

/** 利用上限1つの読み取り（`$.session.usage()` の `rateLimits` の1件） */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** このセッションの記録 */
let me: Rec | null = null
/** 保存領域から読んだ、全セッションの記録 */
let all: Rec[] = []
/** 最後に読んだ利用上限 */
let limits: Limit[] = []
/** 画面の右を開いているか */
let isOpen = false
/** ユーザーが自分で閉じたか、閉じたらこのセッションでは自動で開き直さない */
let closedByUser = false
/** ほかのセッションの記録を定期的に読み直すタイマーを、もう始めたか */
let ticking = false

/** パスの最後のディレクトリ名 */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** 時刻が属する1時間の始まり（ミリ秒）を、記録のキーの文字列にする */
export function hourKey(ms: number): string {
  return String(Math.floor(ms / HOUR) * HOUR)
}

/**
 * 料金の新しい累計を記録に足す
 * 前の累計から増えた分だけを、今の時間に積み、記録を残す期間より古い時間は捨てる
 */
export function addCost(rec: Rec, usd: number, now: number): Rec {
  const delta = usd - rec.usd
  const hours: Record<string, number> = {}
  for (const [k, v] of Object.entries(rec.hours)) if (Number(k) >= now - KEEP_MS) hours[k] = v
  if (delta > 0) {
    const k = hourKey(now)
    hours[k] = (hours[k] ?? 0) + delta
  }
  return { ...rec, usd: Math.max(rec.usd, usd), lastAt: now, hours }
}

/**
 * 数える範囲の始まり
 * 7日の利用上限の次のリセットから7日さかのぼる、上限が読めなければ直近7日
 */
export function windowStart(lims: Limit[], now: number): number {
  const week = lims.find((l) => l.kind === 'seven_day')
  const reset = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
  return Number.isFinite(reset) && reset > now ? reset - WEEK : now - WEEK
}

/** 数える範囲の中で、そのセッションが使った料金 */
export function costIn(rec: Rec, from: number): number {
  let sum = 0
  for (const [k, v] of Object.entries(rec.hours)) if (Number(k) + HOUR > from) sum += v
  return sum
}

/**
 * セッションを、数える範囲の中の料金が多い順に並べ、全体に占める割合を付ける
 * 範囲の中で料金が無いセッションは外す
 */
export function ranking(recs: Rec[], from: number) {
  const rows = recs.map((r) => ({ rec: r, usd: costIn(r, from) })).filter((x) => x.usd > 0)
  const total = rows.reduce((s, x) => s + x.usd, 0)
  rows.sort((a, b) => b.usd - a.usd)
  return { total, rows: rows.map((x) => ({ ...x, share: total > 0 ? x.usd / total : 0 })) }
}

/** 1文字を8段階に分けて描くための、端数の文字 */
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** 割合を、幅 width 文字の棒にする（1文字を8段階に分ける） */
export function bar(share: number, width: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, share)) * width * 8)
  return '█'.repeat(Math.floor(eighths / 8)) + BLOCKS[eighths % 8]
}

/** 割合を百分率の文字にする、10% 未満は小数1桁まで */
export function pct(share: number): string {
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`
}

/**
 * 曜日×時間帯の料金
 * 行は6日前から今日までの7日、列は0時から23時（端末の時刻）
 */
export function heat(recs: Rec[], now: number): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const first = today.getTime() - 6 * DAY
  for (const r of recs) {
    for (const [k, v] of Object.entries(r.hours)) {
      const t = Number(k)
      if (t < first) continue
      const d = new Date(t)
      const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - first) / DAY)
      if (day >= 0 && day < 7) grid[day][d.getHours()] += v
    }
  }
  return grid
}

/** Raster で、端末の既定の色を表す値 */
const DEFAULT_COLOR = 0x01000000
/** マス目の色、使っていない時間は暗い灰色、多く使った時間ほど明るい緑 */
const RAMP = [0x2b2b2b, 0x0e4429, 0x006d32, 0x26a641, 0x39d353]

/** 料金を、色の段階（0 は使っていない、1〜4 は多いほど明るい）にする */
export function level(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0
  return Math.min(4, 1 + Math.floor((v / max) * 3.999))
}

/** バイト列を base64 にする、`toBase64` が無い環境（テスト）では `btoa` で代わりにする */
function toBase64(bytes: Uint8Array): string {
  const u = bytes as any
  if (typeof u.toBase64 === 'function') return u.toBase64()
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

/**
 * Raster に渡すマス目
 * 1マスは文字・文字の色・背景の色の3つの数で、1時間を2文字の幅にする
 */
export function heatCells(grid: number[][]): { columns: number; rows: number; cells: string } {
  const max = Math.max(0, ...grid.flat())
  const nums: number[] = []
  for (const row of grid) {
    for (const v of row) {
      const color = RAMP[level(v, max)]
      for (let i = 0; i < 2; i++) nums.push('█'.codePointAt(0)!, color, DEFAULT_COLOR)
    }
  }
  return { columns: 48, rows: grid.length, cells: toBase64(new Uint8Array(Uint32Array.from(nums).buffer)) }
}

/** 曜日の表示 */
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** マス目の左に並べる曜日、6日前から今日まで */
function dayLabels(now: number): string[] {
  return Array.from({ length: 7 }, (_, i) => WEEKDAY[new Date(now - (6 - i) * DAY).getDay()])
}

/** 7日の利用上限の消費率と、次のリセットの曜日と時刻 */
function limitText(lims: Limit[]): string {
  const week = lims.find((l) => l.kind === 'seven_day')
  if (!week) return ''
  const reset = week.resetsAt ? new Date(week.resetsAt) : null
  const when = reset ? ` · resets ${WEEKDAY[reset.getDay()]} ${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}` : ''
  return `7-day limit ${week.percentUsed}% used${when}`
}

/** 棒の上に出すセッションの名前 ── 作業フォルダ名、印（this session か active）、最初のプロンプト */
function rowLabel(rec: Rec, isMe: boolean, now: number): string {
  const tags: string[] = []
  if (isMe) tags.push('this session')
  else if (now - rec.lastAt < ACTIVE_MS) tags.push('active')
  const title = rec.title ? ` · ${rec.title}` : ''
  // 印は題より前に置く、題が長いと行の末尾が切れるため
  return `${rec.project}${tags.length ? ` (${tags.join(', ')})` : ''}${title}`
}

/**
 * 画面の右に出す中身
 * 上に曜日×時間帯の使用量（端末だけ）、下にセッション別の棒グラフ、最後に7日の利用上限
 */
export function drawPane(t: any, surface: string, recs: Rec[], meId: string, lims: Limit[], now: number, columns: number) {
  const { Box, Text, Raster } = t
  const from = windowStart(lims, now)
  const r = ranking(recs, from)
  const barWidth = Math.max(8, Math.min(28, columns - 16))
  const children: any[] = []

  if (surface === 'terminal' && Raster) {
    const h = heatCells(heat(recs, now))
    children.push(
      Box({
        key: 'heat',
        flexDirection: 'row',
        gap: 1,
        children: [
          Box({ key: 'days', flexDirection: 'column', children: dayLabels(now).map((d, i) => Text({ key: `d${i}`, dimColor: true, children: d })) }),
          Raster({ key: 'grid', ...h }),
        ],
      }),
      Text({ key: 'hours', dimColor: true, children: '    0h          6h          12h         18h' }),
    )
  }

  if (r.rows.length === 0) {
    children.push(Text({ key: 'empty', dimColor: true, children: 'No usage recorded yet. Each session adds its own after every reply.' }))
  } else {
    const top = r.rows.slice(0, TOP)
    top.forEach((x, i) => {
      const isMe = x.rec.id === meId
      children.push(
        Box({
          key: `s${i}`,
          flexDirection: 'column',
          marginTop: i === 0 ? 1 : 0,
          children: [
            Text({ key: 'name', ...(isMe ? { bold: true } : {}), wrap: 'truncate-end', children: rowLabel(x.rec, isMe, now) }),
            Box({
              key: 'bar',
              flexDirection: 'row',
              gap: 1,
              children: [
                Text({ key: 'b', color: isMe ? 'cyan' : 'green', children: bar(x.share, barWidth).padEnd(barWidth, ' ') }),
                Text({ key: 'p', children: `${pct(x.share).padStart(5)}  $${x.usd.toFixed(2)}` }),
              ],
            }),
          ],
        }),
      )
    })
    const rest = r.rows.slice(TOP)
    if (rest.length > 0) {
      const share = rest.reduce((s, x) => s + x.share, 0)
      children.push(Text({ key: 'rest', dimColor: true, children: `+ ${rest.length} more session${rest.length === 1 ? '' : 's'}  ${pct(share)}` }))
    }
  }

  const limit = limitText(lims)
  children.push(
    Box({
      key: 'foot',
      flexDirection: 'column',
      marginTop: 1,
      children: [
        ...(limit ? [Text({ key: 'limit', children: limit })] : []),
        Text({ key: 'note', dimColor: true, children: 'Shares are by cost, as /cost counts it. Sessions without this mod are not counted.' }),
      ],
    }),
  )

  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'green',
    paddingX: 1,
    children: [Text({ key: 'title', bold: true, color: 'green', children: 'Session usage · this week' }), Box({ key: 'body', flexDirection: 'column', marginTop: 1, children })],
  })
}

/** プロンプトの上の1行 ── このセッションの割合と、7日の利用上限、このセッションに料金がまだ無ければ出さない */
export function drawLine(t: any, recs: Rec[], meId: string, lims: Limit[], now: number, onOpen: () => void) {
  const r = ranking(recs, windowStart(lims, now))
  const mine = r.rows.find((x) => x.rec.id === meId)
  if (!mine) return null
  const { Box, Text, Button } = t
  const limit = lims.find((l) => l.kind === 'seven_day')
  const parts = [`this session ${pct(mine.share)} of the week`, ...(limit ? [`7-day limit ${limit.percentUsed}%`] : [])]
  return Box({
    key: 'session-usage',
    gap: 2,
    paddingX: 1,
    children: [
      Text({ key: 'label', bold: true, color: 'green', children: `Session usage · ${parts.join(' · ')}` }),
      Button({ key: 'open', label: 'Open', hotkey: 'u', plain: true, onPress: onOpen }),
    ],
  })
}

/** このセッションの記録を、保存領域の自分のキーに書く */
async function save($: any) {
  if (me) await $.store.set(`s:${me.id}`, me)
}

/** 保存領域から全セッションの記録と利用上限を読み直し、記録を残す期間より古いセッションは消す */
async function load($: any) {
  const now = await $.clock.now()
  const keys: string[] = await $.store.keys()
  const recs: Rec[] = []
  for (const k of keys) {
    if (k === 'limits') {
      const v = await $.store.get(k)
      if (Array.isArray(v)) limits = v
      continue
    }
    if (!k.startsWith('s:')) continue
    const v = (await $.store.get(k)) as Rec | undefined
    if (!v || now - v.lastAt > KEEP_MS) {
      await $.store.delete(k)
      continue
    }
    recs.push(v)
  }
  all = recs
}

/**
 * 画面の右を開く
 * コマンドやボタンで開くときだけキーボードを渡し、自動で開くときはプロンプトへの入力を奪わない
 */
async function openPane($: any, asked: boolean) {
  isOpen = true
  await load($)
  $.ui.invalidate('ui.render')
  const pane = { id: PANE_ID, title: 'Session usage', closeOnEscape: true, columns: 56 }
  await $.ui.open(asked ? { ...pane, focus: true } : pane)
  $.ui.invalidate('ui.render')
}

/**
 * セッションの始まり
 * このセッションの記録を用意し、ほかのセッションの記録を読み、コマンドを登録して、画面の右を自動で開く
 */
export async function onStart($: any, e: any, next: any) {
  const r = await next(e)
  try {
    const id = await $.session.id()
    const now = await $.clock.now()
    const u = await $.session.usage()
    const saved = (await $.store.get(`s:${id}`)) as Rec | undefined
    me = saved ?? { id, project: baseName(String(e.cwd ?? (await $.session.cwd()))), title: '', lastAt: now, usd: u?.cost?.usd ?? 0, hours: {} }
    if (Array.isArray(u?.rateLimits) && u.rateLimits.length > 0) limits = u.rateLimits
    await load($)
    if (!ticking) {
      ticking = true
      // ほかのセッションの記録を取り込む、読むのは手元の保存領域だけで、モデルは呼ばない
      $.clock.every(30_000, async () => {
        await load($)
        $.ui.invalidate('ui.render')
      })
    }
  } catch {
    // 記録の準備に失敗しても、セッションは止めない
  }
  await $.command.register({ name: PANE_ID, description: 'Session usage: which sessions used the most this week' })
  // コマンドを待たずに開く、ほかのセッションの記録があるので、開いた時点で中身がある
  if (!closedByUser) await openPane($, false).catch(() => {})
  return r
}

/** 最初のプロンプトの先頭を、このセッションの題として記録する（プロンプトは書き換えない） */
export async function onPrompt($: any, e: any, next: any) {
  if (me && me.title === '' && typeof e.text === 'string' && e.text.trim() !== '') {
    me = { ...me, title: e.text.trim().split('\n')[0].slice(0, 40) }
    await save($).catch(() => {})
  }
  return next(e)
}

/** 返事が終わるたびに、料金の累計と利用上限を読み、増えた分を記録して描き直す */
export async function onTurn($: any, e: any, next: any) {
  const answer = await next(e)
  try {
    if (me) {
      const u = await $.session.usage()
      const now = await $.clock.now()
      if (typeof u?.cost?.usd === 'number') me = addCost(me, u.cost.usd, now)
      await save($)
      if (Array.isArray(u?.rateLimits) && u.rateLimits.length > 0) {
        limits = u.rateLimits
        await $.store.set('limits', limits)
      }
      await load($)
      $.ui.invalidate('ui.render')
    }
  } catch {
    // 記録の失敗でターンは止めない
  }
  return answer
}

/** `/session-usage` ── 画面の右を開く */
export async function onCommand($: any, e: any) {
  closedByUser = false
  await openPane($, true)
  // 文字を返すと会話に入り Claude が読むので、何も返さず画面に描くだけにする
  return {}
}

/** 画面の右に、自分の表示を描く */
export async function onPane($: any, e: any, next: any) {
  if (e.requestId !== PANE_ID) return next(e)
  const now = await $.clock.now()
  return drawPane($.ui.resolve(e), String(e.surface ?? 'terminal'), all, me?.id ?? '', limits, now, Number(e.props?.bodyColumns ?? 56))
}

/** プロンプトの上の1行を描く、ほかの mod の表示も消さずに並べる */
export async function onBand($: any, e: any, next: any) {
  const now = await $.clock.now()
  const ours = drawLine($.ui.resolve(e), all, me?.id ?? '', limits, now, () => {
    closedByUser = false
    void openPane($, true)
  })
  const theirs = await next(e)
  if (ours === null) return theirs
  if (!theirs) return ours
  // ほかの mod の表示を消さないよう、自分の1行の下に並べる
  const { Box } = $.ui.resolve(e)
  return Box({ flexDirection: 'column', children: [ours, theirs] })
}

/** 画面の右が閉じられたとき、ユーザーが閉じたなら、このセッションでは自動で開き直さない */
export async function onClose($: any, e: any, next: any) {
  if (e.id === PANE_ID) {
    isOpen = false
    if (e.origin?.kind === 'person') closedByUser = true
  }
  $.ui.invalidate('ui.render')
  return next(e)
}

/** mod の入口 ── 各セッションの料金を記録し、セッション別の使用量を画面の右とプロンプトの上の1行に出す */
export function register(on: On) {
  on('session.start', onStart)
  on('prompt.submit', onPrompt)
  on('turn.complete', onTurn)
  on('command.run', { command: 'session-usage' }, onCommand)
  on('ui.render', { component: 'Pane' }, onPane)
  on('ui.render', { component: 'AbovePrompt' }, onBand)
  on('ui.close', onClose)
}

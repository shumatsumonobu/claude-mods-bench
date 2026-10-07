import { describe, expect, test, tier } from 'claude-code/testing'
import {
  addCost,
  bar,
  costIn,
  drawLine,
  drawPane,
  heat,
  heatCells,
  hourKey,
  onBand,
  onClose,
  onCommand,
  onPrompt,
  onStart,
  onTurn,
  ranking,
  windowStart,
  type Rec,
} from '../hooks/register.ts'

tier('user')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/** 部品ごとに付けられる属性、外れたものは本体が描画を断る */
const ALLOWED: Record<string, string[]> = {
  Text: ['key', 'children', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Box: ['key', 'children', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display', 'position', 'top', 'left', 'right', 'bottom'],
  Button: ['key', 'label', 'hotkey', 'plain', 'autoFocus', 'onPress'],
  Raster: ['key', 'columns', 'rows', 'cells'],
}

/** 部品の代わり、付けられない属性と値が undefined の属性は投げる */
function parts() {
  const buttons: Record<string, () => void> = {}
  const make = (type: string) => (props: any) => {
    for (const [k, v] of Object.entries(props)) {
      if (!ALLOWED[type].includes(k)) throw new Error(`${type} prop "${k}" is not allowed`)
      if (v === undefined) throw new Error(`${type} prop "${k}" is undefined`)
    }
    if (type === 'Button') buttons[props.key] = props.onPress
    return { type, props }
  }
  return { t: { Box: make('Box'), Text: make('Text'), Button: make('Button'), Raster: make('Raster') }, buttons }
}

/** 描いた木の文字をつなげる */
function textOf(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  return [node.props?.label, textOf(node.props?.children)].filter(Boolean).join('\n')
}

function typesOf(node: any): string[] {
  if (node == null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(typesOf)
  return [node.type, ...typesOf(node.props?.children)]
}

/** 偽の `$`、保存領域は引数で渡し、セッションをまたいで共有させる */
function fake(store: Record<string, unknown>, session: { id: string; cwd: string }, clock: { now: number }, usage: { usd: number; limits?: any[] }) {
  const commands: string[] = []
  const opened: any[] = []
  const $: any = {
    session: {
      id: async () => session.id,
      cwd: async () => session.cwd,
      usage: async () => ({ startedAt: 0, context: {}, rateLimits: usage.limits ?? [], cost: { usd: usage.usd } }),
    },
    store: {
      get: async (k: string) => store[k],
      set: async (k: string, v: unknown) => {
        store[k] = JSON.parse(JSON.stringify(v))
      },
      delete: async (k: string) => {
        delete store[k]
      },
      keys: async () => Object.keys(store),
    },
    clock: { now: async () => clock.now, every: () => ({ cancel() {} }) },
    command: {
      register: async (c: any) => {
        commands.push(c.name)
      },
    },
    ui: {
      invalidate: () => {},
      open: async (o: any) => {
        opened.push(o)
        return { isPlaced: true }
      },
      resolve: () => parts().t,
    },
  }
  return { $, commands, opened }
}

const next = async (e: any) => e
const rec = (over: Partial<Rec> = {}): Rec => ({ id: 'a', project: 'app', title: '', lastAt: 0, usd: 0, hours: {}, ...over })

describe('記録', () => {
  test('料金の累計が増えた分だけ、その時間に積む', () => {
    const now = 10 * HOUR + 5
    let r = addCost(rec(), 0.5, now)
    r = addCost(r, 0.8, now + 60_000)
    expect(r.usd).toBe(0.8)
    expect(Math.round(r.hours[hourKey(now)] * 1000) / 1000).toBe(0.8)
  })

  test('累計が増えていなければ積まない', () => {
    const r = addCost(rec({ usd: 1 }), 1, 5 * HOUR)
    expect(Object.keys(r.hours)).toEqual([])
  })

  test('8日より古い時間は捨てる', () => {
    const now = 20 * DAY
    const r = addCost(rec({ usd: 1, hours: { [String(now - 9 * DAY)]: 1, [String(now - DAY)]: 2 } }), 1, now)
    expect(Object.keys(r.hours)).toEqual([String(now - DAY)])
  })
})

describe('窓と順位', () => {
  test('窓は7日の上限の次のリセットから7日さかのぼる', () => {
    const now = Date.parse('2026-10-07T03:00:00Z')
    expect(windowStart([{ kind: 'seven_day', percentUsed: 9, resetsAt: '2026-10-14T02:00:00.000Z' }], now)).toBe(Date.parse('2026-10-07T02:00:00Z'))
  })

  test('上限が読めなければ直近7日', () => {
    expect(windowStart([], 30 * DAY)).toBe(23 * DAY)
  })

  test('窓より前の料金は数えない', () => {
    expect(costIn(rec({ hours: { [String(0)]: 5, [String(10 * HOUR)]: 2 } }), 5 * HOUR)).toBe(2)
  })

  test('料金の多い順に並べ、割合を付ける。料金の無いセッションは落とす', () => {
    const r = ranking([rec({ id: 'a', hours: { '0': 1 } }), rec({ id: 'b', hours: { '0': 3 } }), rec({ id: 'c' })], 0)
    expect(r.rows.map((x) => x.rec.id)).toEqual(['b', 'a'])
    expect(r.rows[0].share).toBe(0.75)
  })

  test('棒は1文字を8段階に割る', () => {
    expect(bar(0.5, 8)).toBe('████')
    expect(bar(1 / 16, 8)).toBe('▌')
    expect(bar(0, 8)).toBe('')
  })
})

describe('曜日×時間の色', () => {
  test('料金を端末の時刻の曜日と時間に置く。今日が最後の行', () => {
    const now = new Date(2026, 9, 7, 15, 30).getTime()
    const twoHoursAgo = new Date(2026, 9, 7, 13, 0).getTime()
    const yesterday = new Date(2026, 9, 6, 9, 0).getTime()
    const grid = heat([rec({ hours: { [String(twoHoursAgo)]: 2, [String(yesterday)]: 1 } })], now)
    expect(grid[6][13]).toBe(2)
    expect(grid[5][9]).toBe(1)
  })

  test('マス目は1時間を2文字の幅にし、7行48列にする', () => {
    const h = heatCells(Array.from({ length: 7 }, () => new Array(24).fill(0)))
    expect(h.columns).toBe(48)
    expect(h.rows).toBe(7)
    // 1マス3つの数（文字・色・背景）を4バイトずつ
    expect(atob(h.cells).length).toBe(7 * 48 * 3 * 4)
  })
})

describe('画面', () => {
  const limits = [{ kind: 'seven_day', percentUsed: 9, resetsAt: '2026-10-14T02:00:00.000Z' }]
  const now = Date.parse('2026-10-07T03:00:00Z')
  const recs = [
    rec({ id: 'me', project: 'pic-docs', title: '仕様書を直して', lastAt: now, hours: { [hourKey(now)]: 3 } }),
    rec({ id: 'other', project: 'rockin', lastAt: now - 60_000, hours: { [hourKey(now)]: 1 } }),
  ]

  test('端末では色のマス目と、セッション別の棒を出す', () => {
    const p = parts()
    const tree = drawPane(p.t, 'terminal', recs, 'me', limits, now, 56)
    const text = textOf(tree)
    expect(typesOf(tree)).toContain('Raster')
    expect(text).toContain('Session usage · this week')
    expect(text).toContain('pic-docs (this session) · 仕様書を直して')
    expect(text).toContain('rockin (active)')
    expect(text).toContain('75%')
    expect(text).toContain('7-day limit 9% used')
  })

  test('デスクトップでは色のマス目を出さない', () => {
    const tree = drawPane(parts().t, 'desktop', recs, 'me', limits, now, 56)
    expect(typesOf(tree)).not.toContain('Raster')
  })

  test('記録が無ければその旨を出す', () => {
    expect(textOf(drawPane(parts().t, 'terminal', [], 'me', [], now, 56))).toContain('No usage recorded yet')
  })

  test('プロンプトの上の1行に、このセッションの割合と7日の上限を出す', () => {
    const p = parts()
    const line = drawLine(p.t, recs, 'me', limits, now, () => {})
    expect(textOf(line)).toContain('Session usage · this session 75% of the week · 7-day limit 9%')
    expect(Object.keys(p.buttons)).toEqual(['open'])
  })

  test('このセッションに料金が無ければ1行は出さない', () => {
    expect(drawLine(parts().t, recs, 'nobody', limits, now, () => {})).toBe(null)
  })
})

describe('つなぎ', () => {
  test('2つのセッションが同じ保存領域に、それぞれの料金を積む', async () => {
    const store: Record<string, unknown> = {}
    const clock = { now: Date.parse('2026-10-07T03:00:00Z') }
    const a = fake(store, { id: 'A', cwd: '/work/app' }, clock, { usd: 0 })
    await onStart(a.$, { cwd: '/work/app' }, next)
    await onPrompt(a.$, { text: 'ログイン画面を作って\n詳しくは…' }, next)
    a.$.session.usage = async () => ({ rateLimits: [], cost: { usd: 1.5 } })
    await onTurn(a.$, {}, next)

    const b = fake(store, { id: 'B', cwd: '/work/docs' }, clock, { usd: 0 })
    await onStart(b.$, { cwd: '/work/docs' }, next)
    b.$.session.usage = async () => ({ rateLimits: [], cost: { usd: 0.5 } })
    await onTurn(b.$, {}, next)

    expect((store['s:A'] as Rec).title).toBe('ログイン画面を作って')
    expect((store['s:A'] as Rec).usd).toBe(1.5)
    expect((store['s:B'] as Rec).project).toBe('docs')
    const line = await onBand(b.$, { surface: 'terminal' }, async () => null)
    expect(textOf(line)).toContain('this session 25% of the week')
  })

  test('コマンドは文字を返さない。返すと会話に入り Claude が読むため', async () => {
    const f = fake({}, { id: 'A', cwd: '/w' }, { now: 0 }, { usd: 0 })
    expect(await onCommand(f.$, {})).toEqual({})
  })

  test('コマンドを登録する', async () => {
    const f = fake({}, { id: 'A', cwd: '/w' }, { now: 0 }, { usd: 0 })
    await onStart(f.$, { cwd: '/w' }, next)
    expect(f.commands).toEqual(['session-usage'])
  })

  test('プロンプトの上の1行は、他の mod の表示を消さずに並べる', async () => {
    const store: Record<string, unknown> = {}
    const clock = { now: Date.parse('2026-10-07T03:00:00Z') }
    const f = fake(store, { id: 'A', cwd: '/w' }, clock, { usd: 0 })
    await onStart(f.$, { cwd: '/w' }, next)
    f.$.session.usage = async () => ({ rateLimits: [], cost: { usd: 1 } })
    await onTurn(f.$, {}, next)
    const theirs = { type: 'Text', props: { children: 'another mod' } }
    const tree = await onBand(f.$, { surface: 'terminal' }, async () => theirs)
    const text = textOf(tree)
    expect(text).toContain('Session usage · this session')
    expect(text).toContain('another mod')
  })

  test('記録の途中で失敗してもターンは止めない', async () => {
    const f = fake({}, { id: 'A', cwd: '/w' }, { now: 0 }, { usd: 0 })
    await onStart(f.$, { cwd: '/w' }, next)
    f.$.session.usage = async () => {
      throw new Error('boom')
    }
    expect(await onTurn(f.$, { answer: 'ok' }, next)).toEqual({ answer: 'ok' })
  })
})

describe('自動で開く', () => {
  test('起動すると画面の右を自動で開く。キーボードは奪わない', async () => {
    const f = fake({}, { id: 'A', cwd: '/w' }, { now: 0 }, { usd: 0 })
    await onStart(f.$, { cwd: '/w' }, next)
    expect(f.opened.length).toBe(1)
    expect(f.opened[0].id).toBe('session-usage')
    expect(f.opened[0].focus).toBe(undefined)
  })

  test('ユーザーが閉じたら自動では開き直さず、コマンドならキーボードごと開く', async () => {
    const f = fake({}, { id: 'A', cwd: '/w' }, { now: 0 }, { usd: 0 })
    await onClose(f.$, { id: 'session-usage', origin: { kind: 'person' } }, next)
    await onStart(f.$, { cwd: '/w' }, next)
    expect(f.opened.length).toBe(0)
    await onCommand(f.$, {})
    expect(f.opened.length).toBe(1)
    expect(f.opened[0].focus).toBe(true)
  })
})

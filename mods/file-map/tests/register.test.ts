import { describe, expect, test, tier } from 'claude-code/testing'
import { drawHint, drawMap, fileLabel, fileOf, record, relPath, rows } from '../hooks/register.ts'

tier('user')

type Entry = { reads: number; writes: number; created: boolean }

/** 部品ごとに付けられる属性、付けられない属性と undefined は本体が描画を断るので、テストでも投げる */
const ALLOWED: Record<string, string[]> = {
  Text: ['key', 'children', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Box: ['key', 'children', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display', 'position', 'top', 'left', 'right', 'bottom'],
  Button: ['key', 'label', 'hotkey', 'plain', 'autoFocus', 'onPress'],
}

function parts() {
  const make = (type: string) => (props: any) => {
    for (const [k, v] of Object.entries(props)) {
      if (!ALLOWED[type].includes(k)) throw new Error(`${type} prop "${k}" is not allowed`)
      if (v === undefined) throw new Error(`${type} prop "${k}" is undefined`)
    }
    return { type, props }
  }
  return { Box: make('Box'), Text: make('Text'), Button: make('Button') }
}

const map = (entries: [string, Partial<Entry>][]) => {
  const m = new Map<string, Entry>()
  for (const [k, e] of entries) m.set(k, { reads: 0, writes: 0, created: false, ...e })
  return m
}

describe('記録', () => {
  test('ツールごとに読み・書きを振り分ける', () => {
    expect(fileOf({ tool: 'Read', file_path: '/w/a.ts' })).toEqual({ path: '/w/a.ts', kind: 'read', created: false })
    expect(fileOf({ tool: 'Edit', file_path: '/w/a.ts' })).toEqual({ path: '/w/a.ts', kind: 'write', created: false })
    expect(fileOf({ tool: 'Write', file_path: '/w/a.ts' })).toEqual({ path: '/w/a.ts', kind: 'write', created: true })
    expect(fileOf({ tool: 'NotebookEdit', notebook_path: '/w/a.ipynb' })).toEqual({ path: '/w/a.ipynb', kind: 'write', created: false })
  })

  test('Glob・Grep・Bash は一覧に載せない', () => {
    expect(fileOf({ tool: 'Glob', pattern: 'src/**' })).toBeNull()
    expect(fileOf({ tool: 'Grep', pattern: 'x', path: '/w/a.ts' })).toBeNull()
    expect(fileOf({ tool: 'Bash', command: 'ls' })).toBeNull()
  })

  test('読んだ回数・書いた回数を数える', () => {
    const m = new Map()
    record(m, 'a.ts', 'read', false)
    record(m, 'a.ts', 'read', false)
    record(m, 'a.ts', 'write', false)
    expect(m.get('a.ts')).toEqual({ reads: 2, writes: 1, created: false })
  })

  test('読まずに Write したファイルだけ新規とみなす', () => {
    const m = new Map()
    record(m, 'new.ts', 'write', true)
    expect(m.get('new.ts')!.created).toBe(true)
    const m2 = new Map()
    record(m2, 'old.ts', 'read', false)
    record(m2, 'old.ts', 'write', true)
    expect(m2.get('old.ts')!.created).toBe(false)
  })
})

describe('パス', () => {
  test('プロジェクトからの相対にする', () => {
    expect(relPath('C:/work', 'C:\\work\\src\\a.ts')).toBe('src/a.ts')
    expect(relPath('C:/work', 'C:/work')).toBe('C:/work')
    expect(relPath('C:/work', '/home/me/.ssh/config')).toBe('/home/me/.ssh/config')
  })
})

describe('並べ方', () => {
  test('ディレクトリで束ね、書いたファイルを先に出す', () => {
    const m = map([
      ['src/a.ts', { reads: 1 }],
      ['src/b.ts', { writes: 2 }],
      ['README.md', { reads: 3 }],
    ])
    const r = rows(m)
    expect(r.map((g) => g.dir)).toEqual(['.', 'src'])
    expect(r.find((g) => g.dir === 'src')!.files.map((f) => f.name)).toEqual(['b.ts', 'a.ts'])
  })

  test('行のラベルに回数と新規の印を出す', () => {
    expect(fileLabel('a.ts', { reads: 2, writes: 1, created: false })).toBe('a.ts · read 2 · edited 1')
    expect(fileLabel('new.ts', { reads: 0, writes: 1, created: true })).toBe('new.ts · created')
  })
})

describe('描画', () => {
  test('画面の右に、読んだ数・書き換えた数と一覧を出す', async ($: any) => {
    const t = await mount($, drawMap, map([['src/a.ts', { reads: 2 }], ['src/b.ts', { writes: 1, created: true }]]))
    expect(t).toContain('read 1 / edited 1')
    expect(t).toContain('src/')
    expect(t).toContain('a.ts · read 2')
    expect(t).toContain('b.ts · created')
  })

  test('読んでから書き換えたファイルは、見出しの read と edited の両方に数える', async ($: any) => {
    const m = map([['README.md', { reads: 1 }], ['src/math.js', { reads: 1, writes: 1 }]])
    expect(await mount($, drawMap, m)).toContain('File map · read 2 / edited 1')
    expect(await mount($, (tt: any, mm: any) => drawHint(tt, mm, () => {}), m)).toContain('File map · 2 files (read 2 / edited 1)')
  })

  test('何も触っていなければ、その旨を出す', async ($: any) => {
    const t = await mount($, drawMap, new Map())
    expect(t).toContain('No files read or edited yet')
  })

  test('プロンプトの上の1行に、件数と開くボタンを出す', async ($: any) => {
    const t = await mount($, (tt: any, m: any) => drawHint(tt, m, () => {}), map([['a.ts', { reads: 1 }]]))
    expect(t).toContain('1 file')
    expect(t).toContain('Open')
  })

  test('プロンプトの上の1行は、何も触っていなければ出さない', () => {
    expect(drawHint(parts(), new Map(), () => {})).toBeNull()
  })
})

/** 偽の部品で描いて、描いた中身を JSON の文字列にする、付けられない属性はここで投げる */
async function mount($: any, draw: (t: any, m: any) => any, m: any): Promise<string> {
  return JSON.stringify(draw(parts(), m))
}

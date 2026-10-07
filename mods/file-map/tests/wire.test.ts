import { describe, expect, test, tier } from 'claude-code/testing'
import { register } from '../hooks/register.ts'

tier('user')

// 登録されたフックをテスト側で直接呼び、tool.call で記録 → プロンプトの上の1行に出るかを通しで見る
function captured() {
  const hooks: Record<string, Function> = {}
  const on: any = (event: string, a: any, b?: any) => {
    const fn = typeof a === 'function' ? a : b
    hooks[event + (a && a.component ? ':' + a.component : '')] = fn
  }
  register(on)
  return hooks
}

const t = () => {
  const make = (type: string) => (props: any) => ({ type, props })
  return { Box: make('Box'), Text: make('Text'), Button: make('Button') }
}

/** 偽の `$`、画面の右を開いたときの引数を控える */
function fake() {
  const opened: any[] = []
  const $: any = {
    session: { cwd: async () => '/work' },
    command: { register: async () => {} },
    clock: { sleep: async () => {} },
    ui: {
      invalidate: () => {},
      resolve: () => t(),
      open: async (o: any) => {
        opened.push(o)
        return { isPlaced: true }
      },
    },
  }
  return { $, opened }
}

const next = async (e: any) => e

describe('配線', () => {
  test('Read を記録すると、プロンプトの上の1行に件数が出る', async () => {
    const h = captured()
    const { $ } = fake()
    await h['session.start']($, { cwd: '/work' }, next)
    await h['tool.call']($, { tool: 'Read', file_path: '/work/src/a.ts' }, next)
    const band = await h['ui.render:AbovePrompt']($, {}, async () => null)
    expect(JSON.stringify(band)).toContain('1 file')
  })

  test('ほかの mod の1行を消さず、自分の1行の下に並べる', async () => {
    const h = captured()
    const { $ } = fake()
    await h['session.start']($, { cwd: '/work' }, next)
    await h['tool.call']($, { tool: 'Read', file_path: '/work/src/a.ts' }, next)
    const theirs = { type: 'Text', props: { children: 'other mod' } }
    const tree = await h['ui.render:AbovePrompt']($, {}, async () => theirs)
    expect(tree.type).toBe('Box')
    expect(JSON.stringify(tree.props.children[0])).toContain('1 file')
    expect(tree.props.children[1]).toBe(theirs)
  })
})

describe('自動で開く', () => {
  test('最初の読み書きで木を自動で開く。2回目からは開かない。キーボードは奪わない', async () => {
    const h = captured()
    const f = fake()
    await h['session.start'](f.$, { cwd: '/work' }, next)
    await h['tool.call'](f.$, { tool: 'Read', file_path: '/work/src/a.ts' }, next)
    await h['tool.call'](f.$, { tool: 'Edit', file_path: '/work/src/a.ts' }, next)
    expect(f.opened.length).toBe(1)
    expect(f.opened[0].id).toBe('file-map')
    expect(f.opened[0].focus).toBe(undefined)
  })

  test('ユーザーが閉じたら自動では開き直さず、/map ならキーボードごと開く', async () => {
    const h = captured()
    const f = fake()
    await h['session.start'](f.$, { cwd: '/work' }, next)
    await h['ui.close'](f.$, { id: 'file-map', origin: { kind: 'person' } }, next)
    await h['tool.call'](f.$, { tool: 'Read', file_path: '/work/src/b.ts' }, next)
    expect(f.opened.length).toBe(0)
    await h['command.run'](f.$, { command: 'map' })
    expect(f.opened.length).toBe(1)
    expect(f.opened[0].focus).toBe(true)
  })

  test('/map は文字を返さない（返すと会話に入り Claude が読むため）', async () => {
    const h = captured()
    const f = fake()
    await h['session.start'](f.$, { cwd: '/work' }, next)
    expect(await h['command.run'](f.$, { command: 'map' })).toEqual({})
  })

  test('失敗した読み書きでは開かない', async () => {
    const h = captured()
    const f = fake()
    await h['session.start'](f.$, { cwd: '/work' }, next)
    await h['tool.call'](f.$, { tool: 'Read', file_path: '/work/missing.ts' }, async () => ({ isError: true }))
    expect(f.opened.length).toBe(0)
  })
})

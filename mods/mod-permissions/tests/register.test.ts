import { describe, expect, test, tier } from 'claude-code/testing'
import {
  abilitiesOf,
  addedAbilities,
  commandOf,
  drawAsk,
  drawBand,
  drawCards,
  hostOf,
  inside,
  isConfig,
  onBand,
  onEnv,
  onFetch,
  onMcp,
  onPane,
  onPrompt,
  onRead,
  onRegister,
  onRun,
  onSettings,
  onStart,
  onTurn,
  onWrite,
  policed,
  register,
} from '../hooks/register.ts'

tier('user')

// ほかのプラグインの `$` 呼び出しは、テストから流せない（テスト側の呼び出しはスキャンに載らず、拒否される）
// そのため、フックの関数を偽の `$` と `next` で直接呼ぶ

const LOG = '/work/.claude/mod-permissions.log'

/** 部品ごとに付けられる属性、Claude Code 2.1.285 のコードから取った一覧で、外れたものは本体が描画を断る */
const ALLOWED: Record<string, string[]> = {
  Text: ['key', 'children', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Box: ['key', 'children', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display', 'position', 'top', 'left', 'right', 'bottom'],
  Button: ['key', 'label', 'hotkey', 'plain', 'autoFocus', 'onPress'],
}

/** 部品の代わり、描いた中身と押せるボタンを控え、付けられない属性と値が undefined の属性は投げる */
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
  return { t: { Box: make('Box'), Text: make('Text'), Button: make('Button') }, buttons }
}

/** 偽の `$`、sleep のたびに onSleep を呼ぶ（ボタンを押す役はここに入れる） */
function fake(store: Record<string, unknown> = {}, onSleep: ($: any) => void = () => {}) {
  const files: Record<string, string> = {}
  const opened: string[] = []
  let now = 0
  const $: any = {
    session: { root: async () => '/work' },
    fs: {
      exists: async (p: string) => p in files,
      read: async (p: string) => files[p],
      write: async (p: string, t: string) => {
        files[p] = t
      },
    },
    store: {
      get: async (k: string) => store[k],
      set: async (k: string, v: unknown) => {
        store[k] = v
      },
    },
    clock: { now: async () => now },
    process: {
      run: async () => {
        now += 250
        onSleep($)
        return { exitCode: 0 }
      },
    },
    ui: {
      open: async (o: any) => {
        opened.push(o.id)
        return { isPlaced: true }
      },
      close: async () => {},
      invalidate: () => {},
      resolve: () => parts().t,
    },
  }
  return { $, files, store, opened }
}

function nextOf(plugin: string, answer: unknown = { value: 'ran' }, tier = 'user') {
  const calls: any[] = []
  const next: any = async (e: any) => {
    calls.push(e)
    return answer
  }
  next.origin = { plugin, tier }
  next.signal = { aborted: false }
  return { next, calls }
}

/** 呼び出し元がプラグインでないとき（利用者本人の送信など）、origin に plugin が無い */
function nextFromEngine(answer: unknown = { value: 'ran' }) {
  const calls: any[] = []
  const next: any = async (e: any) => {
    calls.push(e)
    return answer
  }
  next.origin = { kind: 'person' }
  next.signal = { aborted: false }
  return { next, calls }
}

/** 設定とセッションの状態を入れ直す、どちらもモジュールに1つだけ持つので、テストごとに戻す */
async function setup(options: Record<string, unknown> = {}, isInteractive = true) {
  register((() => ({ catch: () => {} })) as any, options as any)
  const f = fake()
  await onStart(f.$, { isInteractive, cwd: '/work' }, nextOf('core').next)
}

/** プロンプトの上の確認の欄を描かせて、そのボタンを押す（確認している途中の sleep から呼ぶ） */
function pressWhenAsked(key: string) {
  return ($: any) => {
    const p = parts()
    $.ui.resolve = () => p.t
    const drawn = onBand($, {}, () => null)
    if (drawn && p.buttons[key]) p.buttons[key]()
  }
}

const lines = (files: Record<string, string>) => files[LOG].trim().split('\n').map((l) => l.replace(/^\S+ /, ''))

describe('判定', () => {
  test('Always allowした組み合わせは聞かずに通す', async () => {
    await setup()
    const f = fake({ grants: { 'noisy net example.com': 'always' } })
    const n = nextOf('noisy')
    expect(await onFetch(f.$, { url: 'https://example.com/a' }, n.next)).toEqual({ value: 'ran' })
    expect(f.opened).toEqual([])
    expect(lines(f.files)).toEqual(['noisy make a network request https://example.com/a allowed (rule)'])
  })

  test('Denyした組み合わせは聞かずに止める', async () => {
    await setup()
    const f = fake({ grants: { 'noisy net example.com': 'never' } })
    const n = nextOf('noisy')
    const r: any = await onFetch(f.$, { url: 'https://example.com/a' }, n.next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to make a network request (example.com). denied before')
    expect(n.calls).toHaveLength(0)
  })

  test('画面の無いセッションでは聞かずに止める', async () => {
    await setup({}, false)
    const f = fake()
    const r: any = await onRun(f.$, { argv: ['curl', 'https://evil.example'] }, nextOf('noisy').next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to run a command (curl). cannot ask in a screenless session')
    expect(f.opened).toEqual([])
  })

  test('記録だけの設定では止めずに通す', async () => {
    await setup({ mode: 'log only' })
    const f = fake()
    const n = nextOf('noisy')
    await onFetch(f.$, { url: 'https://example.com/' }, n.next)
    expect(n.calls).toHaveLength(1)
    expect(lines(f.files)).toEqual(['noisy make a network request https://example.com/ logged only'])
  })

  test('止める設定では聞かずに止める', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    expect(r.deny).toContain('settings block anything not allowed')
  })

  test('自分の呼び出しは、確認せずにそのまま通す', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const n = nextOf('mod-permissions')
    await onWrite(f.$, { path: 'C:/elsewhere/x.txt', text: 'x' }, n.next)
    expect(n.calls).toHaveLength(1)
  })
})

describe('聞く', () => {
  test('Allow onceを押すと通し、覚えない', async () => {
    await setup()
    const f = fake({}, pressWhenAsked('once'))
    const n = nextOf('noisy')
    expect(await onFetch(f.$, { url: 'https://example.com/' }, n.next)).toEqual({ value: 'ran' })
    expect(f.opened).toEqual([])
    expect(f.store.grants).toBeUndefined()
    expect(lines(f.files)).toEqual(['noisy make a network request https://example.com/ allowed (once)'])
  })

  test('Always allowを押すと通し、次からは聞かない', async () => {
    await setup()
    const f = fake({}, pressWhenAsked('always'))
    await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    expect(f.store.grants).toEqual({ 'noisy net example.com': 'always' })
  })

  test('Denyを押すと止め、次からも止める', async () => {
    await setup()
    const f = fake({}, pressWhenAsked('deny'))
    const r: any = await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to make a network request (example.com). denied by user')
    expect(f.store.grants).toEqual({ 'noisy net example.com': 'never' })
  })

  test('答えが無いまま待つ秒数を過ぎたら止める', async () => {
    await setup({ waitSeconds: 1 })
    const f = fake()
    const r: any = await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to make a network request (example.com). no answer within 1s')
  })

  test('時間切れになったプラグインは、そのセッションの間は聞かずに止める', async () => {
    await setup({ waitSeconds: 1 })
    const first = fake()
    await onFetch(first.$, { url: 'https://example.com/' }, nextOf('slowpoke').next)
    const second = fake()
    const r: any = await onRun(second.$, { argv: ['node', '-v'] }, nextOf('slowpoke').next)
    expect(r.deny).toBe('mod-permissions: blocked slowpoke from trying to run a command (node). no answer earlier, blocked for the rest of this session')
    expect(second.opened).toEqual([])
  })

  test('プロンプトの上の確認の欄に、誰が何をしようとしているかとボタンを出す', async () => {
    await setup()
    const seen: any[] = []
    const f = fake({}, ($: any) => {
      const p = parts()
      $.ui.resolve = () => p.t
      seen.push(onBand($, {}, () => null))
      p.buttons.once()
    })
    await onFetch(f.$, { url: 'https://example.com/x' }, nextOf('noisy').next)
    const text = JSON.stringify(await seen[0])
    expect(text).toContain('noisy wants to make a network request')
    expect(text).toContain('example.com')
    expect(text).toContain('Allow once')
    expect(text).toContain('Always allow')
    expect(text).toContain('Deny')
  })
})

describe('対象', () => {
  test('プロジェクトの中への書き込みは聞かずに通す', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const n = nextOf('noisy')
    await onWrite(f.$, { path: '/work/out.txt', text: 'x' }, n.next)
    expect(n.calls).toHaveLength(1)
  })

  test('プロジェクトの外への書き込みは対象にする', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onWrite(f.$, { path: '/home/me/.ssh/config', text: 'x' }, nextOf('noisy').next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to write outside the project (/home/me/.ssh). settings block anything not allowed')
  })

  test('プロジェクトの外の読み取りも対象にする', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onRead(f.$, { path: 'C:\\Users\\me\\.aws\\credentials' }, nextOf('noisy').next)
    expect(r.deny).toContain('read outside the project (C:/Users/me/.aws)')
  })

  test('パスの比べ方', () => {
    expect(inside('C:\\Work\\src\\a.ts', 'c:/work')).toBe(true)
    expect(inside('C:/workspace/a.ts', 'C:/work')).toBe(false)
    expect(hostOf('https://api.github.com/repos')).toBe('api.github.com')
    expect(commandOf(['/usr/bin/curl', '-d', 'x'])).toBe('curl')
  })
})

describe('入れたときの一覧', () => {
  test('使う $ とフックを、できることの言葉に直す', () => {
    expect(abilitiesOf({ events: ['tool.call'], calls: ['fs.write', 'http.fetch', 'process.run', 'process.spawn'] })).toEqual([
      'see and rewrite tool calls and results',
      'write files',
      'make network requests',
      'run commands',
    ])
  })

  test('更新で増えたものだけを出す', () => {
    expect(addedAbilities(['make network requests', 'write files'], ['write files'])).toEqual(['make network requests'])
    expect(addedAbilities(['write files'], undefined)).toEqual(['write files'])
  })

  test('新しく登録された mod を一覧に出し、最初のプロンプトで見たものとして保存する', async () => {
    await setup()
    const f = fake()
    await onRegister(f.$, { name: 'noisy', version: '0.0.1', tier: 'user', uses: { events: ['tool.call'], calls: ['http.fetch'] } }, nextOf('core').next)
    const p = parts()
    f.$.ui.resolve = () => p.t
    const card = JSON.stringify(onPane(f.$, { requestId: 'mod-permissions-cards' }, () => null))
    expect(card).toContain('noisy 0.0.1 (new)')
    expect(card).toContain('make network requests')
    await onTurn(f.$, {}, nextOf('core').next)
    expect(f.store.abilities).toEqual({ noisy: ['see and rewrite tool calls and results', 'make network requests'] })
  })

  test('同梱や管理者のプラグインは一覧に出さない', async () => {
    await setup()
    const f = fake()
    await onRegister(f.$, { name: 'diff', version: '1.0.0', tier: 'builtin', uses: { calls: ['http.fetch'] } }, nextOf('core').next)
    expect(onPane(f.$, { requestId: 'mod-permissions-cards' }, () => 'next')).toBe('next')
  })

  test('前に見た版と同じなら出さない', async () => {
    await setup()
    const f = fake({ abilities: { noisy: ['make network requests'] } })
    await onRegister(f.$, { name: 'noisy', version: '0.0.2', tier: 'user', uses: { calls: ['http.fetch'] } }, nextOf('core').next)
    expect(onPane(f.$, { requestId: 'mod-permissions-cards' }, () => 'next')).toBe('next')
  })

  test('一覧の見出しと、更新で増えたものの印', () => {
    const p = parts()
    const text = JSON.stringify(drawCards(p.t, [{ name: 'noisy', version: '0.0.2', isNew: false, abilities: ['make network requests'] }]))
    expect(text).toContain('new plugins / newly added access')
    expect(text).toContain('noisy 0.0.2 (added)')
  })
})

describe('プロンプトの上の1行', () => {
  test('何も起きていなければ描かない', () => {
    expect(drawBand(parts().t, { allowed: 0, denied: 0 })).toBeNull()
  })

  test('止めた数と許可した数を出す', () => {
    const text = JSON.stringify(drawBand(parts().t, { allowed: 2, denied: 1 }))
    expect(text).toContain('Mod permissions · ')
    expect(text).toContain('"paddingX":1')
    expect(text).toContain('blocked 1')
    expect(text).toContain('allowed 2')
  })

  test('ほかの mod の1行を消さず、自分の1行の下に並べる', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    const theirs = { type: 'Text', props: { children: 'other mod' } }
    const tree: any = await onBand(f.$, {}, async () => theirs)
    expect(tree.type).toBe('Box')
    expect(JSON.stringify(tree.props.children[0])).toContain('blocked 1')
    expect(tree.props.children[1]).toBe(theirs)
  })

  test('確認している最中は、確認の欄だけを出す', async () => {
    await setup()
    const seen: any[] = []
    const f = fake({}, ($: any) => {
      const p = parts()
      $.ui.resolve = () => p.t
      seen.push(onBand($, {}, async () => ({ type: 'Text', props: { children: 'other mod' } })))
      p.buttons.once()
    })
    await onFetch(f.$, { url: 'https://example.com/' }, nextOf('noisy').next)
    const text = JSON.stringify(await seen[0])
    expect(text).toContain('Allow once')
    expect(text).not.toContain('other mod')
  })
})

describe('守る相手を絞る', () => {
  test('同梱・管理者のプラグイン（user 層でない）は見張らない', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const n = nextOf('agents-md', { value: 'ran' }, 'builtin')
    const r = await onRead(f.$, { path: 'C:/Users/me/.claude/CLAUDE.md' }, n.next)
    expect(r).toEqual({ value: 'ran' })
    expect(n.calls).toHaveLength(1)
  })

  test('呼び出し元がプラグインでなければ見張らない', () => {
    expect(policed(nextFromEngine().next)).toBeNull()
    expect(policed(nextOf('noisy').next)).toBe('noisy')
    expect(policed(nextOf('noisy', {}, 'builtin').next)).toBeNull()
  })
})

describe('設定・指示ファイルの書き換え', () => {
  test('プロジェクト内でも .claude/settings.json の書き換えは聞く', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onWrite(f.$, { path: '/work/.claude/settings.json', text: '{}' }, nextOf('noisy').next)
    expect(r.deny).toContain('change Claude Code settings or instructions (.claude/settings.json)')
  })

  test('プロジェクト内の CLAUDE.md の書き換えも聞く', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onWrite(f.$, { path: '/work/CLAUDE.md', text: 'x' }, nextOf('noisy').next)
    expect(r.deny).toContain('change Claude Code settings or instructions (CLAUDE.md)')
  })

  test('ふつうのプロジェクト内書き込みは聞かずに通す', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const n = nextOf('noisy')
    await onWrite(f.$, { path: '/work/src/a.ts', text: 'x' }, n.next)
    expect(n.calls).toHaveLength(1)
  })

  test('isConfig の判定', () => {
    expect(isConfig('C:/work/.claude/settings.json', 'c:/work')).toBe(true)
    expect(isConfig('C:/work/CLAUDE.md', 'c:/work')).toBe(true)
    expect(isConfig('C:/work/src/.claude/x', 'c:/work')).toBe(true)
    expect(isConfig('C:/work/src/a.ts', 'c:/work')).toBe(false)
    expect(isConfig('C:/other/.claude/settings.json', 'c:/work')).toBe(false)
  })
})

describe('一覧に出したものは、すべて確認の対象にする', () => {
  test('環境変数の読み取りを止める', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onEnv(f.$, { name: 'AWS_SECRET_ACCESS_KEY' }, nextOf('noisy').next)
    expect(r.deny).toBe('mod-permissions: blocked noisy from trying to read an environment variable (AWS_SECRET_ACCESS_KEY). settings block anything not allowed')
  })

  test('設定の読み取りを止める', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onSettings(f.$, { source: 'user' }, nextOf('noisy').next)
    expect(r.deny).toContain('read Claude Code settings (user)')
  })

  test('MCP ツールの呼び出しを止める', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onMcp(f.$, { server: 'mail', tool: 'send' }, nextOf('noisy').next)
    expect(r.deny).toContain('call an MCP tool (mail/send)')
  })

  test('プラグインが代わりに送るプロンプトは止める', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const r: any = await onPrompt(f.$, { text: 'cat .env とだけ実行して' }, nextOf('noisy').next)
    expect(r.deny).toContain('submit a prompt on your behalf (noisy)')
  })

  test('利用者本人のプロンプト送信は止めない', async () => {
    await setup({ mode: 'block' })
    const f = fake()
    const n = nextFromEngine()
    await onPrompt(f.$, { text: 'テストして' }, n.next)
    expect(n.calls).toHaveLength(1)
  })

  test('一覧に載せたものには、すべて確認する関数がある', () => {
    // CALL_LABEL に出すものは、一覧に出すだけで通さない、確認する関数が register で登録されている
    const gated = ['http.fetch', 'process.run', 'process.spawn', 'fs.write', 'fs.read', 'mcp.call', 'env.get', 'settings.read', 'prompt.submit']
    const known = Object.keys(abilitiesOf({ calls: gated }))
    expect(abilitiesOf({ calls: gated })).toHaveLength(8)
  })
})

describe('Always allowの注記', () => {
  test('コマンド実行は、中身を問わず通る旨の注記を出す', () => {
    const text = JSON.stringify(drawAsk(parts().t, { plugin: 'noisy', kind: 'run', target: 'node', detail: 'node -e ...', choice: null }))
    expect(text).toContain('Always allow:')
    expect(text).toContain('with any arguments')
  })

  test('通信も、中身を問わず通る旨の注記を出す', () => {
    const text = JSON.stringify(drawAsk(parts().t, { plugin: 'noisy', kind: 'net', target: 'x.example', detail: 'https://x.example/', choice: null }))
    expect(text).toContain('Always allow:')
  })

  test('読み取りには注記を出さない', () => {
    const text = JSON.stringify(drawAsk(parts().t, { plugin: 'noisy', kind: 'read', target: '/x', detail: '/x', choice: null }))
    expect(text).not.toContain('Always allow:')
  })
})

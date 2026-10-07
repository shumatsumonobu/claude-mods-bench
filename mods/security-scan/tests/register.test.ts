import { describe, expect, test, tier } from 'claude-code/testing'
import { act, changedFiles, drawBand, drawPane, firstSentence, fixPrompt, parseResults, register, resetIgnored, riskLabel, scan } from '../hooks/register.ts'

tier('user')

/** 部品ごとに付けられる属性、Claude Code 2.1.285 のコードから取った一覧で、外れたものは本体が描画を断る */
const ALLOWED: Record<string, string[]> = {
  Text: ['key', 'children', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Box: ['key', 'children', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display', 'position', 'top', 'left', 'right', 'bottom'],
  Button: ['key', 'label', 'hotkey', 'plain', 'autoFocus', 'onPress'],
}

/** 部品の代わり、押せるボタンを控え、付けられない属性と値が undefined の属性は投げる */
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

/** Semgrep の出力の代わり ── 実験場のサンプルで実際に出た形に合わせた */
const SEMGREP = JSON.stringify({
  results: [
    { check_id: 'rules.node_eval.code-string-concat', path: 'C:/work/src/user.js', start: { line: 24 }, extra: { severity: 'ERROR', message: 'User controlled data in eval(). This is dangerous. More text.' } },
    { check_id: 'rules.xss.raw-html-format', path: 'C:/work/src/user.js', start: { line: 19 }, extra: { severity: 'WARNING', message: 'User data flows into HTML.' } },
    { check_id: 'rules.xss.raw-html-format', path: 'C:/work/src/user.js', start: { line: 19 }, extra: { severity: 'WARNING', message: 'Duplicate of the same line.' } },
    { check_id: 'rules.express.express_xss', path: 'C:/work/src/user.js', start: { line: 19 }, extra: { severity: 'ERROR', message: 'Reflected XSS.' } },
  ],
  errors: [],
})

const SOURCE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')

/** 偽の `$` ── git status と Semgrep の結果を返し、送ったプロンプトと保存領域を控える */
function fake(store: Record<string, unknown> = {}) {
  const submitted: string[] = []
  const runs: string[][] = []
  const cwds: string[] = []
  const $: any = {
    process: {
      run: async (argv: string[], init?: any) => {
        runs.push(argv)
        cwds.push(String(init?.cwd ?? ''))
        if (argv[0] === 'git' && argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'C:/work\n', stderr: '' }
        if (argv[0] === 'git') return { exitCode: 0, stdout: ' M src/user.js\n?? notes.md\n D old.js\n', stderr: '' }
        return { exitCode: 1, stdout: SEMGREP, stderr: '' }
      },
    },
    fs: { read: async () => SOURCE },
    store: {
      get: async (k: string) => store[k],
      set: async (k: string, v: unknown) => {
        store[k] = v
      },
    },
    prompt: { submit: async (o: any) => submitted.push(o.text) },
    ui: { invalidate: () => {}, toast: () => {} },
  }
  return { $, submitted, runs, cwds, store }
}

/** 設定とプロジェクトの場所を入れ直す ── セッションの開始で、プロジェクトの場所を C:/work にする */
async function setup() {
  const hooks: Record<string, Function> = {}
  register(((ev: string, a: any, b?: any) => {
    hooks[ev] = typeof a === 'function' ? a : b
  }) as any, {} as any)
  await hooks['session.start']({ command: { register: async () => {} }, clock: { after: () => {} } }, { cwd: 'C:/work' }, async (e: any) => e)
  return hooks
}

describe('自動で開く', () => {
  test('起動したら画面の右を開いて調べる、キーボードは奪わない', async () => {
    const hooks: Record<string, Function> = {}
    register(((ev: string, a: any, b?: any) => {
      hooks[ev] = typeof a === 'function' ? a : b
    }) as any, {} as any)
    const f = fake()
    let later: Function = () => {}
    const opened: any[] = []
    f.$.command = { register: async () => {} }
    f.$.clock = { after: (_ms: number, fn: Function) => (later = fn) }
    f.$.ui.open = async (o: any) => opened.push(o)
    await hooks['session.start'](f.$, { cwd: 'C:/work' }, async (e: any) => e)
    await later()
    expect(opened).toHaveLength(1)
    expect(opened[0].focus).toBe(undefined)
    expect(f.runs.some((a) => a[0] !== 'git')).toBe(true)
  })

  test('画面の無いセッションでは、自動では調べない', async () => {
    const hooks: Record<string, Function> = {}
    register(((ev: string, a: any, b?: any) => {
      hooks[ev] = typeof a === 'function' ? a : b
    }) as any, {} as any)
    let scheduled = false
    await hooks['session.start']({ command: { register: async () => {} }, clock: { after: () => (scheduled = true) } }, { cwd: 'C:/work', isInteractive: false }, async (e: any) => e)
    expect(scheduled).toBe(false)
  })
})

describe('調べるファイル', () => {
  test('サブフォルダで起動しても、リポジトリの一番上を起点に Semgrep を動かす', async () => {
    const hooks: Record<string, Function> = {}
    register(((ev: string, a: any, b?: any) => {
      hooks[ev] = typeof a === 'function' ? a : b
    }) as any, {} as any)
    await hooks['session.start']({ command: { register: async () => {} }, clock: { after: () => {} } }, { cwd: 'C:/work/packages/app' }, async (e: any) => e)
    const f = fake()
    await scan(f.$)
    const i = f.runs.findIndex((a) => a[0] !== 'git')
    expect(f.cwds[0]).toBe('C:/work/packages/app')
    expect(f.cwds[i]).toBe('C:/work')
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('src/user.js line 19')
  })

  test('git の管理下でないフォルダでは、何も調べない', async () => {
    await setup()
    const f = fake()
    f.$.process.run = async (argv: string[]) => {
      f.runs.push(argv)
      return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
    }
    await scan(f.$)
    expect(f.runs.some((a) => a[0] !== 'git')).toBe(false)
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('No changed code files')
  })

  test('変更中と未追跡のコードだけを取り、消したファイルと文書は除く', () => {
    expect(changedFiles(' M src/a.ts\n?? src/b.py\n D gone.js\n?? README.md\nR  old.js -> src/new.js\n')).toEqual(['src/a.ts', 'src/b.py', 'src/new.js'])
  })
})

describe('一覧にする', () => {
  test('同じ行に当たったルールは1件にまとめ、いちばん深刻な深刻度と説明を出す', () => {
    const list = parseResults(SEMGREP, 'C:/work', (p, l) => `code at ${p}:${l}`)
    expect(list.map((f) => `${f.path}:${f.line} ${f.rules.join('+')} ${f.severity}`)).toEqual([
      'src/user.js:19 raw-html-format+express_xss ERROR',
      'src/user.js:24 code-string-concat ERROR',
    ])
    expect(list[0].message).toBe('Reflected XSS.')
    expect(list[1].keys).toEqual(['code-string-concat|src/user.js|code at src/user.js:24'])
  })

  test('深刻度は、使う人に伝わる言葉にする', () => {
    expect([riskLabel('ERROR'), riskLabel('WARNING'), riskLabel('INFO')]).toEqual(['High risk', 'Medium risk', 'Low risk'])
  })

  test('説明は最初の1文にする', () => {
    expect(firstSentence('User controlled data in eval(). This is dangerous.')).toBe('User controlled data in eval().')
  })
})

describe('ふるい分け', () => {
  test('/scan で調べると、変更中のコードのファイルだけを Semgrep に渡し、画面の右に1件目を出す', async () => {
    await setup()
    const f = fake()
    await scan(f.$)
    const sem = f.runs.find((a) => a[0] !== 'git')!
    expect(sem.slice(-1)).toEqual(['src/user.js'])
    expect(sem).toContain('p/nodejsscan')
    const p = parts()
    const text = JSON.stringify(drawPane(p.t, () => {}))
    expect(text).toContain('Security scan · 2 possible issues')
    expect(text).toContain('1 of 2 · src/user.js line 19')
    expect(text).toContain('High risk')
    expect(text).toContain('Semgrep rule: raw-html-format, express_xss')
    expect(text).toContain('Ask Claude to fix')
  })

  test('Ask Claude to fix で Claude に送り、一覧から外す', async () => {
    await setup()
    const f = fake()
    await scan(f.$)
    await act(f.$, 'fix')
    expect(f.submitted).toHaveLength(1)
    expect(f.submitted[0]).toContain('src/user.js:19 (raw-html-format, express_xss, ERROR)')
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('1 possible issue')
  })

  test('Not a problem で、その行のルールをまとめて覚え、次に調べたときは出さない', async () => {
    await setup()
    const f = fake()
    await scan(f.$)
    await act(f.$, 'ignore')
    expect(f.store.ignored).toEqual(['raw-html-format|src/user.js|line 19', 'express_xss|src/user.js|line 19'])
    await scan(f.$)
    const text = JSON.stringify(drawPane(parts().t, () => {}))
    expect(text).toContain('1 possible issue')
    expect(text).not.toContain('line 19')
  })

  test('Undo で、直前に Not a problem にしたものを一覧と保存領域から戻す', async () => {
    await setup()
    const f = fake()
    await scan(f.$)
    await act(f.$, 'ignore')
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('Undo')
    await act(f.$, 'undo')
    expect(f.store.ignored).toEqual([])
    const text = JSON.stringify(drawPane(parts().t, () => {}))
    expect(text).toContain('2 possible issues')
    expect(text).toContain('1 of 2 · src/user.js line 19')
    expect(text).not.toContain('Undo')
  })

  test('/scan reset で、覚えたものを全部忘れる', async () => {
    await setup()
    const f = fake({ ignored: ['express_xss|src/user.js|line 19'] })
    await resetIgnored(f.$)
    expect(f.store.ignored).toEqual([])
  })

  test('Skip for now で最後に回す', async () => {
    await setup()
    const f = fake()
    await scan(f.$)
    await act(f.$, 'later')
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('1 of 2 · src/user.js line 24')
  })

  test('Semgrep が見つからなければ、入れ方と /config の行を案内する', async () => {
    await setup()
    const f = fake()
    f.$.process.run = async (argv: string[]) => {
      if (argv[0] === 'git') return { exitCode: 0, stdout: ' M a.js\n', stderr: '' }
      throw new Error("ENOENT: Command 'semgrep' not found or is in an unsafe location")
    }
    await scan(f.$)
    const text = JSON.stringify(drawPane(parts().t, () => {}))
    expect(text).toContain('Semgrep not found')
    expect(text).toContain('uv tool install semgrep')
    expect(text).toContain('Semgrep command · security-scan  (now: semgrep)')
  })

  test('それ以外の失敗は、エラーの文を出す', async () => {
    await setup()
    const f = fake()
    f.$.process.run = async (argv: string[]) => {
      if (argv[0] === 'git') return { exitCode: 0, stdout: ' M a.js\n', stderr: '' }
      return { exitCode: 2, stdout: '', stderr: 'Failed to download rules' }
    }
    await scan(f.$)
    expect(JSON.stringify(drawPane(parts().t, () => {}))).toContain('Could not run Semgrep: Failed to download rules')
  })
})

describe('Claude に送る文', () => {
  test('誤検知もありうることを添える', () => {
    const text = fixPrompt({ keys: ['k'], path: 'a.js', line: 3, rules: ['r'], severity: 'ERROR', message: 'm', code: '  x()  ' })
    expect(text).toContain('Check whether it is real')
    expect(text).toContain('Code: x()')
  })
})

describe('プロンプトの上の1行', () => {
  test('ふるい分けが残っているときだけ出す', async () => {
    await setup()
    const f = fake()
    f.$.process.run = async (argv: string[]) => ({ exitCode: 0, stdout: argv[0] === 'git' ? '' : '{"results":[]}', stderr: '' })
    await scan(f.$)
    expect(drawBand(parts().t, () => {})).toBeNull()
  })
})

// 校验源码里用到的 Tailwind 类名都能真正产出样式。
//
// 写错的类名（例如把 `wrap-anywhere` 写成 `overflow-wrap-anywhere`）既不会报错、
// 也不会产出任何 CSS，只是静默失效：元素看起来"没生效"，但类型检查和 lint 都查不出来。
// 这里用项目实际安装的 Tailwind 编译器逐条编译源码里出现的类名，找出这类死类名。
//
// 依赖 `@tailwindcss/node`（由 `@tailwindcss/vite` 提升到顶层 node_modules）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const srcDir = path.join(frontendRoot, 'src')
const indexCssPath = path.join(srcDir, 'index.css')

/**
 * 只检查"看起来像工具类"的 token，避免把普通字符串（`react`、`button` 等）
 * 误判成死类名。这里按 Tailwind 的工具类前缀做白名单过滤：
 * 漏检（少报一个死类名）可以接受，误报会让检查无法使用。
 */
const UTILITY_ROOTS = new Set([
  'static',
  'fixed',
  'absolute',
  'relative',
  'sticky',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z',
  'isolate',
  'isolation',
  'float',
  'clear',
  'object',
  'overflow',
  'overscroll',
  'visible',
  'invisible',
  'collapse',
  'hidden',
  'block',
  'inline',
  'flex',
  'grid',
  'table',
  'contents',
  'flow',
  'list',
  'sr-only',
  'not-sr-only',
  'box',
  'aspect',
  'columns',
  'break',
  'basis',
  'grow',
  'shrink',
  'order',
  'col',
  'row',
  'gap',
  'justify',
  'items',
  'content',
  'self',
  'place',
  'p',
  'px',
  'py',
  'ps',
  'pe',
  'pt',
  'pr',
  'pb',
  'pl',
  'm',
  'mx',
  'my',
  'ms',
  'me',
  'mt',
  'mr',
  'mb',
  'ml',
  'space',
  'divide',
  'w',
  'min',
  'max',
  'h',
  'size',
  'font',
  'text',
  'leading',
  'tracking',
  'antialiased',
  'subpixel-antialiased',
  'whitespace',
  'truncate',
  'wrap',
  'indent',
  'align',
  'underline',
  'overline',
  'line-through',
  'no-underline',
  'uppercase',
  'lowercase',
  'capitalize',
  'normal-case',
  'italic',
  'not-italic',
  'ordinal',
  'slashed-zero',
  'lining-nums',
  'oldstyle-nums',
  'proportional-nums',
  'tabular-nums',
  'diagonal-fractions',
  'stacked-fractions',
  'hyphens',
  'placeholder',
  'caret',
  'accent',
  'bg',
  'from',
  'via',
  'to',
  'border',
  'outline',
  'ring',
  'rounded',
  'shadow',
  'opacity',
  'mix-blend',
  'bg-blend',
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'saturate',
  'sepia',
  'backdrop',
  'border-collapse',
  'border-separate',
  'table-auto',
  'table-fixed',
  'caption',
  'transition',
  'duration',
  'ease',
  'delay',
  'animate',
  'scale',
  'rotate',
  'translate',
  'skew',
  'origin',
  'transform',
  'transform-gpu',
  'transform-none',
  'appearance',
  'cursor',
  'pointer-events',
  'resize',
  'scroll',
  'snap',
  'touch',
  'select',
  'will-change',
  'fill',
  'stroke',
  'decoration',
  'mask',
  'bg-clip',
  'bg-origin',
  'bg-repeat',
  'bg-size',
  'bg-position',
])

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSourceFiles(full, out)
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full)
  }
  return out
}

function looksLikeUtility(token) {
  // 去掉变体前缀（hover:、motion-reduce: 等）与负值前缀，只看工具类本身。
  const utility = (token.split(':').pop() ?? '').replace(/^-/, '')
  // 必须形如 `<根>-...` 或 `<根>[...]`：裸词（`text`、`content`、`size`）
  // 以及 MIME 类型（`text/plain`）都不是类名，不能当候选。
  const match = /^([a-z][a-z0-9-]*?)(?:-|\[)/.exec(utility)
  return match !== null && UTILITY_ROOTS.has(match[1])
}

/** 收集源码字符串字面量里出现的候选类名，以及它们出现的位置。 */
function collectCandidates(files) {
  const candidates = new Map()
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const literals =
      text.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []
    for (const literal of literals) {
      for (const token of literal.slice(1, -1).split(/\s+/)) {
        if (token.length < 4) continue
        if (/[{};=]/.test(token)) continue
        if (token.startsWith('--') || token.startsWith('var(')) continue
        if (/\$\{/.test(token)) continue
        if (!/^[a-zA-Z-][a-zA-Z0-9_\-[\]/.%#():,!+*&>~]*$/.test(token)) continue
        if (!looksLikeUtility(token)) continue
        if (!candidates.has(token)) candidates.set(token, new Set())
        candidates.get(token).add(path.relative(frontendRoot, file))
      }
    }
  }
  return candidates
}

function escapeClass(token) {
  return token.replace(/[.[\]()%/#!,:+*>~'"$&]/g, (c) => '\\' + c)
}

/** 已产出的 CSS 里是否存在该选择器（后面不能紧跟标识符字符，避免前缀误匹配）。 */
function isEmitted(output, token) {
  const escaped = escapeClass(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`).test(output)
}

const candidates = collectCandidates(walkSourceFiles(srcDir))
const compiler = await compile(fs.readFileSync(indexCssPath, 'utf8'), {
  base: frontendRoot,
  from: indexCssPath,
  onDependency: () => {},
  shouldRewriteUrls: false,
})

const output = compiler.build([...candidates.keys()])
const dead = [...candidates.entries()]
  .filter(([token]) => !isEmitted(output, token))
  .sort((left, right) => left[0].localeCompare(right[0]))

if (dead.length > 0) {
  console.error(`发现 ${dead.length} 个不会产出任何样式的 Tailwind 类名：\n`)
  for (const [token, files] of dead) {
    console.error(`  ${token}`)
    for (const file of files) console.error(`      ${file}`)
  }
  process.exit(1)
}

console.log(`Tailwind 类名校验通过（检查了 ${candidates.size} 个候选类名）`)

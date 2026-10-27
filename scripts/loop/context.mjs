#!/usr/bin/env node
// Prepared reading for one build loop task. Cuts what a builder needs into one
// file, so it reads that instead of exploring: the stack and the versions it
// must write for, the doc sections its areas need (`reading` in the
// settings), any extra sections the spec named, the decision of its research
// write-ups (never the sources), the readiness standard, the newest lessons,
// and the files it owns with their sizes. A builder's tokens are mostly
// context re-read on each turn, so a short start is the biggest saving there is.
//
//   node scripts/loop/context.mjs --task invoice-list --areas ui,data \
//     --sections "docs/design.md#Tables,CONTRIBUTING.md#Forms" \
//     --research docs/build-loop/research/invoices/invoice-list-1.md \
//     --files src/billing/invoice-list.tsx
//
// A section is "path#Heading": the heading whose text starts with "Heading",
// running to the next heading of the same or a higher level. A path with no
// "#" is the whole file. Prints the path it wrote and its size in words.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LESSONS_FILE, LOOP_DIR, ROOT, loopConfig } from './lib/loop-config.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const task = (arg('task') ?? 'task').replace(/[^\w.-]/g, '')
const list = (value) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const config = loopConfig()

/** Markdown headings outside code fences, with their level and line. */
function headings(lines) {
  const found = []
  let fenced = false
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && line.match(/^(#{1,4})\s+(.*)$/)
    if (m) found.push({ level: m[1].length, text: m[2].trim(), index })
  })
  return found
}

function cut(text, heading) {
  const lines = text.split('\n')
  const all = headings(lines)
  const at = all.findIndex((h) => h.text.toLowerCase().startsWith(heading.toLowerCase()))
  if (at === -1) return null
  const start = all[at]
  const end = all.slice(at + 1).find((h) => h.level <= start.level)
  return lines
    .slice(start.index, end ? end.index : undefined)
    .join('\n')
    .trim()
}

function section(ref) {
  const [path, heading] = ref.split('#')
  if (!existsSync(join(ROOT, path))) return `(No file ${path}.)`
  const text = read(path).replace(/^---\n[\s\S]*?\n---\n/, '')
  if (!heading) return `### ${path}\n\n${text.trim()}`
  const part = cut(text, heading)
  return part ? `### ${path}\n\n${part}` : `(No section of ${path} starts with "${heading}".)`
}

const refs = [
  ...new Set([
    ...list(arg('areas')).flatMap((area) => config.reading[area] ?? []),
    ...list(arg('sections')),
  ]),
]

const research = list(arg('research')).flatMap((path) =>
  existsSync(join(ROOT, path))
    ? [`### ${path}`, '', read(path).split(/\n## Sources/)[0].trim(), '']
    : [`(No research write-up at ${path}.)`, ''],
)

const lessons = existsSync(LESSONS_FILE)
  ? readFileSync(LESSONS_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .slice(-20)
  : []

const sizes = list(arg('files')).flatMap((path) => {
  const full = join(ROOT, path)
  if (!existsSync(full)) return [`- ${path} (new)`]
  if (statSync(full).isDirectory()) return [`- ${path}/ (${readdirSync(full).length} entries)`]
  return [`- ${path} (${read(path).split('\n').length} lines)`]
})

const stack = config.stack ?? {}
const dependencies = (stack.dependencies ?? []).map(
  (d) => `- ${d.name} ${d.version ?? ''}${d.docs ? ` (${d.docs})` : ''}`.trimEnd(),
)

const parts = [
  `# Prepared reading for task "${task}"`,
  '',
  'Written by scripts/loop/context.mjs. Read this instead of the full docs; open other files only when the task needs them, by line range.',
  '',
  '## Files you own',
  '',
  ...sizes,
  '',
  ...(stack.summary || dependencies.length
    ? [
        '## The stack',
        '',
        ...(stack.summary ? [stack.summary, ''] : []),
        'Write for these versions and follow their own conventions. When unsure how a version does something, check its official docs rather than memory.',
        '',
        ...dependencies,
        '',
      ]
    : []),
  ...(config.projectDocs.length
    ? [
        '## The project rules',
        '',
        `These files are the law: ${config.projectDocs.join(', ')}. Open them by heading when your task touches what they cover.`,
        '',
      ]
    : []),
  '## The docs your task needs',
  '',
  ...(refs.length ? refs.map((ref) => section(ref) + '\n') : ['(None named for these areas.)', '']),
  ...(research.length
    ? [
        '## Research decisions',
        '',
        'Follow these. The sources behind them are in the same files, under Sources, if you need to check one.',
        '',
        ...research,
      ]
    : []),
  '## Readiness standard',
  '',
  existsSync(join(ROOT, config.readiness)) ? read(config.readiness).trim() : `(No ${config.readiness} yet.)`,
  '',
  ...(lessons.length ? ['## Lessons from earlier runs', '', ...lessons, ''] : []),
]
const text = parts.join('\n')
const dir = join(LOOP_DIR, 'context')
mkdirSync(dir, { recursive: true })
const path = join(dir, `${task}.md`)
writeFileSync(path, text)
console.info(JSON.stringify({ path, words: text.split(/\s+/).length }))

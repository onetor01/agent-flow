import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/common/PresetFlows.ts'), 'utf-8')

// 提取 export const PresetFlows: Flow[] = [...] 中的数组字面量
const match = src.match(/=\s*\[/)
if (!match) throw new Error('文件格式错误')
const start = match.index + match[0].length - 1
const arrayLiteral = src.slice(start)
console.log(arrayLiteral)
// .join('\n') 是合法 JS，直接 eval 求值
const flows = eval(arrayLiteral)

const out = join(root, 'preset-flows.json')
writeFileSync(out, JSON.stringify(flows, null, 2), 'utf-8')
console.log(`预设flow已更新`)

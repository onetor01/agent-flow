import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const run = (cmd) => {
  console.log(`> ${cmd}\n`)
  // 用 inherit 把 git/npm 输出直接打到终端 —— 否则 push 失败 / 认证失败这类
  // 关键错误会被静默吞掉，导致 tag 没真正推上去但脚本看上去成功(实际 fork 远程
  // 仓库的 Actions 也跑不起来,本地却以为已经发布)。
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

const tag = execSync('npm version patch --no-git-tag-version', { cwd: root }).toString().trim()
console.log(`> npm version patch -> ${tag}\n`)

run(`npm run format`)
run(`git add .`)
run(`git commit -m "${tag}"`)
run(`git tag ${tag}`)
run(`git push`)
run(`git push origin --tags`)

console.log(`已发布 ${tag}`)

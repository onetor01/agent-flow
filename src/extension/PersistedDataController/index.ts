import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { type PersistedData, PersistedDataSchema, validateFlow } from '@/common'

const FLOWS_FILENAME = '.agent-flows.json'

/** 本地 flows 持久化读写 */
export class PersistedDataController {
  constructor(private filePath: string) {}

  /** 全局存储（用户主目录） */
  static globalStore(): PersistedDataController {
    return new PersistedDataController(path.join(os.homedir(), FLOWS_FILENAME))
  }

  /** 项目存储（工作区根目录） */
  static projectStore(workspaceRoot: string): PersistedDataController {
    return new PersistedDataController(path.join(workspaceRoot, FLOWS_FILENAME))
  }

  async load(): Promise<PersistedData> {
    const fallback: PersistedData = { flows: [] }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const json = JSON.parse(raw)
      const parsed = PersistedDataSchema.safeParse(json)

      if (!parsed.success) {
        return fallback
      }

      // 对每个 flow 做语义校验
      const hasSemanticError = parsed.data.flows.some((flow) => {
        const result = validateFlow(flow)
        return result.duplicateAgentNames || result.invalidNextAgent || result.duplicateOutputNames
      })

      if (hasSemanticError) {
        return fallback
      }

      return parsed.data
    } catch {
      return fallback
    }
  }

  private saveQueue: Promise<void> = Promise.resolve()

  async save(data: PersistedData): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this._doSave(data))
    return this.saveQueue
  }

  private async _doSave(data: PersistedData): Promise<void> {
    const tmpPath = this.filePath + '.tmp'
    const content = JSON.stringify(data, null, 2)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf-8')
    // Windows 上 rename 在目标文件已存在时会失败，先尝试删除旧文件
    try {
      await fs.unlink(this.filePath)
    } catch {
      // 旧文件不存在，忽略
    }
    await fs.rename(tmpPath, this.filePath)
  }
}

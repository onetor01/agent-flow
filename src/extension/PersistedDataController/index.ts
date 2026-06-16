import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  type PersistedData,
  PersistedDataSchema,
  type WorkspacePersistedData,
  WorkspacePersistedDataSchema,
  validateFlow,
} from '@/common'

const FLOWS_FILENAME = '.agent-flows.json'
const WORKSPACE_FLOWS_DIR = '.agent-flows-projects'

function sanitizeCwd(cwd: string): string {
  return cwd
    .replace(/[:\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

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
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this._doSave(data))
    return this.saveQueue
  }

  private async _doSave(data: PersistedData): Promise<void> {
    const tmpPath = this.filePath + '.tmp'
    const content = JSON.stringify(data, null, 2)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf-8')
    // copyFile 原子覆盖目标文件，避免 Windows 上 unlink→rename 的文件名占用竞态
    await fs.copyFile(tmpPath, this.filePath)
    await fs.unlink(tmpPath)
  }
}

/** ~/.agent-flows-projects/<sanitized_cwd>.json 的读写控制器 */
export class WorkspacePersistedDataController {
  constructor(private filePath: string) {}

  /** 工作区存储（~/.agent-flows-projects/<sanitized_cwd>.json） */
  static workspaceStore(cwd: string): WorkspacePersistedDataController {
    return new WorkspacePersistedDataController(
      path.join(os.homedir(), WORKSPACE_FLOWS_DIR, sanitizeCwd(cwd) + '.json'),
    )
  }

  /**
   * 加载工作区持久化数据。
   * - 返回 null：文件不存在（调用方应 fallback 到 projectStore 读 flows）
   * - 返回 fallback：文件存在但解析失败（不触发 fallback，flows/runStates 均为空）
   */
  async load(): Promise<WorkspacePersistedData | null> {
    const fallback: WorkspacePersistedData = { flows: [], runStates: {} }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const json = JSON.parse(raw)
      const parsed = WorkspacePersistedDataSchema.safeParse(json)
      if (!parsed.success) return fallback

      const hasSemanticError = parsed.data.flows.some((flow) => {
        const result = validateFlow(flow)
        return result.duplicateAgentNames || result.invalidNextAgent || result.duplicateOutputNames
      })
      if (hasSemanticError) return fallback

      return parsed.data
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null
      }
      return fallback
    }
  }

  private saveQueue: Promise<void> = Promise.resolve()

  async save(data: WorkspacePersistedData): Promise<void> {
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this._doSave(data))
    return this.saveQueue
  }

  private async _doSave(data: WorkspacePersistedData): Promise<void> {
    const tmpPath = this.filePath + '.tmp'
    const content = JSON.stringify(data, null, 2)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.copyFile(tmpPath, this.filePath)
    await fs.unlink(tmpPath)
  }
}

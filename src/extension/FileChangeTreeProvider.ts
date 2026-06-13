import * as path from 'path'
import { match } from 'ts-pattern'
import * as vscode from 'vscode'

export type RunEditOp = { old_string: string; new_string: string; replace_all: boolean }
export type RunChangedFile = {
  filePath: string
  changeKind: 'new' | 'modified'
  edits: RunEditOp[]
}

type DirNode = { type: 'dir'; name: string; children: TreeNode[] }
type FileNode = { type: 'file'; file: RunChangedFile }
type TreeNode = DirNode | FileNode

export class FileChangeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private files: RunChangedFile[] = []

  constructor(private readonly workspaceRoot: string | undefined) {}

  setChanges(files: RunChangedFile[]): void {
    this.files = files
    this._onDidChangeTreeData.fire()
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) {
      return match(node)
        .with({ type: 'dir' }, (n) => n.children)
        .with({ type: 'file' }, () => [])
        .exhaustive()
    }
    return buildTree(this.files, this.workspaceRoot)
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return match(node)
      .with({ type: 'dir' }, (n) => {
        const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded)
        item.iconPath = new vscode.ThemeIcon('folder')
        return item
      })
      .with({ type: 'file' }, (n) => {
        const item = new vscode.TreeItem(
          path.basename(n.file.filePath),
          vscode.TreeItemCollapsibleState.None,
        )
        item.description = n.file.changeKind === 'modified' ? 'M' : 'A'
        item.resourceUri = vscode.Uri.file(n.file.filePath)
        item.command =
          n.file.changeKind === 'new'
            ? {
                command: 'agent-flow.openRunFile',
                title: '',
                arguments: [{ filename: n.file.filePath }],
              }
            : {
                command: 'agent-flow.openRunDiffFile',
                title: '',
                arguments: [{ file_path: n.file.filePath, edits: n.file.edits }],
              }
        return item
      })
      .exhaustive()
  }
}

function buildTree(files: RunChangedFile[], workspaceRoot: string | undefined): TreeNode[] {
  const dirMap = new Map<string, DirNode>()
  const roots: TreeNode[] = []

  function ensureDir(parts: string[]): DirNode {
    const key = parts.join('/')
    if (dirMap.has(key)) return dirMap.get(key)!
    const node: DirNode = { type: 'dir', name: parts[parts.length - 1], children: [] }
    dirMap.set(key, node)
    if (parts.length === 1) roots.push(node)
    else ensureDir(parts.slice(0, -1)).children.push(node)
    return node
  }

  for (const file of files) {
    const rel = workspaceRoot ? path.relative(workspaceRoot, file.filePath) : null
    const isInWorkspace = rel != null && !rel.startsWith('..') && !path.isAbsolute(rel)
    const leaf: FileNode = { type: 'file', file }
    if (isInWorkspace) {
      const parts = rel.split(path.sep)
      if (parts.length === 1) roots.push(leaf)
      else ensureDir(parts.slice(0, -1)).children.push(leaf)
    } else {
      roots.push(leaf)
    }
  }

  return roots
}

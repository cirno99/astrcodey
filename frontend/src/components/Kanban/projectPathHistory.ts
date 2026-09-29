/**
 * 新建卡片时用过的项目路径历史。
 *
 * 只服务于前端输入框的候选下拉：路径的权威来源始终是卡片本身，
 * 这里读不到历史只会少几个候选，不影响卡片创建。
 */

const PROJECT_PATH_HISTORY_STORAGE_KEY = 'astrcode:kanbanProjectPathHistory'

/** 候选上限；超出后丢弃最久未使用的路径。 */
const PROJECT_PATH_HISTORY_LIMIT = 10

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 最近使用的路径在前；解析失败时返回空列表。 */
export function readProjectPathHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(PROJECT_PATH_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!isStringArray(parsed)) return []
    return parsed.map((dir) => dir.trim()).filter((dir) => dir.length > 0)
  } catch {
    return []
  }
}

/** 落盘失败只丢历史，不阻断看板页的其它操作（例如创建卡片）。 */
function writeProjectPathHistory(paths: string[]): void {
  try {
    window.localStorage.setItem(
      PROJECT_PATH_HISTORY_STORAGE_KEY,
      JSON.stringify(paths)
    )
  } catch {
    // 存储不可用时静默放弃持久化，调用方仍拿到内存中的结果。
  }
}

/** 把路径提到最前并落盘，返回写入后的列表。 */
export function rememberProjectPath(workingDir: string): string[] {
  const trimmed = workingDir.trim()
  if (!trimmed) return readProjectPathHistory()

  const next = [
    trimmed,
    ...readProjectPathHistory().filter((dir) => dir !== trimmed),
  ].slice(0, PROJECT_PATH_HISTORY_LIMIT)

  writeProjectPathHistory(next)
  return next
}

/**
 * 从历史中移除某条路径，返回移除后的列表。
 *
 * 只影响历史记录本身：输入框里已填的草稿、以及由会话列表推导出的候选都不受影响。
 */
export function forgetProjectPath(workingDir: string): string[] {
  const trimmed = workingDir.trim()
  if (!trimmed) return readProjectPathHistory()

  const next = readProjectPathHistory().filter((dir) => dir !== trimmed)
  writeProjectPathHistory(next)
  return next
}

/** 合并历史与其它来源的路径候选：历史顺序优先，去重并丢弃空值。 */
export function mergeProjectPathCandidates(
  history: string[],
  sources: Array<string | null | undefined>
): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const source of [...history, ...sources]) {
    const trimmed = source?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    candidates.push(trimmed)
  }
  return candidates
}

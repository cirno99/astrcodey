/**
 * 新建卡片时用过的项目路径历史。
 *
 * 只服务于前端输入框的候选下拉：路径的权威来源始终是卡片本身，
 * 这里读不到历史只会少几个候选，不影响卡片创建。
 *
 * 候选由历史、默认目录与会话目录三处合并而来，因此「删除」除了清历史还要记一份
 * 已忽略路径：只清历史的话，会话目录推导出的候选下一轮渲染就回来了。
 */

const PROJECT_PATH_HISTORY_STORAGE_KEY = 'astrcode:kanbanProjectPathHistory'

/** 被用户从候选里删掉的路径；与历史分开存：一个是最近用过，一个是不想再看。 */
const IGNORED_PROJECT_PATH_STORAGE_KEY = 'astrcode:kanbanIgnoredProjectPaths'

/** 候选上限；超出后丢弃最久未使用的路径。 */
const PROJECT_PATH_HISTORY_LIMIT = 10

/** 忽略上限；超出后丢弃最早忽略的路径。 */
const IGNORED_PROJECT_PATH_LIMIT = 50

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 读取一份路径列表；解析失败或存储不可用时返回空列表。 */
function readStringList(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!isStringArray(parsed)) return []
    return parsed.map((dir) => dir.trim()).filter((dir) => dir.length > 0)
  } catch {
    return []
  }
}

/** 落盘失败只丢这一份列表，不阻断看板页的其它操作（例如创建卡片）。 */
function writeStringList(storageKey: string, paths: string[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(paths))
  } catch {
    // 存储不可用时静默放弃持久化，调用方仍拿到内存中的结果。
  }
}

/** 最近使用的路径在前；解析失败时返回空列表。 */
export function readProjectPathHistory(): string[] {
  return readStringList(PROJECT_PATH_HISTORY_STORAGE_KEY)
}

/** 被用户从候选里删掉的路径；解析失败时返回空列表。 */
export function readIgnoredProjectPaths(): string[] {
  return readStringList(IGNORED_PROJECT_PATH_STORAGE_KEY)
}

/**
 * 把路径提到最前并落盘，返回写入后的列表。
 *
 * 同时撤销该路径的忽略：用户又用它建了卡片，说明之前那次「删除」不再成立。
 */
export function rememberProjectPath(workingDir: string): string[] {
  const trimmed = workingDir.trim()
  if (!trimmed) return readProjectPathHistory()

  const next = [
    trimmed,
    ...readProjectPathHistory().filter((dir) => dir !== trimmed),
  ].slice(0, PROJECT_PATH_HISTORY_LIMIT)

  writeStringList(PROJECT_PATH_HISTORY_STORAGE_KEY, next)
  writeStringList(
    IGNORED_PROJECT_PATH_STORAGE_KEY,
    readIgnoredProjectPaths().filter((dir) => dir !== trimmed)
  )
  return next
}

/**
 * 从候选中移除某条路径，返回移除后的历史列表。
 *
 * 候选是历史、默认目录与会话目录的并集，所以除了清历史还要记进忽略集：
 * 否则会话目录推导出的候选下一轮渲染就回来，用户看到的就是「删不掉」。
 * 只影响候选列表：输入框里已填的草稿、以及空输入时的默认目录都不受影响。
 * 再次用它新建卡片会撤销忽略，见 [`rememberProjectPath`]。
 */
export function forgetProjectPath(workingDir: string): string[] {
  const trimmed = workingDir.trim()
  if (!trimmed) return readProjectPathHistory()

  const next = readProjectPathHistory().filter((dir) => dir !== trimmed)
  writeStringList(PROJECT_PATH_HISTORY_STORAGE_KEY, next)

  const ignored = [
    trimmed,
    ...readIgnoredProjectPaths().filter((dir) => dir !== trimmed),
  ].slice(0, IGNORED_PROJECT_PATH_LIMIT)
  writeStringList(IGNORED_PROJECT_PATH_STORAGE_KEY, ignored)
  return next
}

/**
 * 合并历史与其它来源的路径候选：历史顺序优先，去重、丢弃空值，并剔除已忽略的路径。
 *
 * 忽略必须在这一层过滤，而不是靠调用方先删掉来源：被忽略的路径可能正是当前会话目录。
 */
export function mergeProjectPathCandidates(
  history: string[],
  sources: Array<string | null | undefined>,
  ignored: string[] = []
): string[] {
  const ignoredSet = new Set(ignored.map((dir) => dir.trim()))
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const source of [...history, ...sources]) {
    const trimmed = source?.trim()
    if (!trimmed || seen.has(trimmed) || ignoredSet.has(trimmed)) continue
    seen.add(trimmed)
    candidates.push(trimmed)
  }
  return candidates
}

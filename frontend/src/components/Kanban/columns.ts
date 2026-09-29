/**
 * 看板的列与落点词汇。
 *
 * 页面把六列拆成两个区域：公共卡片区（四格）与日历区（每个时间桶两个手风琴项）。
 * 两个区域合起来覆盖全部六列，不新增也不隐藏任何一列。
 */

import type { KanbanCardColumn } from '../../services/types'

export const COLUMN_LABELS: Record<KanbanCardColumn, string> = {
  backlog: '待办',
  ready: '待领取',
  analyzing: '分析中',
  implementing: '实施中',
  done: '已完成',
  blocked: '已阻塞',
}

export const COLUMN_HINTS: Record<KanbanCardColumn, string> = {
  backlog: '只记录，不自动执行',
  ready: '等待扩展领取',
  analyzing: '扩展正在分析需求',
  implementing: '扩展正在实施',
  done: '终态',
  blocked: '需要人工介入',
}

/**
 * 用户可写入的列。
 *
 * `analyzing` / `implementing` 由扩展独占，用户直接写入会和自动化打架。
 */
export const USER_WRITABLE_COLUMNS: KanbanCardColumn[] = [
  'backlog',
  'ready',
  'done',
  'blocked',
]

/** 公共卡片区的四格，按需求从上到下等分。 */
export const PUBLIC_AREA_COLUMNS: KanbanCardColumn[] = [
  'ready',
  'analyzing',
  'implementing',
  'blocked',
]

/**
 * 公共区里接受拖拽落点的格。
 *
 * 运行中的两格是只读展示：卡片正被扩展持有，前端写进去只会拿到 400。
 */
export const PUBLIC_AREA_DROP_COLUMNS: KanbanCardColumn[] = ['ready', 'blocked']

export function isRunningColumn(column: KanbanCardColumn): boolean {
  return column === 'analyzing' || column === 'implementing'
}

/**
 * 点击卡片会跳到对应对话的列。
 *
 * 「待办」还没有对话，「待领取」按需求也不在跳转范围内——即使续跑退回的卡片仍留着
 * `sessionId`，点击也保持无反应。
 */
export const CONVERSATION_COLUMNS: KanbanCardColumn[] = [
  'analyzing',
  'implementing',
  'done',
  'blocked',
]

export function opensConversation(column: KanbanCardColumn): boolean {
  return CONVERSATION_COLUMNS.includes(column)
}

/** 只有待办列的卡片允许改标题与正文；其余列要么正被扩展持有，要么已经产出了交付记录。 */
export function isEditableColumn(column: KanbanCardColumn): boolean {
  return column === 'backlog'
}

/** 日历列里的手风琴菜单项，恰好对应 `backlog` / `done` 两列。 */
export type CalendarSlot = 'backlog' | 'done'

export const CALENDAR_SLOTS: CalendarSlot[] = ['backlog', 'done']

export const CALENDAR_SLOT_LABELS: Record<CalendarSlot, string> = {
  backlog: '待办',
  done: '已完成',
}

/** 拖拽落点：公共区的某一格，或日历某个时间桶的某个手风琴项。 */
export type DropTarget =
  | { kind: 'column'; column: KanbanCardColumn }
  | { kind: 'bucket'; bucketKey: string; slot: CalendarSlot }

/**
 * 一列里实际展开的那一项。
 *
 * `null` 表示对半态：两项同时展开、各占一半高度，这是默认状态。
 * 用户点开某一项后进入手风琴态：优先用他点的那一项；它空而另一项有卡片时让位——
 * 否则卡片落进「已完成」后会被藏在一个收起的菜单项里，看起来像没落进去。
 */
export function resolveExpandedSlot(
  preferred: CalendarSlot | null,
  counts: Record<CalendarSlot, number>
): CalendarSlot | null {
  if (preferred === null) return null
  if (counts[preferred] > 0) return preferred
  const other: CalendarSlot = preferred === 'backlog' ? 'done' : 'backlog'
  return counts[other] > 0 ? other : preferred
}

export function sameDropTarget(
  left: DropTarget | null,
  right: DropTarget | null
): boolean {
  if (!left || !right) return left === right
  if (left.kind === 'column' && right.kind === 'column') {
    return left.column === right.column
  }
  if (left.kind === 'bucket' && right.kind === 'bucket') {
    return left.bucketKey === right.bucketKey && left.slot === right.slot
  }
  return false
}

/** 卡片改动：拖拽同时改列与归属日，卡片上的下拉框只改列。 */
export interface CardMove {
  column: KanbanCardColumn
  date?: string
}

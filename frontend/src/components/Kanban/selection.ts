/**
 * 看板多选的纯逻辑：点选、区间选中、框选命中，以及拖拽落点的折算。
 *
 * 跨列、跨日历桶没有天然的先后顺序，这里一律以调用方给出的有序 id 列表为准——
 * 页面按 DOM 顺序取卡片元素，因此「区间」与用户看到的排列一致。
 *
 * 与渲染无关，可在 node 下单测（见 `scripts/kanban-selection.test.mjs`）。
 */

import type { KanbanCard } from '../../services/types'
import { isRunningColumn, type CardMove } from './columns'

/** 视口坐标系下的矩形；与 `getBoundingClientRect` 同形，只保留判定所需的四个边。 */
export interface SelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface CardRectEntry {
  id: string
  rect: SelectionRect
}

/** 拖拽落点里与折算移动请求有关的字段；日历落点比列落点多一个归属日。 */
export interface MoveTarget {
  column: KanbanCard['column']
  /** 只有日历落点才有：拖进去要一并改写归属日。 */
  date?: string
}

export interface CardMoveRequest {
  cardId: string
  move: CardMove
}

/** 由任意两个对角点得到规范矩形，因此从右下往左上框选同样成立。 */
export function rectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): SelectionRect {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    right: Math.max(startX, endX),
    bottom: Math.max(startY, endY),
  }
}

/** 边贴边不算相交：零面积或零重叠的矩形不该选中卡片。 */
export function rectsIntersect(
  left: SelectionRect,
  right: SelectionRect
): boolean {
  return (
    left.left < right.right &&
    right.left < left.right &&
    left.top < right.bottom &&
    right.top < left.bottom
  )
}

/** 命中框选矩形的卡片 id，保持传入顺序。 */
export function idsInRect(
  rect: SelectionRect,
  entries: readonly CardRectEntry[]
): string[] {
  return entries
    .filter((entry) => rectsIntersect(rect, entry.rect))
    .map((entry) => entry.id)
}

export function toggleSelection(
  current: ReadonlySet<string>,
  cardId: string
): Set<string> {
  const next = new Set(current)
  if (next.has(cardId)) {
    next.delete(cardId)
  } else {
    next.add(cardId)
  }
  return next
}

/**
 * 区间选中：含首尾的连续一段。
 *
 * 锚点或目标已不在当前列表里（卡片被自动化删掉、或翻页换了列表）时返回空集，
 * 而不是退化成单选——用户按 Shift 时预期的是一个区间，悄悄只选一张更令人困惑。
 */
export function rangeSelection(
  orderedIds: readonly string[],
  anchorId: string,
  targetId: string
): Set<string> {
  const anchorIndex = orderedIds.indexOf(anchorId)
  const targetIndex = orderedIds.indexOf(targetId)
  if (anchorIndex === -1 || targetIndex === -1) return new Set()
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return new Set(orderedIds.slice(start, end + 1))
}

/** 运行中的列由扩展独占，选中它们只会让拖拽拿到 400，因此不参与多选。 */
export function isSelectableCard(card: KanbanCard): boolean {
  return !isRunningColumn(card.column)
}

/** 按当前看板内容剪枝：轮询会删掉卡片，也可能把卡片推进运行中的列。 */
export function selectableIds(
  cards: readonly KanbanCard[],
  ids: ReadonlySet<string>
): Set<string> {
  const selectable = new Set<string>()
  for (const card of cards) {
    if (ids.has(card.id) && isSelectableCard(card)) selectable.add(card.id)
  }
  return selectable
}

/**
 * 把一组被拖拽的卡片折算成逐张的移动请求。
 *
 * 两类卡片被丢掉：已经在目标位置的（发请求只会白白落盘并刷新一次），以及运行中的列
 * （选中之后、松手之前被自动化领走的卡片会走到这里，写入必然拿到 400）。
 * 全部被丢掉时返回空数组，调用方据此跳过这次落点。
 */
export function movesForDrop(
  cards: readonly KanbanCard[],
  cardIds: readonly string[],
  target: MoveTarget
): CardMoveRequest[] {
  const requests: CardMoveRequest[] = []
  for (const card of cards) {
    if (!cardIds.includes(card.id)) continue
    if (!isSelectableCard(card)) continue
    if (target.date === undefined) {
      if (card.column === target.column) continue
      requests.push({ cardId: card.id, move: { column: target.column } })
      continue
    }
    if (card.column === target.column && card.date === target.date) continue
    requests.push({
      cardId: card.id,
      move: { column: target.column, date: target.date },
    })
  }
  return requests
}

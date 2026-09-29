import type { DragEvent } from 'react'
import { cn } from '../../lib/utils'
import type { KanbanCard } from '../../services/types'
import { AccordionSection } from './AccordionSection'
import { KanbanCardList } from './KanbanCardList'
import type { KanbanCardHandlers } from './KanbanCardItem'
import { listsCards, type CalendarBucket, type CalendarScale } from './calendar'
import {
  CALENDAR_SLOTS,
  CALENDAR_SLOT_LABELS,
  resolveExpandedSlot,
  sameDropTarget,
  type CalendarSlot,
  type DropTarget,
} from './columns'

/** 有内容的列占日历视口宽度的四分之一，四列正好铺满视口。 */
const EXPANDED_COLUMN_CLASS = 'w-1/4'
/** 空列收缩到基准宽的三倍：既保留表格的连续性，又能一眼看出这一天没有卡片。 */
const COLLAPSED_COLUMN_CLASS = 'w-36'
/**
 * 日历的单元格样式：直角、无间隙，靠分隔线连成一张表。
 *
 * 列宽会在有卡片与没卡片之间跳变，因此表头高度必须固定，否则整张表的横线会错位。
 */
const CALENDAR_COLUMN_CLASS =
  'flex flex-none flex-col overflow-hidden border-r border-border bg-surface-soft last:border-r-0'
/** 表头是整张表的第一行，空列与非空列必须同高同样式，横线才连得起来。 */
const CALENDAR_HEADER_CLASS =
  'flex h-8 shrink-0 items-center justify-center border-b border-border px-2 text-[12px] font-semibold text-text-primary'

interface SlotDragProps {
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
}

interface CalendarBucketColumnProps {
  bucket: CalendarBucket
  scale: CalendarScale
  cardsBySlot: Record<CalendarSlot, KanbanCard[]>
  /** 用户点开的那一项；`null` 表示对半态。实际展开项由 `resolveExpandedSlot` 推导。 */
  preferredSlot: CalendarSlot | null
  /** 收到的是「下一个 preferred 值」而不是被点的那一项：再点已展开项即收回对半。 */
  onToggleSlot: (next: CalendarSlot | null) => void
  handlers: KanbanCardHandlers
  /** 只有日刻度的桶键才是真正的归属日，因此只有日刻度接受落点。 */
  acceptsDrop: boolean
  /** 今天所在的列：分隔线加重、表头加底色，并作为滚动条居中的锚点。 */
  isToday?: boolean
  dropTarget: DropTarget | null
  onDragOverSlot: (slot: CalendarSlot) => void
  onDragLeaveSlot: () => void
  onDropSlot: (slot: CalendarSlot) => void
}

/**
 * 日历里的一列：一个时间桶 + 两个手风琴菜单项。
 *
 * 桶里一张卡片都没有时整列收缩到基准宽的三倍，只留下菜单项标题；
 * 这时两个标题仍然各自是拖拽落点，否则空白的日子就没法接卡片。
 *
 * 有卡片时两个菜单项默认同时展开、各占一半高度，用户点开某一项才切成手风琴。
 */
export function CalendarBucketColumn({
  bucket,
  scale,
  cardsBySlot,
  preferredSlot,
  onToggleSlot,
  handlers,
  acceptsDrop,
  isToday,
  dropTarget,
  onDragOverSlot,
  onDragLeaveSlot,
  onDropSlot,
}: CalendarBucketColumnProps) {
  const counts: Record<CalendarSlot, number> = {
    backlog: cardsBySlot.backlog.length,
    done: cardsBySlot.done.length,
  }
  const expandedSlot = resolveExpandedSlot(preferredSlot, counts)
  /** 对半态下两项都展开；手风琴态下只有被选中的那一项展开。 */
  const isExpanded = (slot: CalendarSlot) =>
    expandedSlot === null || expandedSlot === slot
  const empty = counts.backlog + counts.done === 0

  const highlighted = (slot: CalendarSlot) =>
    sameDropTarget(dropTarget, { kind: 'bucket', bucketKey: bucket.key, slot })

  const slotDragProps = (slot: CalendarSlot): SlotDragProps => {
    if (!acceptsDrop) return {}
    return {
      onDragOver: (event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOverSlot(slot)
      },
      onDragLeave: (event) => {
        // dragleave 会从子元素冒泡上来，只有真正离开这一格才清掉高亮。
        const nextTarget = event.relatedTarget as Node | null
        if (event.currentTarget.contains(nextTarget)) return
        onDragLeaveSlot()
      },
      onDrop: (event) => {
        event.preventDefault()
        onDropSlot(slot)
      },
    }
  }

  if (empty) {
    return (
      <div
        data-today={isToday ? 'true' : undefined}
        className={cn(
          COLLAPSED_COLUMN_CLASS,
          CALENDAR_COLUMN_CLASS,
          isToday && 'border-r-border-strong'
        )}
      >
        <div
          className={cn(
            CALENDAR_HEADER_CLASS,
            'text-text-muted',
            isToday && 'bg-surface-muted text-text-primary'
          )}
        >
          {bucket.shortLabel}
        </div>
        {CALENDAR_SLOTS.map((slot) => (
          <div
            key={slot}
            {...slotDragProps(slot)}
            className={cn(
              'flex flex-1 items-start justify-center border-b border-border py-2 text-[11px] text-text-muted last:border-b-0',
              highlighted(slot) &&
                'bg-surface-muted ring-1 ring-inset ring-border-strong'
            )}
          >
            {CALENDAR_SLOT_LABELS[slot]}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      data-today={isToday ? 'true' : undefined}
      className={cn(
        EXPANDED_COLUMN_CLASS,
        CALENDAR_COLUMN_CLASS,
        isToday && 'border-r-border-strong'
      )}
    >
      <header
        className={cn(CALENDAR_HEADER_CLASS, isToday && 'bg-surface-muted')}
      >
        {bucket.label}
      </header>
      {CALENDAR_SLOTS.map((slot) => (
        <AccordionSection
          key={slot}
          title={CALENDAR_SLOT_LABELS[slot]}
          count={listsCards(scale) ? counts[slot] : undefined}
          expanded={isExpanded(slot)}
          onToggle={() => onToggleSlot(expandedSlot === slot ? null : slot)}
          highlighted={highlighted(slot)}
          {...slotDragProps(slot)}
        >
          {listsCards(scale) ? (
            <KanbanCardList
              cards={cardsBySlot[slot]}
              handlers={handlers}
              emptyHint="暂无卡片"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1">
              <span className="text-[20px] font-semibold text-text-primary">
                {counts[slot]}
              </span>
              <span className="text-[11px] text-text-muted">张卡片</span>
            </div>
          )}
        </AccordionSection>
      ))}
    </div>
  )
}

import type { DragEvent } from 'react'
import { cn } from '../../lib/utils'
import type { KanbanCard } from '../../services/types'
import { AccordionSection } from './AccordionSection'
import { KanbanCardList } from './KanbanCardList'
import type { KanbanCardHandlers } from './KanbanCardItem'
import {
  dayKeyToDate,
  listsCards,
  type CalendarBucket,
  type CalendarScale,
} from './calendar'
import { calendarColumn, calendarHeader } from './boardStyles'
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

/** 日刻度的列头要显示星期；日历只给日键，星期在这里派生，不进 calendar.ts 的日期逻辑。 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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
  /** 今天所在的列：表头与底色加强调，并作为滚动条居中的锚点。 */
  isToday?: boolean
  dropTarget: DropTarget | null
  onDragOverSlot: (slot: CalendarSlot) => void
  onDragLeaveSlot: () => void
  onDropSlot: (slot: CalendarSlot) => void
}

/**
 * 日历里的一列：一个时间桶 + 两个手风琴菜单项。
 *
 * 桶里一张卡片都没有时整列收缩到基准宽的三倍：列头只留日期，槽位文字默认隐身、
 * 悬停或拖到上面时才显出来——每个空列都印一遍「待办 / 已完成」会把整张表糊满。
 * 两个槽位仍然各自是拖拽落点，否则空白的日子就没法接卡片。
 *
 * 有卡片时两个菜单项默认同时展开、各占一半高度，用户点开某一项才切成手风琴。
 *
 * 「待办」与「已完成」是看板上仅有的两个日历槽位，槽位内按项目路径分组：
 * 同一项目的卡片相邻，组头带项目名与数量。
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
  /** 日刻度的列头用「日期数字 + 星期」两级排版，其他刻度只显示周期标签。 */
  const dayNumber = scale === 'day' ? bucket.shortLabel : null
  const weekdayDate = scale === 'day' ? dayKeyToDate(bucket.startDay) : null
  const weekday = weekdayDate ? WEEKDAY_LABELS[weekdayDate.getDay()] : null
  const headerContent = dayNumber ? (
    <>
      <span className="text-[13px] font-semibold tabular-nums">
        {dayNumber}
      </span>
      {weekday && (
        <span className="text-[10px] font-normal opacity-70">{weekday}</span>
      )}
    </>
  ) : (
    <span className="truncate text-[12px] font-semibold">{bucket.label}</span>
  )

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
          'group/col',
          calendarColumn,
          isToday && 'bg-accent-soft/25'
        )}
      >
        <div
          className={cn(
            calendarHeader,
            isToday ? 'bg-accent-soft text-accent-strong' : 'text-text-muted'
          )}
        >
          {isToday && (
            <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />
          )}
          {headerContent}
        </div>
        {CALENDAR_SLOTS.map((slot) => (
          <div
            key={slot}
            {...slotDragProps(slot)}
            className={cn(
              'flex flex-1 items-center justify-center border-b border-border/60 py-2 text-[10px] last:border-b-0',
              highlighted(slot)
                ? 'bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent/40'
                : 'text-text-muted opacity-0 transition-opacity duration-150 group-hover/col:opacity-60'
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
        calendarColumn,
        isToday && 'bg-accent-soft/25'
      )}
    >
      <header
        className={cn(
          calendarHeader,
          isToday && 'bg-accent-soft text-accent-strong'
        )}
      >
        {isToday && (
          <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />
        )}
        {headerContent}
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
              groupByProject
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

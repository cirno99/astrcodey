import { cn } from '../../lib/utils'
import type { KanbanCard } from '../../services/types'
import { KanbanCardItem, type KanbanCardHandlers } from './KanbanCardItem'

interface KanbanCardListProps {
  cards: KanbanCard[]
  handlers: KanbanCardHandlers
  /** 空列表时的占位提示；省略则不渲染占位（收起态的窄列不需要）。 */
  emptyHint?: string
  className?: string
}

/** 单列、可上下滚动的卡片列表；公共区的每一格与日历手风琴项共用。 */
export function KanbanCardList({
  cards,
  handlers,
  emptyHint,
  className,
}: KanbanCardListProps) {
  if (cards.length === 0) {
    if (!emptyHint) return null
    return (
      <div
        className={cn(
          'rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-text-muted',
          className
        )}
      >
        {emptyHint}
      </div>
    )
  }

  return (
    <div className={cn('space-y-2', className)}>
      {cards.map((card) => (
        <KanbanCardItem key={card.id} card={card} handlers={handlers} />
      ))}
    </div>
  )
}

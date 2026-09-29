import { cn } from '../../lib/utils'
import type { KanbanCard } from '../../services/types'
import { KanbanCardItem, type KanbanCardHandlers } from './KanbanCardItem'
import { groupCardsByProject } from './projectGroups'

interface KanbanCardListProps {
  cards: KanbanCard[]
  handlers: KanbanCardHandlers
  /** 空列表时的占位提示；省略则不渲染占位（收起态的窄列不需要）。 */
  emptyHint?: string
  /** 按项目路径分组渲染；公共区四格不需要分组，保持平铺。 */
  groupByProject?: boolean
  className?: string
}

/** 单列、可上下滚动的卡片列表；公共区的每一格与日历手风琴项共用。 */
export function KanbanCardList({
  cards,
  handlers,
  emptyHint,
  groupByProject,
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

  if (groupByProject) {
    return (
      <div className={cn('space-y-3', className)}>
        {groupCardsByProject(cards).map((group) => (
          <div key={group.workingDir} className="space-y-2">
            <div className="flex items-center gap-1 px-0.5 text-[11px] text-text-muted">
              <span
                className="min-w-0 truncate font-medium text-text-secondary"
                title={group.workingDir}
              >
                {group.name}
              </span>
              <span className="ml-auto shrink-0">{group.cards.length}</span>
            </div>
            {group.cards.map((card) => (
              <KanbanCardItem key={card.id} card={card} handlers={handlers} />
            ))}
          </div>
        ))}
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

import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Icon, IconButton } from '../ui'
import type { KanbanCard } from '../../services/types'
import { groupHeader } from './boardStyles'
import { KanbanCardItem, type KanbanCardHandlers } from './KanbanCardItem'
import { groupCardsByProject, type ProjectCardGroup } from './projectGroups'

interface KanbanCardListProps {
  cards: KanbanCard[]
  handlers: KanbanCardHandlers
  /** 空列表时的占位提示；省略则不渲染占位（收起态的窄列不需要）。 */
  emptyHint?: string
  /** 按项目路径分组渲染；公共区四格不需要分组，保持平铺。 */
  groupByProject?: boolean
  className?: string
}

/**
 * 分组里的一组卡片：组头带项目名、数量、整组删除入口与展开开关。
 *
 * 二次确认内联在组头下方而不是用弹窗：日历列本身就很窄，弹窗会遮住用户正在看的其它组。
 * 确认文案里带上张数——整组删除会连带删掉「已完成」卡片绑定的会话，误触不可恢复。
 *
 * 收起状态只活在这个组自己的实例上，因此按列独立；看板每 5 秒轮询只换卡片对象，
 * 组件身份不变，用户收起的组不会被轮询弹开。默认展开。
 */
function ProjectCardGroupSection({
  group,
  handlers,
}: {
  group: ProjectCardGroup
  handlers: KanbanCardHandlers
}) {
  const [confirming, setConfirming] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="group/section space-y-2">
      <div className={groupHeader}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
        <button
          type="button"
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={group.workingDir}
          onClick={() => setCollapsed((current) => !current)}
        >
          <Icon
            name={collapsed ? 'chevron-right' : 'chevron-down'}
            size={12}
            className="shrink-0 opacity-70"
          />
          <span className="min-w-0 truncate font-medium text-text-secondary">
            {group.name}
          </span>
        </button>
        <span className="shrink-0 tabular-nums">{group.cards.length}</span>
        {!confirming && (
          <IconButton
            icon="trash"
            size={12}
            className="shrink-0 p-0.5 opacity-0 transition-opacity duration-150 group-hover/section:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
            label={`删除 ${group.name} 的全部卡片`}
            disabled={handlers.busy}
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2 rounded-md border border-danger/20 bg-danger-soft px-2 py-1.5 text-[11px]">
          <span className="min-w-0 truncate text-danger">
            删除这 {group.cards.length} 张卡片？
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded-md border border-border bg-surface-soft px-1.5 py-0.5 font-semibold text-text-secondary hover:bg-surface-muted"
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-md border border-danger/20 bg-surface px-1.5 py-0.5 font-semibold text-danger hover:brightness-98"
              onClick={() => {
                setConfirming(false)
                handlers.removeMany(group.cards.map((card) => card.id))
              }}
            >
              删除全部
            </button>
          </div>
        </div>
      )}
      {!collapsed &&
        group.cards.map((card) => (
          <KanbanCardItem key={card.id} card={card} handlers={handlers} />
        ))}
    </div>
  )
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
          'rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-text-muted',
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
          <ProjectCardGroupSection
            key={group.workingDir}
            group={group}
            handlers={handlers}
          />
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

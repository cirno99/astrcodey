import type { DragEvent, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Icon } from '../ui'

interface AccordionSectionProps {
  title: string
  /** 标题右侧的数量角标；省略时不渲染。 */
  count?: number
  expanded: boolean
  onToggle: () => void
  children: ReactNode
  /** 拖拽落点高亮。 */
  highlighted?: boolean
  /** 以下三个回调都提供时，整个菜单项成为拖拽落点；省略则只读。 */
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
}

/**
 * 手风琴菜单项：展开时占满所在列的剩余高度，收起时只留标题条。
 *
 * 展开几项、以及是「两项对半」还是「只留一项」都由调用方决定，本组件只负责展开与收起的样子。
 */
export function AccordionSection({
  title,
  count,
  expanded,
  onToggle,
  children,
  highlighted,
  onDragOver,
  onDragLeave,
  onDrop,
}: AccordionSectionProps) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col',
        expanded ? 'flex-1' : 'shrink-0',
        highlighted && 'ring-1 ring-inset ring-border-strong'
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-left',
          expanded
            ? 'text-text-primary'
            : 'text-text-muted hover:bg-surface-muted'
        )}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className="truncate text-[12px] font-medium">{title}</span>
        {count !== undefined && (
          <span className="ml-auto shrink-0 text-[11px] text-text-muted">
            {count}
          </span>
        )}
      </button>
      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
      )}
    </section>
  )
}

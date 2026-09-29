import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { Icon, IconButton } from '../ui'
import type { KanbanCard, KanbanCardColumn } from '../../services/types'
import { cardDayKey, dayKeyFromIso } from './calendar'
import {
  COLUMN_LABELS,
  USER_WRITABLE_COLUMNS,
  isEditableColumn,
  isRunningColumn,
  opensConversation,
  type CardMove,
} from './columns'

/** 卡片交互回调；由页面实现，日历与公共区共用同一套。 */
export interface KanbanCardHandlers {
  busy: boolean
  /** 默认全部收起，因此只记录被手动展开的卡片；按 id 记录，轮询换掉卡片对象也不会丢失。 */
  expandedCardIds: Set<string>
  draggingCardId: string | null
  toggleExpanded: (cardId: string) => void
  move: (cardId: string, move: CardMove) => void
  remove: (cardId: string) => void
  dragStart: (cardId: string) => void
  dragEnd: () => void
  /** 打开卡片绑定的对话；卡片还没有对话时由页面给出提示。 */
  openConversation: (cardId: string) => void
  /** 打开编辑弹窗；只有待办列会触发。 */
  edit: (cardId: string) => void
}

interface KanbanCardItemProps {
  card: KanbanCard
  handlers: KanbanCardHandlers
}

/**
 * 可折叠的长文本，卡片正文与执行说明共用。
 *
 * 折叠态固定高度，只有实际溢出的文本才提供展开入口——短文本不该挂一个点了没反应的按钮。
 * 用测量而不是字符数阈值：中英文混排下字符数反映不出真实高度。
 * 展开态不测量——此时 `scrollHeight` 等于 `clientHeight`，会把「有溢出」误判成「无溢出」。
 * 排版交给调用方，本组件只管折叠行为。
 */
function CollapsibleText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const textRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    if (expanded) return
    const node = textRef.current
    if (!node) return
    setOverflowing(node.scrollHeight > node.clientHeight + 1)
  }, [expanded, text])

  return (
    <>
      <p
        ref={textRef}
        className={cn(
          className,
          expanded
            ? 'max-h-[40vh] overflow-y-auto'
            : 'max-h-[54px] overflow-hidden'
        )}
      >
        {text}
      </p>
      {overflowing && (
        <button
          type="button"
          className="mt-1 flex items-center gap-0.5 text-[11px] text-text-muted hover:text-text-secondary"
          onClick={() => setExpanded((current) => !current)}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  )
}

/** 单张需求卡片：正面是标题、归属日与展开开关，展开后是执行信息与操作。 */
export function KanbanCardItem({ card, handlers }: KanbanCardItemProps) {
  const collapsed = !handlers.expandedCardIds.has(card.id)
  const running = isRunningColumn(card.column)
  const clickable = opensConversation(card.column)
  const editable = isEditableColumn(card.column)
  const dateLabel = cardDayKey(card)
  // 归属日被拖拽改写后，卡片正面显示的就是归属日而不是创建日，这里补回创建日。
  const createdDay = dayKeyFromIso(card.createdAt)

  return (
    <article
      className={cn(
        'rounded-md border border-border bg-panel-bg px-3 py-2.5',
        clickable
          ? 'cursor-pointer'
          : !handlers.busy && !running && 'cursor-grab active:cursor-grabbing',
        handlers.draggingCardId === card.id && 'opacity-60'
      )}
      draggable={!handlers.busy && !running}
      onClick={(event) => {
        if (!clickable) return
        // 卡片自身的控件（展开箭头、下拉框、编辑/删除、正文「展开」）不该触发跳转。
        if (
          event.target instanceof Element &&
          event.target.closest('button, select, input, textarea')
        ) {
          return
        }
        handlers.openConversation(card.id)
      }}
      onDragStart={(event) => {
        handlers.dragStart(card.id)
        event.dataTransfer.effectAllowed = 'move'
        // 部分 webview 不 setData 就不启动拖拽。
        event.dataTransfer.setData('text/plain', card.id)
      }}
      onDragEnd={handlers.dragEnd}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">
          {card.title}
        </div>
        {dateLabel && (
          <span className="mt-0.5 shrink-0 text-[11px] text-text-muted">
            {dateLabel}
          </span>
        )}
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-down'}
          label={collapsed ? '展开卡片' : '收起卡片'}
          size={14}
          className="-mr-1 -mt-0.5 p-0.5"
          onClick={() => handlers.toggleExpanded(card.id)}
        />
      </div>
      {card.body.trim() && (
        <CollapsibleText
          text={card.body}
          className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary"
        />
      )}
      {!collapsed && (
        <>
          <div className="mt-2 truncate text-[11px] text-text-muted">
            {card.workingDir}
          </div>
          {createdDay && createdDay !== dateLabel && (
            <div className="mt-0.5 text-[11px] text-text-muted">
              创建于 {createdDay}
            </div>
          )}
          {card.attempt > 0 && (
            <div className="mt-0.5 text-[11px] text-text-muted">
              第 {card.attempt} 次尝试
            </div>
          )}
          {card.note && (
            <CollapsibleText
              text={card.note}
              className={cn(
                'mt-1 text-[11px]',
                card.column === 'blocked' ? 'text-danger' : 'text-text-muted'
              )}
            />
          )}
          <div className="mt-2 flex items-center gap-2">
            <select
              className="min-w-0 flex-1 rounded-md border border-border bg-panel-bg px-2 py-1 text-[12px] text-text-secondary outline-none disabled:opacity-60"
              value={card.column}
              disabled={handlers.busy || running}
              onChange={(event) =>
                handlers.move(card.id, {
                  column: event.target.value as KanbanCardColumn,
                })
              }
            >
              {USER_WRITABLE_COLUMNS.map((target) => (
                <option key={target} value={target}>
                  {COLUMN_LABELS[target]}
                </option>
              ))}
              {running && (
                <option value={card.column}>
                  {COLUMN_LABELS[card.column]}
                </option>
              )}
            </select>
            {editable && (
              <IconButton
                icon="edit"
                label="编辑卡片"
                disabled={handlers.busy}
                onClick={() => handlers.edit(card.id)}
              />
            )}
            <IconButton
              icon="trash"
              label="删除卡片"
              disabled={handlers.busy || running}
              onClick={() => handlers.remove(card.id)}
            />
          </div>
        </>
      )}
    </article>
  )
}

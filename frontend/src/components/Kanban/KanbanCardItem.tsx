import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { Icon, IconButton } from '../ui'
import type { KanbanCard, KanbanCardColumn } from '../../services/types'
import {
  cardActionButtons,
  cardActionRow,
  cardMetaBadge,
  cardShell,
} from './boardStyles'
import { cardDayKey, dayKeyFromIso, dayKeyToDate } from './calendar'
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
  /** 正在被拖拽的卡片；拖动整组选中时是一组，单张拖拽时是长度为 1 的集合。 */
  draggingCardIds: Set<string>
  /** 多选集合；选中态与「拖一张就是拖一组」都由它决定。 */
  selectedCardIds: Set<string>
  toggleExpanded: (cardId: string) => void
  move: (cardId: string, move: CardMove) => void
  remove: (cardId: string) => void
  /** 整组删除：按项目路径分组的组头用它一次删掉该组全部卡片。 */
  removeMany: (cardIds: string[]) => void
  /** 开始拖拽；传入的是本次要一起移动的全部卡片 id。 */
  dragStart: (cardIds: string[]) => void
  /** 多选修饰键点选：`toggle` 是 Ctrl/Cmd，`range` 是 Shift。 */
  select: (cardId: string, mode: 'toggle' | 'range') => void
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

/**
 * 卡片上的日期标记用 `M/D`。
 *
 * 完整 ISO 串在窄列里会把标题挤没；完整日期留在 `title` 里，悬停可见。
 * 日键无法解析时原样返回，不编造一个日期出来。
 */
function shortDayLabel(dayKey: string): string {
  const date = dayKeyToDate(dayKey)
  if (!date) return dayKey
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 单张需求卡片：正面是标题、归属日与展开开关，展开后是执行信息与操作。 */
export function KanbanCardItem({ card, handlers }: KanbanCardItemProps) {
  const collapsed = !handlers.expandedCardIds.has(card.id)
  const running = isRunningColumn(card.column)
  const clickable = opensConversation(card.column)
  const editable = isEditableColumn(card.column)
  const selected = handlers.selectedCardIds.has(card.id)
  const dateLabel = cardDayKey(card)
  // 归属日被拖拽改写后，卡片正面显示的就是归属日而不是创建日，这里补回创建日。
  const createdDay = dayKeyFromIso(card.createdAt)

  return (
    <article
      data-kanban-card-id={card.id}
      className={cn(
        cardShell,
        card.column === 'blocked' && 'border-danger/30 bg-danger-soft/40',
        selected && 'border-accent ring-1 ring-inset ring-accent/40',
        clickable
          ? 'cursor-pointer'
          : !handlers.busy && !running && 'cursor-grab active:cursor-grabbing',
        handlers.draggingCardIds.has(card.id) && 'opacity-60 shadow-none'
      )}
      draggable={!handlers.busy && !running}
      onClick={(event) => {
        // 卡片自身的控件（展开箭头、下拉框、编辑/删除、正文「展开」）不该触发跳转或改选。
        if (
          event.target instanceof Element &&
          event.target.closest('button, select, input, textarea')
        ) {
          return
        }
        // Ctrl/Cmd 与 Shift 是多选修饰键：此时点卡片只改选中集，不跳转对话。
        if (event.ctrlKey || event.metaKey) {
          handlers.select(card.id, 'toggle')
          return
        }
        if (event.shiftKey) {
          handlers.select(card.id, 'range')
          return
        }
        if (!clickable) return
        handlers.openConversation(card.id)
      }}
      onDragStart={(event) => {
        // 拖动选中集里的一张就是拖整组；否则只拖这一张，选中集保持不变。
        handlers.dragStart(
          selected && handlers.selectedCardIds.size > 1
            ? [...handlers.selectedCardIds]
            : [card.id]
        )
        event.dataTransfer.effectAllowed = 'move'
        // 部分 webview 不 setData 就不启动拖拽。
        event.dataTransfer.setData('text/plain', card.id)
      }}
      onDragEnd={handlers.dragEnd}
    >
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-text-primary">
          {card.title}
        </div>
        {dateLabel && (
          <span className={cn(cardMetaBadge, 'mt-px')} title={dateLabel}>
            {shortDayLabel(dateLabel)}
          </span>
        )}
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-down'}
          label={collapsed ? '展开卡片' : '收起卡片'}
          size={14}
          className="-mr-1 -mt-0.5 shrink-0 p-0.5 opacity-60 transition-opacity group-hover/card:opacity-100"
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
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-muted">
            <span
              className="min-w-0 max-w-full truncate"
              title={card.workingDir}
            >
              {card.workingDir}
            </span>
            {createdDay && createdDay !== dateLabel && (
              <span className="shrink-0" title={createdDay}>
                · 创建于 {shortDayLabel(createdDay)}
              </span>
            )}
            {card.attempt > 0 && (
              <span className="shrink-0 rounded bg-warning-soft px-1 py-px font-medium text-warning">
                第 {card.attempt} 次尝试
              </span>
            )}
          </div>
          {card.note && (
            <CollapsibleText
              text={card.note}
              className={cn(
                'mt-2 rounded-md px-2 py-1.5 text-[11px]',
                card.column === 'blocked'
                  ? 'bg-danger-soft/70 text-danger'
                  : 'bg-surface-muted/60 text-text-secondary'
              )}
            />
          )}
          <div className={cardActionRow}>
            <select
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-text-secondary outline-none transition-colors duration-150 hover:border-border-strong focus:border-border-strong disabled:opacity-60"
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
            <div className={cardActionButtons}>
              {editable && (
                <IconButton
                  icon="edit"
                  label="编辑卡片"
                  size={14}
                  disabled={handlers.busy}
                  onClick={() => handlers.edit(card.id)}
                />
              )}
              <IconButton
                icon="trash"
                label="删除卡片"
                size={14}
                disabled={handlers.busy || running}
                onClick={() => handlers.remove(card.id)}
              />
            </div>
          </div>
        </>
      )}
    </article>
  )
}

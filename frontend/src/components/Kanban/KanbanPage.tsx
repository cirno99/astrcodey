import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/conversation'
import { cn } from '../../lib/utils'
import { Button, Dropdown, Icon, IconButton } from '../ui'
import { PageHeader } from '../layout'
import * as api from '../../services/api'
import {
  KANBAN_CARD_COLUMNS,
  type KanbanCard,
  type KanbanCardColumn,
} from '../../services/types'
import {
  forgetProjectPath,
  mergeProjectPathCandidates,
  readProjectPathHistory,
  rememberProjectPath,
} from './projectPathHistory'

interface KanbanPageProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
}

const COLUMN_LABELS: Record<KanbanCardColumn, string> = {
  backlog: '待办',
  ready: '待领取',
  analyzing: '分析中',
  implementing: '实施中',
  done: '已完成',
  blocked: '已阻塞',
}

const COLUMN_HINTS: Record<KanbanCardColumn, string> = {
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
const USER_WRITABLE_COLUMNS: KanbanCardColumn[] = [
  'backlog',
  'ready',
  'done',
  'blocked',
]

/** 后台自动化会推进卡片，因此看板页需要周期性拉取而不是只加载一次。 */
const BOARD_POLL_INTERVAL_MS = 5000

function isRunning(column: KanbanCardColumn): boolean {
  return column === 'analyzing' || column === 'implementing'
}

/**
 * 卡片日期：RFC3339 时间戳转浏览器本地时区的 `YYYY-MM-DD`。
 *
 * 后端时间戳是 UTC，直接截字符串会让东八区凌晨创建的卡片显示成前一天，因此必须按本地时区换算。
 * 解析失败返回空串，调用方据此不渲染，避免把损坏的时间戳显示成 `NaN-NaN-NaN`。
 */
function formatCardDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

export default function KanbanPage({
  isSidebarOpen,
  onToggleSidebar,
}: KanbanPageProps) {
  const workingDir = useAppStore((s) => s.workingDir)
  const sessions = useAppStore((s) => s.sessions)
  const cards = useAppStore((s) => s.kanbanCards)
  const refreshKanbanBoard = useAppStore((s) => s.refreshKanbanBoard)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftWorkingDir, setDraftWorkingDir] = useState('')
  const [pathHistory, setPathHistory] = useState<string[]>(() =>
    readProjectPathHistory()
  )
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<KanbanCardColumn | null>(null)
  /** 默认全部收起，因此这里只记录被手动展开的卡片；按 id 记录，5 秒轮询换掉卡片对象也不会丢失。 */
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(
    () => new Set()
  )

  useEffect(() => {
    void refreshKanbanBoard()
    const timer = window.setInterval(
      () => void refreshKanbanBoard(),
      BOARD_POLL_INTERVAL_MS
    )
    return () => window.clearInterval(timer)
  }, [refreshKanbanBoard])

  const grouped = useMemo(() => {
    const groups = new Map<KanbanCardColumn, KanbanCard[]>()
    for (const column of KANBAN_CARD_COLUMNS) {
      groups.set(column, [])
    }
    for (const card of cards) {
      groups.get(card.column)?.push(card)
    }
    return groups
  }, [cards])

  const projectPathCandidates = useMemo(
    () =>
      mergeProjectPathCandidates(pathHistory, [
        workingDir,
        ...sessions.map((session) => session.workingDir),
      ]),
    [pathHistory, sessions, workingDir]
  )

  const handleCreate = useCallback(async () => {
    const title = draftTitle.trim()
    const targetDir = draftWorkingDir.trim() || workingDir
    if (!title) {
      setErrorMessage('卡片标题不能为空')
      return
    }
    if (!targetDir) {
      setErrorMessage('需要指定工作目录')
      return
    }
    setBusy(true)
    try {
      await api.createKanbanCard({
        title,
        body: draftBody,
        workingDir: targetDir,
        column: 'backlog',
      })
      setDraftTitle('')
      setPathHistory(rememberProjectPath(targetDir))
      setDraftBody('')
      setComposing(false)
      await refreshKanbanBoard()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [draftBody, draftTitle, draftWorkingDir, refreshKanbanBoard, workingDir])

  const handleForgetPath = useCallback((dir: string) => {
    setPathHistory(forgetProjectPath(dir))
  }, [])

  const handleMove = useCallback(
    async (cardId: string, column: KanbanCardColumn) => {
      setBusy(true)
      try {
        await api.updateKanbanCard(cardId, { column })
        await refreshKanbanBoard()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refreshKanbanBoard]
  )

  const handleDelete = useCallback(
    async (cardId: string) => {
      setBusy(true)
      try {
        await api.deleteKanbanCard(cardId)
        await refreshKanbanBoard()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refreshKanbanBoard]
  )

  /** 拖拽落点：只接受用户可写列，且拖回原列时是空操作。 */
  const handleDrop = useCallback(
    (column: KanbanCardColumn, cardId: string | null) => {
      setDropTarget(null)
      if (!cardId) return
      const card = cards.find((item) => item.id === cardId)
      if (!card || card.column === column) return
      void handleMove(cardId, column)
    },
    [cards, handleMove]
  )

  const allCardsCollapsed = useMemo(
    () =>
      cards.length > 0 && cards.every((card) => !expandedCardIds.has(card.id)),
    [cards, expandedCardIds]
  )

  const toggleCardExpanded = useCallback((cardId: string) => {
    setExpandedCardIds((current) => {
      const next = new Set(current)
      if (next.has(cardId)) {
        next.delete(cardId)
      } else {
        next.add(cardId)
      }
      return next
    })
  }, [])

  const toggleAllCardsCollapsed = useCallback(() => {
    setExpandedCardIds(
      allCardsCollapsed
        ? new Set(cards.map((card) => card.id))
        : new Set<string>()
    )
  }, [allCardsCollapsed, cards])

  const runningCount = cards.filter((card) => isRunning(card.column)).length

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-panel-bg">
      <PageHeader>
        <div className="flex min-w-0 items-center gap-2">
          {!isSidebarOpen && (
            <IconButton
              icon="sidebar"
              label="展开侧边栏"
              onClick={onToggleSidebar}
              className="-ml-1"
            />
          )}
          <Icon name="board" size={18} className="text-text-muted" />
          <span className="truncate text-[14px] font-semibold text-text-primary">
            看板
          </span>
          {runningCount > 0 && (
            <span className="shrink-0 text-[12px] text-text-muted">
              {runningCount} 张执行中
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            className="h-9 px-3 text-[13px]"
            disabled={cards.length === 0}
            onClick={toggleAllCardsCollapsed}
          >
            {allCardsCollapsed ? '全部展开' : '全部收起'}
          </Button>
          <Button
            variant="ghost"
            className="h-9 px-3 text-[13px]"
            onClick={() => void refreshKanbanBoard()}
          >
            刷新
          </Button>
          <Button
            variant="secondary"
            onClick={() => setComposing((current) => !current)}
          >
            {composing ? '取消' : '新建卡片'}
          </Button>
        </div>
      </PageHeader>

      <main className="min-h-0 flex-1 overflow-hidden px-[var(--layout-page-padding-x)] py-6">
        {errorMessage && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {errorMessage}
          </div>
        )}

        {composing && (
          <div className="mb-4 rounded-lg border border-border bg-surface-soft p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <input
                className="rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
                placeholder="标题"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
              <Dropdown
                open={pathMenuOpen && projectPathCandidates.length > 0}
                onClose={() => setPathMenuOpen(false)}
                align="left"
                label="项目路径候选"
                className="max-h-[240px] w-full min-w-full max-w-none overflow-y-auto"
                trigger={
                  <input
                    className="w-full rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
                    placeholder={
                      workingDir ? `默认：${workingDir}` : '项目路径'
                    }
                    value={draftWorkingDir}
                    onChange={(event) => {
                      setDraftWorkingDir(event.target.value)
                      setPathMenuOpen(true)
                    }}
                    onClick={() => setPathMenuOpen(true)}
                    onFocus={() => setPathMenuOpen(true)}
                  />
                }
              >
                {projectPathCandidates.map((dir) => (
                  <div
                    key={dir}
                    className="flex items-center gap-1 rounded-md pl-2 hover:bg-surface-muted"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate py-1 text-left text-[12px] text-text-secondary"
                      title={dir}
                      onClick={() => {
                        setDraftWorkingDir(dir)
                        setPathMenuOpen(false)
                      }}
                    >
                      {dir}
                    </button>
                    {/* 只有历史记录能删：会话推导出的候选删掉也会随会话列表立刻回来。 */}
                    {pathHistory.includes(dir) && (
                      <IconButton
                        icon="trash"
                        size={14}
                        className="p-0.5"
                        label={`从历史中删除 ${dir}`}
                        onClick={() => handleForgetPath(dir)}
                      />
                    )}
                  </div>
                ))}
              </Dropdown>
            </div>
            <textarea
              className="mt-3 h-24 w-full resize-none rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
              placeholder="需求正文"
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
            />
            <div className="mt-3 flex justify-end">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void handleCreate()}
              >
                添加到待办
              </Button>
            </div>
          </div>
        )}

        <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-2">
          {KANBAN_CARD_COLUMNS.map((column) => {
            const columnCards = grouped.get(column) ?? []
            const acceptsDrop = USER_WRITABLE_COLUMNS.includes(column)
            return (
              <section
                key={column}
                className={cn(
                  'flex min-h-0 w-[260px] flex-none flex-col rounded-lg border border-border bg-surface-soft',
                  dropTarget === column && 'ring-1 ring-border-strong'
                )}
                onDragOver={
                  acceptsDrop
                    ? (event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setDropTarget((current) =>
                          current === column ? current : column
                        )
                      }
                    : undefined
                }
                onDragLeave={
                  acceptsDrop
                    ? (event) => {
                        // dragleave 会从子元素冒泡上来，只有真正离开整列才清掉高亮。
                        const nextTarget = event.relatedTarget as Node | null
                        if (event.currentTarget.contains(nextTarget)) return
                        setDropTarget((current) =>
                          current === column ? null : current
                        )
                      }
                    : undefined
                }
                onDrop={
                  acceptsDrop
                    ? (event) => {
                        event.preventDefault()
                        handleDrop(column, draggingCardId)
                      }
                    : undefined
                }
              >
                <header className="shrink-0 border-b border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-text-primary">
                      {COLUMN_LABELS[column]}
                    </span>
                    <span className="text-[12px] text-text-muted">
                      {columnCards.length}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    {COLUMN_HINTS[column]}
                  </div>
                </header>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {columnCards.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-text-muted">
                      暂无卡片
                    </div>
                  ) : (
                    columnCards.map((card) => {
                      const collapsed = !expandedCardIds.has(card.id)
                      const cardDate = formatCardDate(card.createdAt)
                      return (
                        <article
                          key={card.id}
                          className={cn(
                            'rounded-md border border-border bg-panel-bg px-3 py-2.5',
                            !busy &&
                              !isRunning(card.column) &&
                              'cursor-grab active:cursor-grabbing',
                            draggingCardId === card.id && 'opacity-60'
                          )}
                          draggable={!busy && !isRunning(card.column)}
                          onDragStart={(event) => {
                            setDraggingCardId(card.id)
                            event.dataTransfer.effectAllowed = 'move'
                            // 部分 webview 不 setData 就不启动拖拽。
                            event.dataTransfer.setData('text/plain', card.id)
                          }}
                          onDragEnd={() => {
                            setDraggingCardId(null)
                            setDropTarget(null)
                          }}
                        >
                          <div className="flex items-start gap-1">
                            <div className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">
                              {card.title}
                            </div>
                            {cardDate && (
                              <span className="mt-0.5 shrink-0 text-[11px] text-text-muted">
                                {cardDate}
                              </span>
                            )}
                            <IconButton
                              icon={
                                collapsed ? 'chevron-right' : 'chevron-down'
                              }
                              label={collapsed ? '展开卡片' : '收起卡片'}
                              size={14}
                              className="-mr-1 -mt-0.5 p-0.5"
                              onClick={() => toggleCardExpanded(card.id)}
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
                                    card.column === 'blocked'
                                      ? 'text-danger'
                                      : 'text-text-muted'
                                  )}
                                />
                              )}
                              <div className="mt-2 flex items-center gap-2">
                                <select
                                  className="min-w-0 flex-1 rounded-md border border-border bg-panel-bg px-2 py-1 text-[12px] text-text-secondary outline-none disabled:opacity-60"
                                  value={card.column}
                                  disabled={busy || isRunning(card.column)}
                                  onChange={(event) =>
                                    void handleMove(
                                      card.id,
                                      event.target.value as KanbanCardColumn
                                    )
                                  }
                                >
                                  {USER_WRITABLE_COLUMNS.map((target) => (
                                    <option key={target} value={target}>
                                      {COLUMN_LABELS[target]}
                                    </option>
                                  ))}
                                  {isRunning(card.column) && (
                                    <option value={card.column}>
                                      {COLUMN_LABELS[card.column]}
                                    </option>
                                  )}
                                </select>
                                <IconButton
                                  icon="trash"
                                  label="删除卡片"
                                  disabled={busy || isRunning(card.column)}
                                  onClick={() => void handleDelete(card.id)}
                                />
                              </div>
                            </>
                          )}
                        </article>
                      )
                    })
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </main>
    </div>
  )
}

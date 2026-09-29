import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/conversation'
import { cn } from '../../lib/utils'
import { Button, Icon, IconButton } from '../ui'
import { PageHeader } from '../layout'
import * as api from '../../services/api'
import {
  KANBAN_CARD_COLUMNS,
  type KanbanCard,
  type KanbanCardColumn,
} from '../../services/types'

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

export default function KanbanPage({
  isSidebarOpen,
  onToggleSidebar,
}: KanbanPageProps) {
  const workingDir = useAppStore((s) => s.workingDir)
  const cards = useAppStore((s) => s.kanbanCards)
  const refreshKanbanBoard = useAppStore((s) => s.refreshKanbanBoard)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftWorkingDir, setDraftWorkingDir] = useState('')

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
      setDraftBody('')
      setComposing(false)
      await refreshKanbanBoard()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [draftBody, draftTitle, draftWorkingDir, refreshKanbanBoard, workingDir])

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
              <input
                className="rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
                placeholder={workingDir ?? '工作目录'}
                value={draftWorkingDir}
                onChange={(event) => setDraftWorkingDir(event.target.value)}
              />
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
            return (
              <section
                key={column}
                className="flex min-h-0 w-[260px] flex-none flex-col rounded-lg border border-border bg-surface-soft"
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
                    columnCards.map((card) => (
                      <article
                        key={card.id}
                        className="rounded-md border border-border bg-panel-bg px-3 py-2.5"
                      >
                        <div className="text-[13px] font-medium text-text-primary">
                          {card.title}
                        </div>
                        {card.body.trim() && (
                          <p className="mt-1 max-h-[54px] overflow-hidden whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary">
                            {card.body}
                          </p>
                        )}
                        <div className="mt-2 truncate text-[11px] text-text-muted">
                          {card.workingDir}
                        </div>
                        {card.attempt > 0 && (
                          <div className="mt-0.5 text-[11px] text-text-muted">
                            第 {card.attempt} 次尝试
                          </div>
                        )}
                        {card.note && (
                          <div
                            className={cn(
                              'mt-1 text-[11px]',
                              card.column === 'blocked'
                                ? 'text-danger'
                                : 'text-text-muted'
                            )}
                          >
                            {card.note}
                          </div>
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
                      </article>
                    ))
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

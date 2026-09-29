import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
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
import { CalendarBucketColumn } from './CalendarBucketColumn'
import { CreateCardModal } from './CreateCardModal'
import { EditCardModal } from './EditCardModal'
import { KanbanCardList } from './KanbanCardList'
import type { KanbanCardHandlers } from './KanbanCardItem'
import {
  CALENDAR_SCALES,
  CALENDAR_SCALE_LABELS,
  UNSCHEDULED_BUCKET_KEY,
  anchorLabel,
  bucketKeyOf,
  bucketsFor,
  cardDayKey,
  shiftAnchorDayKey,
  todayKey,
  type CalendarBucket,
  type CalendarScale,
} from './calendar'
import {
  COLUMN_HINTS,
  COLUMN_LABELS,
  PUBLIC_AREA_COLUMNS,
  PUBLIC_AREA_DROP_COLUMNS,
  isRunningColumn,
  sameDropTarget,
  type CalendarSlot,
  type CardMove,
  type DropTarget,
} from './columns'

interface KanbanPageProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  /** 跳转到对话视图；点击卡片打开对应会话时需要。 */
  onOpenChat: () => void
}

/** 后台自动化会推进卡片，因此看板页需要周期性拉取而不是只加载一次。 */
const BOARD_POLL_INTERVAL_MS = 5000

/**
 * 归属日未知的卡片（旧数据回填失败）也要有落点。
 *
 * 它们既不在日历的时间轴上，也不属于公共区的任何一格，不额外收纳就会从看板上消失。
 */
const UNSCHEDULED_BUCKET: CalendarBucket = {
  key: UNSCHEDULED_BUCKET_KEY,
  label: '未排期',
  shortLabel: '未排期',
  startDay: '',
  endDay: '',
}

const emptySlots = (): Record<CalendarSlot, KanbanCard[]> => ({
  backlog: [],
  done: [],
})

export default function KanbanPage({
  isSidebarOpen,
  onToggleSidebar,
  onOpenChat,
}: KanbanPageProps) {
  const workingDir = useAppStore((s) => s.workingDir)
  const sessions = useAppStore((s) => s.sessions)
  const cards = useAppStore((s) => s.kanbanCards)
  const refreshKanbanBoard = useAppStore((s) => s.refreshKanbanBoard)
  const deleteSessions = useAppStore((s) => s.deleteSessions)
  const switchSession = useAppStore((s) => s.switchSession)
  const showTransientHint = useAppStore((s) => s.showTransientHint)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  /** 正在编辑的卡片 id；轮询会换掉卡片对象，因此按 id 记录而不是存对象。 */
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  /** 默认全部收起，因此这里只记录被手动展开的卡片；按 id 记录，5 秒轮询换掉卡片对象也不会丢失。 */
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(
    () => new Set()
  )
  const [scale, setScale] = useState<CalendarScale>('day')
  const [anchorDayKey, setAnchorDayKey] = useState(() => todayKey())
  /**
   * 「回到今天」的自增号。
   *
   * 横向滚动不改变锚点，因此「已经停在今天、只是滚到别处」时 setAnchorDayKey
   * 传入同值会被 React 判为无变化，居中 effect 也就不会重跑。这个自增号保证
   * 每次点击都产生一次新的居中请求。
   */
  const [recenterToken, setRecenterToken] = useState(0)
  /** 每个日历列里被点开的手风琴项；`null` 表示还没点过、两项对半显示。 */
  const [preferredSlotByBucket, setPreferredSlotByBucket] = useState<
    Record<string, CalendarSlot | null>
  >({})

  const calendarScrollRef = useRef<HTMLDivElement>(null)
  const centeredRef = useRef<string | null>(null)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    void refreshKanbanBoard()
    const timer = window.setInterval(
      () => void refreshKanbanBoard(),
      BOARD_POLL_INTERVAL_MS
    )
    return () => window.clearInterval(timer)
  }, [refreshKanbanBoard])

  const buckets = useMemo(
    () => bucketsFor(scale, anchorDayKey),
    [scale, anchorDayKey]
  )

  const today = todayKey()

  /**
   * 把今天所在的列滚到视口正中。
   *
   * 只在切换刻度、翻页、点「回到今天」、以及首屏卡片到位后各做一次：卡片决定列的收放宽度，
   * 卡片还没到时所有列都是收起宽度，那时对齐的位置在卡片到位后就不准了。
   * 之后不再跟随卡片变化，否则 5 秒轮询会把用户手动滚动的位置一直拽回来。
   */
  useEffect(() => {
    const container = calendarScrollRef.current
    if (!container) return
    const key = `${scale}:${anchorDayKey}:${recenterToken}`
    const awaitingFirstCards = !layoutReadyRef.current && cards.length > 0
    if (centeredRef.current === key && !awaitingFirstCards) return
    layoutReadyRef.current = cards.length > 0
    const target = container.querySelector<HTMLElement>('[data-today="true"]')
    if (!target) return
    centeredRef.current = key
    container.scrollLeft = Math.max(
      0,
      target.offsetLeft - (container.clientWidth - target.offsetWidth) / 2
    )
  }, [scale, anchorDayKey, recenterToken, cards, buckets])

  const cardsByColumn = useMemo(() => {
    const groups = new Map<KanbanCardColumn, KanbanCard[]>()
    for (const column of KANBAN_CARD_COLUMNS) {
      groups.set(column, [])
    }
    for (const card of cards) {
      groups.get(card.column)?.push(card)
    }
    return groups
  }, [cards])

  /**
   * 日历列的分组。
   *
   * 只有 `backlog` / `done` 两列进日历，其余四列在公共区；
   * 归属日无法确定的卡片归到 `UNSCHEDULED_BUCKET_KEY`，而不是被丢掉。
   */
  const calendarGroups = useMemo(() => {
    const groups = new Map<string, Record<CalendarSlot, KanbanCard[]>>()
    for (const bucket of buckets) {
      groups.set(bucket.key, emptySlots())
    }
    for (const card of cards) {
      if (card.column !== 'backlog' && card.column !== 'done') continue
      const dayKey = cardDayKey(card)
      const key = dayKey ? bucketKeyOf(scale, dayKey) : UNSCHEDULED_BUCKET_KEY
      let slots = groups.get(key)
      if (!slots) {
        slots = emptySlots()
        groups.set(key, slots)
      }
      slots[card.column].push(card)
    }
    return groups
  }, [buckets, cards, scale])

  const unscheduledSlots = calendarGroups.get(UNSCHEDULED_BUCKET_KEY)
  const hasUnscheduled =
    unscheduledSlots !== undefined &&
    unscheduledSlots.backlog.length + unscheduledSlots.done.length > 0

  const sessionWorkingDirs = useMemo(
    () => sessions.map((session) => session.workingDir),
    [sessions]
  )

  const moveCard = useCallback(
    async (cardId: string, move: CardMove) => {
      setBusy(true)
      try {
        await api.updateKanbanCard(cardId, move)
        await refreshKanbanBoard()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refreshKanbanBoard]
  )

  /**
   * 批量删除卡片；单张删除是它长度为 1 的特例。
   *
   * 「已完成」卡片绑定的会话是自动化为它建的，卡片删掉后不再有任何记录指向该会话，
   * 因此一并删除。反方向不成立：删除会话不动卡片——看板数据在扩展的 board.json 里，
   * 与会话存储互不依赖。
   *
   * 会话先删、卡片后删，与单张删除保持同一顺序；卡片逐张发请求，本地扩展路由下并发
   * 代价可忽略，因此不为它新增批量路由。整组删除只有部分成功时，失败的卡片会留在
   * 原处并把错误显示在页面顶部，用户重试即可。
   */
  const handleDeleteMany = useCallback(
    async (cardIds: string[]) => {
      if (cardIds.length === 0) return
      setBusy(true)
      try {
        const sessionIds: string[] = []
        for (const card of cards) {
          if (!cardIds.includes(card.id)) continue
          if (card.column === 'done' && card.sessionId) {
            sessionIds.push(card.sessionId)
          }
        }
        if (sessionIds.length > 0) {
          await deleteSessions(sessionIds)
        }
        const results = await Promise.allSettled(
          cardIds.map((cardId) => api.deleteKanbanCard(cardId))
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          setErrorMessage(
            failure.reason instanceof Error
              ? failure.reason.message
              : String(failure.reason)
          )
        }
        await refreshKanbanBoard()
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [cards, deleteSessions, refreshKanbanBoard]
  )

  /** 单张删除复用同一条路径，避免两处各写一遍「先删会话、再删卡片」的顺序。 */
  const handleDelete = useCallback(
    (cardId: string) => {
      void handleDeleteMany([cardId])
    },
    [handleDeleteMany]
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

  const handleDragEnd = useCallback(() => {
    setDraggingCardId(null)
    setDropTarget(null)
  }, [])

  /** 拖拽落点：只接受用户可写列，且拖回原处时是空操作。 */
  const handleDrop = useCallback(
    (target: DropTarget) => {
      setDropTarget(null)
      const cardId = draggingCardId
      if (!cardId) return
      const card = cards.find((item) => item.id === cardId)
      if (!card) return
      if (target.kind === 'column') {
        if (card.column === target.column) return
        void moveCard(cardId, { column: target.column })
        return
      }
      // 日历落点：列与归属日一起改。只有日刻度会成为落点，桶键本身就是归属日。
      if (card.column === target.slot && card.date === target.bucketKey) return
      void moveCard(cardId, { column: target.slot, date: target.bucketKey })
    },
    [cards, draggingCardId, moveCard]
  )

  /**
   * 打开卡片绑定的对话。
   *
   * 没有 `sessionId` 说明这张卡片从未被自动化领取（例如从待办直接拖进已完成），
   * 此时没有可跳转的对话，给一条提示而不是切进一个空会话。
   * `sessionId` 存在但会话已被删除的情况，由 `switchSession` 自己的错误提示兜底。
   */
  const handleOpenConversation = useCallback(
    (cardId: string) => {
      const card = cards.find((item) => item.id === cardId)
      if (!card?.sessionId) {
        showTransientHint('这张卡片还没有对话')
        return
      }
      onOpenChat()
      void switchSession(card.sessionId)
    },
    [cards, onOpenChat, showTransientHint, switchSession]
  )

  const handlers: KanbanCardHandlers = useMemo(
    () => ({
      busy,
      expandedCardIds,
      draggingCardId,
      toggleExpanded: toggleCardExpanded,
      move: moveCard,
      remove: handleDelete,
      removeMany: handleDeleteMany,
      dragStart: setDraggingCardId,
      dragEnd: handleDragEnd,
      openConversation: handleOpenConversation,
      edit: setEditingCardId,
    }),
    [
      busy,
      draggingCardId,
      expandedCardIds,
      handleDelete,
      handleDeleteMany,
      handleDragEnd,
      handleOpenConversation,
      moveCard,
      toggleCardExpanded,
    ]
  )

  const allCardsCollapsed = useMemo(
    () =>
      cards.length > 0 && cards.every((card) => !expandedCardIds.has(card.id)),
    [cards, expandedCardIds]
  )

  const toggleAllCardsCollapsed = useCallback(() => {
    setExpandedCardIds(
      allCardsCollapsed ? new Set(cards.map((card) => card.id)) : new Set()
    )
  }, [allCardsCollapsed, cards])

  const setPreferredSlot = useCallback(
    (bucketKey: string, slot: CalendarSlot | null) => {
      setPreferredSlotByBucket((current) => ({ ...current, [bucketKey]: slot }))
    },
    []
  )

  /** 日历列的落点回调；只有日刻度的列会真的调用它们（见 `acceptsDrop`）。 */
  const bucketDropHandlers = (bucketKey: string) => ({
    onDragOverSlot: (slot: CalendarSlot) =>
      setDropTarget({ kind: 'bucket', bucketKey, slot }),
    onDragLeaveSlot: () => setDropTarget(null),
    onDropSlot: (slot: CalendarSlot) =>
      handleDrop({ kind: 'bucket', bucketKey, slot }),
  })

  const columnDragProps = (column: KanbanCardColumn) => {
    if (!PUBLIC_AREA_DROP_COLUMNS.includes(column)) return {}
    const target: DropTarget = { kind: 'column', column }
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget((current) =>
          sameDropTarget(current, target) ? current : target
        )
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        // dragleave 会从子元素冒泡上来，只有真正离开整格才清掉高亮。
        const nextTarget = event.relatedTarget as Node | null
        if (event.currentTarget.contains(nextTarget)) return
        setDropTarget((current) =>
          sameDropTarget(current, target) ? null : current
        )
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        handleDrop(target)
      },
    }
  }

  const runningCount = cards.filter((card) =>
    isRunningColumn(card.column)
  ).length

  // 弹窗打开期间卡片可能被自动化领取或删除，因此按 id 现取；取不到就不渲染。
  const editingCard = cards.find((card) => card.id === editingCardId)

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
          <Button variant="secondary" onClick={() => setCreateModalOpen(true)}>
            新建卡片
          </Button>
        </div>
      </PageHeader>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-[var(--layout-page-padding-x)] py-4">
        {errorMessage && (
          <div className="shrink-0 rounded-lg border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {errorMessage}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-5 gap-3">
          <section className="flex min-h-0 flex-col gap-3">
            {PUBLIC_AREA_COLUMNS.map((column) => {
              const columnCards = cardsByColumn.get(column) ?? []
              return (
                <div
                  key={column}
                  {...columnDragProps(column)}
                  className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface-soft',
                    sameDropTarget(dropTarget, { kind: 'column', column }) &&
                      'ring-1 ring-inset ring-border-strong'
                  )}
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
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    <KanbanCardList
                      cards={columnCards}
                      handlers={handlers}
                      emptyHint="暂无卡片"
                    />
                  </div>
                </div>
              )
            })}
          </section>

          <section className="col-span-4 flex min-h-0 flex-col gap-2">
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                icon="chevron-right"
                label="上一页"
                className="rotate-180"
                onClick={() =>
                  setAnchorDayKey((current) =>
                    shiftAnchorDayKey(scale, current, -1)
                  )
                }
              />
              <span className="min-w-[7rem] text-center text-[13px] font-medium text-text-primary">
                {anchorLabel(scale, anchorDayKey)}
              </span>
              <IconButton
                icon="chevron-right"
                label="下一页"
                onClick={() =>
                  setAnchorDayKey((current) =>
                    shiftAnchorDayKey(scale, current, 1)
                  )
                }
              />
              <Button
                variant="ghost"
                className="h-8 px-2 text-[12px]"
                onClick={() => {
                  setAnchorDayKey(today)
                  setRecenterToken((current) => current + 1)
                }}
              >
                回到今天
              </Button>
              <div className="ml-auto flex items-center gap-1">
                {CALENDAR_SCALES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setScale(item)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[12px] transition-colors',
                      item === scale
                        ? 'bg-surface-muted text-text-primary'
                        : 'text-text-muted hover:text-text-secondary'
                    )}
                  >
                    {CALENDAR_SCALE_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={calendarScrollRef}
              className="relative flex min-h-0 flex-1 overflow-x-auto border border-border bg-panel-bg"
            >
              {hasUnscheduled && unscheduledSlots && (
                <CalendarBucketColumn
                  bucket={UNSCHEDULED_BUCKET}
                  scale={scale}
                  cardsBySlot={unscheduledSlots}
                  preferredSlot={
                    preferredSlotByBucket[UNSCHEDULED_BUCKET_KEY] ?? null
                  }
                  onToggleSlot={(next) =>
                    setPreferredSlot(UNSCHEDULED_BUCKET_KEY, next)
                  }
                  handlers={handlers}
                  acceptsDrop={false}
                  dropTarget={dropTarget}
                  {...bucketDropHandlers(UNSCHEDULED_BUCKET_KEY)}
                />
              )}
              {buckets.map((bucket) => (
                <CalendarBucketColumn
                  key={bucket.key}
                  bucket={bucket}
                  scale={scale}
                  cardsBySlot={calendarGroups.get(bucket.key) ?? emptySlots()}
                  preferredSlot={preferredSlotByBucket[bucket.key] ?? null}
                  onToggleSlot={(next) => setPreferredSlot(bucket.key, next)}
                  handlers={handlers}
                  acceptsDrop={scale === 'day'}
                  isToday={bucket.key === bucketKeyOf(scale, today)}
                  dropTarget={dropTarget}
                  {...bucketDropHandlers(bucket.key)}
                />
              ))}
            </div>
          </section>
        </div>
      </main>

      {createModalOpen && (
        <CreateCardModal
          defaultWorkingDir={workingDir ?? ''}
          extraPathCandidates={sessionWorkingDirs}
          defaultDate={today}
          onClose={() => setCreateModalOpen(false)}
          onCreated={refreshKanbanBoard}
        />
      )}

      {editingCard && (
        <EditCardModal
          card={editingCard}
          onClose={() => setEditingCardId(null)}
          onSaved={refreshKanbanBoard}
        />
      )}
    </div>
  )
}

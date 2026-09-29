import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
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
import {
  COLUMN_TONES,
  calendarShell,
  countBadge,
  publicColumnHeader,
  publicColumnShell,
} from './boardStyles'
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
import {
  idsInRect,
  movesForDrop,
  rangeSelection,
  rectFromPoints,
  selectableIds,
  toggleSelection,
  type CardMoveRequest,
  type CardRectEntry,
  type MoveTarget,
  type SelectionRect,
} from './selection'

interface KanbanPageProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  /** 跳转到对话视图；点击卡片打开对应会话时需要。 */
  onOpenChat: () => void
}

/** 后台自动化会推进卡片，因此看板页需要周期性拉取而不是只加载一次。 */
const BOARD_POLL_INTERVAL_MS = 5000

/**
 * 框选忽略的区域。
 *
 * 卡片自己处理按下（原生拖拽与点选），表单控件与链接也不该起框——否则点一次下拉框
 * 就会顺带把选中集清空。
 */
const SELECTION_IGNORE_SELECTOR =
  '[data-kanban-card-id], button, select, input, textarea, a'

/** 按下后位移超过这个距离才算框选，否则只当作一次空白处点击。 */
const BAND_THRESHOLD_PX = 4

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
  /** 正在被拖拽的卡片；拖动整组选中时这里是一组，单张拖拽时是长度为 1 的集合。 */
  const [draggingCardIds, setDraggingCardIds] = useState<Set<string>>(
    () => new Set()
  )
  /** 多选集合；按 id 记录，5 秒轮询换掉卡片对象也不会丢失。 */
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(
    () => new Set()
  )
  /** Shift 区间选中的锚点；`null` 表示还没点选过，此时区间退化为单张。 */
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
    null
  )
  /** 框选矩形，坐标相对看板根节点；`null` 表示当前没有在框选。 */
  const [bandRect, setBandRect] = useState<SelectionRect | null>(null)
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

  /** 看板根节点：框选矩形与卡片命中的坐标都以它为原点。 */
  const boardRef = useRef<HTMLDivElement>(null)
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

  /**
   * 批量移动卡片。
   *
   * 与批量删除同一条思路：逐张发请求，本地扩展路由下并发代价可忽略，因此不为它新增批量
   * 路由；部分失败时成功的卡片已经落盘，失败的留在原处并把错误显示在页面顶部。
   */
  const moveCards = useCallback(
    async (requests: CardMoveRequest[]) => {
      if (requests.length === 0) return
      setBusy(true)
      try {
        const results = await Promise.allSettled(
          requests.map(({ cardId, move }) => api.updateKanbanCard(cardId, move))
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
    [refreshKanbanBoard]
  )

  /** 单张移动复用同一条路径；卡片展开后的列下拉框用它。 */
  const moveCard = useCallback(
    (cardId: string, move: CardMove) => {
      void moveCards([{ cardId, move }])
    },
    [moveCards]
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
    setDraggingCardIds(new Set())
    setDropTarget(null)
  }, [])

  /**
   * 拖拽落点：只接受用户可写列，且拖回原处时是空操作。
   *
   * 拖动的是整组选中卡片，逐张折算成移动请求交给 `movesForDrop`——它会把已经落在目标
   * 位置的、以及中途被自动化领走进入运行中列的卡片滤掉。
   */
  const handleDrop = useCallback(
    (target: DropTarget) => {
      setDropTarget(null)
      if (draggingCardIds.size === 0) return
      const moveTarget: MoveTarget =
        target.kind === 'column'
          ? { column: target.column }
          : { column: target.slot, date: target.bucketKey }
      const requests = movesForDrop(cards, [...draggingCardIds], moveTarget)
      if (requests.length === 0) return
      // 落点已经生效，选中集与锚点都指向移动前的布局，留着只会误导下一次操作。
      setSelectedCardIds(new Set())
      setSelectionAnchorId(null)
      void moveCards(requests)
    },
    [cards, draggingCardIds, moveCards]
  )

  /**
   * 看板根节点下卡片的矩形，顺序即 DOM 顺序，也就是用户在页面上看到的先后。
   *
   * 坐标统一减去看板根节点的位置：框选矩形与卡片命中必须在同一坐标系里比较，而
   * `getBoundingClientRect` 给的是视口坐标。
   */
  const cardRects = useCallback((): CardRectEntry[] => {
    const root = boardRef.current
    if (!root) return []
    const boardRect = root.getBoundingClientRect()
    const entries: CardRectEntry[] = []
    for (const node of root.querySelectorAll<HTMLElement>(
      '[data-kanban-card-id]'
    )) {
      const id = node.dataset.kanbanCardId
      if (!id) continue
      const rect = node.getBoundingClientRect()
      entries.push({
        id,
        rect: {
          left: rect.left - boardRect.left,
          top: rect.top - boardRect.top,
          right: rect.right - boardRect.left,
          bottom: rect.bottom - boardRect.top,
        },
      })
    }
    return entries
  }, [])

  /** Ctrl/Shift 点选；区间以锚点为界，锚点还没建立时退化为单选。 */
  const selectCard = useCallback(
    (cardId: string, mode: 'toggle' | 'range') => {
      if (mode === 'toggle') {
        setSelectedCardIds((current) => toggleSelection(current, cardId))
        setSelectionAnchorId(cardId)
        return
      }
      const orderedIds = cardRects().map((entry) => entry.id)
      setSelectedCardIds(
        rangeSelection(orderedIds, selectionAnchorId ?? cardId, cardId)
      )
    },
    [cardRects, selectionAnchorId]
  )

  /**
   * 框选：从空白处按下拖动，实时选中被矩形框住的卡片。
   *
   * 卡片上的按下不在这里处理——那里留给原生拖拽（多卡拖拽）与点选，两套指针交互各占
   * 一块区域才不会互相抢事件。这里读的是按下那一刻的 `cards` 快照；即使框选途中轮询把
   * 某张卡片推进运行中的列，落点处的 `movesForDrop` 仍会把它滤掉。
   */
  const handleBoardPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest(SELECTION_IGNORE_SELECTOR)
    ) {
      return
    }
    const board = boardRef.current
    if (!board) return
    const boardRect = board.getBoundingClientRect()
    // 阻止浏览器把这次拖动当成选择文字。
    event.preventDefault()
    // 捕获指针：松手落在窗口外、或触摸手势被系统打断时，仍能收到 pointerup / pointercancel。
    board.setPointerCapture(event.pointerId)

    const originX = event.clientX - boardRect.left
    const originY = event.clientY - boardRect.top
    const base =
      event.ctrlKey || event.metaKey || event.shiftKey
        ? new Set(selectedCardIds)
        : new Set<string>()
    let activated = false

    const onPointerMove = (moveEvent: PointerEvent) => {
      const endX = moveEvent.clientX - boardRect.left
      const endY = moveEvent.clientY - boardRect.top
      if (!activated) {
        if (
          Math.abs(endX - originX) < BAND_THRESHOLD_PX &&
          Math.abs(endY - originY) < BAND_THRESHOLD_PX
        ) {
          return
        }
        activated = true
      }
      const rect = rectFromPoints(originX, originY, endX, endY)
      setBandRect(rect)
      const hits = idsInRect(rect, cardRects())
      setSelectedCardIds(selectableIds(cards, new Set([...base, ...hits])))
    }

    const finishBand = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finishBand)
      window.removeEventListener('pointercancel', finishBand)
      if (board.hasPointerCapture(event.pointerId)) {
        board.releasePointerCapture(event.pointerId)
      }
      setBandRect(null)
      // 没有真正拖动就只是一次空白处点击：清掉选中并丢掉锚点。
      if (!activated) {
        setSelectedCardIds(new Set())
        setSelectionAnchorId(null)
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finishBand)
    window.addEventListener('pointercancel', finishBand)
  }

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
      draggingCardIds,
      selectedCardIds,
      toggleExpanded: toggleCardExpanded,
      move: moveCard,
      remove: handleDelete,
      removeMany: handleDeleteMany,
      dragStart: (cardIds: string[]) => setDraggingCardIds(new Set(cardIds)),
      dragEnd: handleDragEnd,
      select: selectCard,
      openConversation: handleOpenConversation,
      edit: setEditingCardId,
    }),
    [
      busy,
      draggingCardIds,
      expandedCardIds,
      handleDelete,
      handleDeleteMany,
      handleDragEnd,
      handleOpenConversation,
      moveCard,
      selectCard,
      selectedCardIds,
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
    <div
      ref={boardRef}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-panel-bg',
        bandRect !== null && 'select-none'
      )}
    >
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
          {cards.length > 0 && (
            <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-secondary">
              {cards.length} 张卡片
            </span>
          )}
          {runningCount > 0 && (
            <span className="shrink-0 rounded-full bg-phase-calling-tool/10 px-2 py-0.5 text-[11px] font-medium text-phase-calling-tool">
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
          <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
            新建卡片
          </Button>
        </div>
      </PageHeader>

      <main
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-[var(--layout-page-padding-x)] py-4"
        onPointerDown={handleBoardPointerDown}
      >
        {errorMessage && (
          <div className="shrink-0 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {errorMessage}
          </div>
        )}

        {cards.length === 0 && !errorMessage && (
          <div className="shrink-0 rounded-xl border border-dashed border-border bg-surface/60 px-4 py-3 text-[12px] text-text-muted">
            还没有卡片。点右上角「新建卡片」写下第一条需求，拖到「待领取」后扩展会自动开始执行。
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
          <section className="flex min-h-0 flex-col gap-3">
            {PUBLIC_AREA_COLUMNS.map((column) => {
              const columnCards = cardsByColumn.get(column) ?? []
              const tone = COLUMN_TONES[column]
              const highlighted = sameDropTarget(dropTarget, {
                kind: 'column',
                column,
              })
              return (
                <div
                  key={column}
                  {...columnDragProps(column)}
                  className={cn(
                    publicColumnShell,
                    tone.border,
                    highlighted && 'ring-2 ring-inset ring-accent/40'
                  )}
                >
                  <header className={cn(publicColumnHeader, tone.header)}>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          tone.dot
                        )}
                      />
                      <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">
                        {COLUMN_LABELS[column]}
                      </span>
                      <span className={cn(countBadge, 'ml-auto')}>
                        {columnCards.length}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">
                      {COLUMN_HINTS[column]}
                    </div>
                  </header>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    <KanbanCardList
                      cards={columnCards}
                      handlers={handlers}
                      groupByProject
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
              <span className="min-w-[7rem] text-center text-[13px] font-semibold text-text-primary">
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
              <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                {CALENDAR_SCALES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setScale(item)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150',
                      item === scale
                        ? 'bg-accent-soft text-accent-strong'
                        : 'text-text-muted hover:bg-surface-muted hover:text-text-secondary'
                    )}
                  >
                    {CALENDAR_SCALE_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>

            <div ref={calendarScrollRef} className={calendarShell}>
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

      {bandRect && (
        <div
          className="pointer-events-none absolute z-40 rounded-sm border border-accent/60 bg-accent-soft/20"
          style={{
            left: bandRect.left,
            top: bandRect.top,
            width: bandRect.right - bandRect.left,
            height: bandRect.bottom - bandRect.top,
          }}
        />
      )}

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

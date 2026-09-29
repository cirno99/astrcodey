import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { ConversationBlock } from '../../services/types'
import { cn } from '../../lib/utils'
import { emptyStateSurface, ghostIconButton } from '../../lib/styles'
import { useAppStore } from '../../store/conversation'
import AssistantRunMessage from './AssistantRunMessage'
import UserMessage from './UserMessage'
import ErrorBlock from './ErrorBlock'
import SystemNote from './SystemNote'
import CompactSummaryCard from './CompactSummaryCard'
import RecapBlock from './RecapBlock'
import {
  buildMessageListItems,
  type MessageListItem,
} from './assistantRunModel'
import { Icon } from '../ui/Icon'

interface MessageListProps {
  blocks: ConversationBlock[]
  sessionId: string | null
  hasOlderHistory: boolean
  historyLoading: boolean
  detachedFromLatest: boolean
  historyPageBlockIds: string[][]
  onLoadOlderHistory: () => Promise<void>
  onReturnToLatest: () => Promise<void>
}

function sameBlockReferences<T>(left: T[] | null, right: T[] | null) {
  if (left === right) return true
  return (
    left != null &&
    right != null &&
    left.length === right.length &&
    left.every((block, index) => block === right[index])
  )
}

function sameRenderedItem(left: MessageListItem, right: MessageListItem) {
  if (left.type !== right.type || left.id !== right.id) return false
  if (left.type === 'forkRow') return true
  if (left.type === 'block' && right.type === 'block') {
    return left.block === right.block
  }
  if (left.type !== 'assistantRun' || right.type !== 'assistantRun') {
    return false
  }
  return (
    sameBlockReferences(left.blocks, right.blocks) &&
    sameBlockReferences(left.actionBlocks, right.actionBlocks)
  )
}

function ForkRow({ sessionId }: { sessionId: string | null }) {
  const forkSession = useAppStore((s) => s.forkSession)
  if (!sessionId) return null
  return (
    <div className="flex items-center py-1">
      <button
        type="button"
        className={cn(
          ghostIconButton,
          'h-7 gap-1.5 rounded-md px-2 text-[12px] font-medium'
        )}
        onClick={() => void forkSession(sessionId)}
        aria-label="分叉当前会话"
      >
        <Icon name="branch" size={13} />
        分叉当前会话
      </button>
    </div>
  )
}

const BlockRenderer = memo(
  function BlockRenderer({
    item,
    sessionId,
    animateEntry,
  }: {
    item: MessageListItem
    sessionId: string | null
    animateEntry: boolean
  }) {
    return (
      <div className="mx-auto w-[min(100%,var(--layout-content-max-width))] min-w-0 px-[var(--layout-content-inset-x)]">
        {item.type === 'assistantRun' ? (
          <AssistantRunMessage
            blocks={item.blocks}
            actionBlocks={item.actionBlocks}
            sessionId={sessionId}
            animateEntry={animateEntry}
          />
        ) : item.type === 'forkRow' ? (
          <ForkRow sessionId={sessionId} />
        ) : item.block.kind === 'user' ? (
          <UserMessage block={item.block} />
        ) : item.block.kind === 'error' ? (
          <ErrorBlock block={item.block} />
        ) : item.block.kind === 'systemNote' ? (
          <SystemNote block={item.block} />
        ) : item.block.kind === 'compactSummary' ? (
          <CompactSummaryCard block={item.block} />
        ) : item.block.kind === 'recap' ? (
          <RecapBlock block={item.block} />
        ) : null}
      </div>
    )
  },
  (previous, next) =>
    previous.sessionId === next.sessionId &&
    previous.animateEntry === next.animateEntry &&
    sameRenderedItem(previous.item, next.item)
)

const BLOCK_GAP_PX = 22
const SCROLL_END_THRESHOLD_PX = 96
const LOAD_OLDER_THRESHOLD_PX = 120
/** fadeSlideUp 时长 320ms；多留余量，动画结束后再清除「新条目」标记。 */
const ENTRY_ANIMATION_MS = 400

export default function MessageList({
  blocks,
  sessionId,
  hasOlderHistory,
  historyLoading,
  detachedFromLatest,
  historyPageBlockIds,
  onLoadOlderHistory,
  onReturnToLatest,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const positionedSessionRef = useRef<string | null>(null)
  const previousScrollTopRef = useRef<number | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const assistantRunBreaks = useMemo(
    () =>
      new Set(
        historyPageBlockIds
          .map((pageBlockIds) => pageBlockIds[0])
          .filter((blockId): blockId is string => blockId != null)
      ),
    [historyPageBlockIds]
  )
  const allItems = useMemo(
    () => buildMessageListItems(blocks, assistantRunBreaks),
    [assistantRunBreaks, blocks]
  )
  const previousItemIdsRef = useRef<readonly string[] | null>(null)
  const trackedSessionRef = useRef(sessionId)
  const [freshItemIds, setFreshItemIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  // 入场动画只对「追加到末尾」的条目播放：虚拟化会在滚动时卸载并重挂载行，
  // 若把动画绑在挂载上，回滚历史时旧消息会反复淡入。前插（加载更早历史）同样不播放。
  useLayoutEffect(() => {
    const sessionChanged = trackedSessionRef.current !== sessionId
    trackedSessionRef.current = sessionId
    const previousIds = sessionChanged ? null : previousItemIdsRef.current

    // 流式更新每帧都会重跑本效果，且条目数与末尾 id 均未变；此时尾部扫描必然
    // 得不到新条目，直接跳过以避免每帧重建 id 数组（长会话下是 O(n) 分配）。
    if (
      previousIds !== null &&
      previousIds.length === allItems.length &&
      previousIds[previousIds.length - 1] === allItems[allItems.length - 1]?.id
    ) {
      return
    }

    const currentIds = allItems.map((item) => item.id)
    previousItemIdsRef.current = currentIds
    if (previousIds === null) return

    const previous = new Set(previousIds)
    const added: string[] = []
    for (let index = currentIds.length - 1; index >= 0; index -= 1) {
      if (previous.has(currentIds[index])) break
      added.push(currentIds[index])
    }
    if (added.length === 0) return

    setFreshItemIds(new Set(added))
    const timer = window.setTimeout(() => {
      setFreshItemIds((current) => (current.size === 0 ? current : new Set()))
    }, ENTRY_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [allItems, sessionId])
  const getItemKey = useCallback(
    (index: number) => allItems[index]?.id ?? index,
    [allItems]
  )
  const handleVirtualizerChange = useCallback(
    (virtualizer: Virtualizer<HTMLDivElement, Element>) => {
      const visible = !virtualizer.isAtEnd()
      setShowJumpToLatest((current) =>
        current === visible ? current : visible
      )
    },
    []
  )

  // TanStack Virtual owns a mutable measurement instance by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: allItems.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 280,
    getItemKey,
    gap: BLOCK_GAP_PX,
    overscan: 2,
    paddingStart: 28,
    paddingEnd: 32,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
    // Resize observations can arrive during a React commit; avoid nesting a synchronous commit.
    useFlushSync: false,
    onChange: handleVirtualizerChange,
  })

  useLayoutEffect(() => {
    if (!sessionId) {
      positionedSessionRef.current = null
      previousScrollTopRef.current = null
      return
    }
    if (allItems.length === 0 || positionedSessionRef.current === sessionId) {
      return
    }

    previousScrollTopRef.current = null
    let settleFrame: number | undefined
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToEnd({ behavior: 'instant' })
      settleFrame = requestAnimationFrame(() => {
        virtualizer.scrollToEnd({ behavior: 'instant' })
        settleFrame = requestAnimationFrame(() => {
          positionedSessionRef.current = sessionId
          previousScrollTopRef.current = listRef.current?.scrollTop ?? null
        })
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (settleFrame != null) cancelAnimationFrame(settleFrame)
    }
  }, [allItems.length, sessionId, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const handleScroll = useCallback(() => {
    const element = listRef.current
    const previousScrollTop = previousScrollTopRef.current
    previousScrollTopRef.current = element?.scrollTop ?? null
    if (
      !element ||
      positionedSessionRef.current !== sessionId ||
      previousScrollTop == null ||
      element.scrollTop >= previousScrollTop ||
      element.scrollTop > LOAD_OLDER_THRESHOLD_PX ||
      !hasOlderHistory ||
      historyLoading
    ) {
      return
    }
    void onLoadOlderHistory()
  }, [hasOlderHistory, historyLoading, onLoadOlderHistory, sessionId])

  const handleJumpToLatest = useCallback(() => {
    if (!detachedFromLatest) {
      virtualizer.scrollToEnd({ behavior: 'smooth' })
      return
    }
    void onReturnToLatest().then(() => {
      requestAnimationFrame(() => {
        virtualizer.scrollToEnd({ behavior: 'instant' })
      })
    })
  }, [detachedFromLatest, onReturnToLatest, virtualizer])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={listRef}
        data-testid="conversation-scroll"
        onScroll={handleScroll}
        className="h-full w-full overflow-x-hidden overflow-y-auto overscroll-contain bg-panel-bg px-[var(--layout-page-padding-x)]"
      >
        {blocks.length === 0 && (
          <div
            className={cn(
              emptyStateSurface,
              'mx-auto mt-[90px] w-[min(100%,var(--layout-content-max-width))]'
            )}
          >
            {sessionId ? (
              <>
                <p className="mb-1 text-[15px] font-medium text-text-primary">
                  向 AstrCode 提问，开始对话
                </p>
                <p className="text-[13px] text-text-muted">
                  输入问题，或使用 / 查看可用命令
                </p>
              </>
            ) : (
              '选择或创建一个会话'
            )}
          </div>
        )}

        {blocks.length > 0 && (
          <div
            className="relative w-full"
            style={{
              height: virtualizer.getTotalSize(),
              overflowAnchor: 'none',
            }}
          >
            {historyLoading && (
              <div className="absolute left-0 top-1 z-10 w-full text-center text-[12px] text-text-muted">
                正在加载更早历史…
              </div>
            )}
            {virtualItems.map((virtualItem) => {
              const item = allItems[virtualItem.index]
              if (!item) return null
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  data-message-item-id={item.id}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <BlockRenderer
                    item={item}
                    sessionId={sessionId}
                    animateEntry={freshItemIds.has(item.id)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {(showJumpToLatest || detachedFromLatest) && blocks.length > 0 && (
        <button
          type="button"
          className="absolute bottom-4 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-[12px] font-medium text-text-secondary shadow-surface-lg backdrop-blur transition-colors hover:bg-surface-muted hover:text-text-primary"
          onClick={handleJumpToLatest}
          aria-label="跳到最新消息"
        >
          <Icon name="chevron-down" size={14} />
          回到最新
        </button>
      )}
    </div>
  )
}

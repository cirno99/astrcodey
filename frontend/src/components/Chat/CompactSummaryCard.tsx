import { memo, useState } from 'react'
import type { ConversationBlock } from '../../services/types'
import { cn } from '../../lib/utils'
import { pillNeutral } from '../../lib/styles'
import { Icon } from '../ui/Icon'

interface CompactSummaryCardProps {
  block: Extract<ConversationBlock, { kind: 'compactSummary' }>
}

function CompactSummaryCard({ block }: CompactSummaryCardProps) {
  const [expanded, setExpanded] = useState(false)
  const lines = block.summary.split('\n')
  const previewLines = lines.slice(0, 3)
  const hasMore = lines.length > 3
  const ratio =
    block.preTokens > 0
      ? Math.round((block.postTokens / block.preTokens) * 100)
      : 0

  return (
    <div className="rounded-[18px] border border-border bg-surface-soft px-5 py-4 shadow-soft">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name="compact" size={16} className="shrink-0 text-text-muted" />
        <span className="font-medium text-text-primary">对话已压缩</span>
        <span className={pillNeutral}>{block.trigger}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
          {block.preTokens.toLocaleString()} &rarr;{' '}
          {block.postTokens.toLocaleString()} tokens{' '}
          <span className="text-text-secondary">({ratio}%)</span>
        </span>
      </div>

      <div
        className={cn(
          'mt-3 cursor-pointer whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary',
          !expanded && hasMore && 'line-clamp-3'
        )}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? block.summary : previewLines.join('\n')}
      </div>

      {hasMore && (
        <button
          className="mt-2 text-[12px] text-text-muted hover:text-text-secondary"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}

      {block.transcriptPath && (
        <div className="mt-2 truncate font-mono text-[11px] text-text-muted">
          {block.transcriptPath}
        </div>
      )}
    </div>
  )
}

export default memo(CompactSummaryCard)

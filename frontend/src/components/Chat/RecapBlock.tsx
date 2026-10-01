import { memo } from 'react'
import type { ConversationBlock } from '../../services/types'
import { MarkdownContent } from './MarkdownContent'
import { pillNeutral } from '../../lib/styles'
import { Icon } from '../ui/Icon'

interface RecapBlockProps {
  block: Extract<ConversationBlock, { kind: 'recap' }>
}

function sourceLabel(source: string): string {
  return source === 'manual' ? '手动回顾' : `回顾 · ${source}`
}

function RecapBlock({ block }: RecapBlockProps) {
  return (
    <div className="rounded-[18px] border border-border bg-surface-soft px-5 py-4 shadow-soft">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name="recap" size={16} className="shrink-0 text-accent" />
        <span className="font-medium text-text-primary">会话回顾</span>
        <span className={pillNeutral}>{sourceLabel(block.source)}</span>
      </div>

      <div className="mt-3 min-w-0 text-[13.5px] leading-relaxed text-text-secondary">
        <MarkdownContent text={block.text} />
      </div>
    </div>
  )
}

export default memo(RecapBlock)

import React from 'react'
import type { ConversationBlock } from '../../services/types'
import { MarkdownContent, StreamingMarkdown } from './MarkdownContent'
import { Icon } from '../ui/Icon'
import {
  cachedThinkingExtraction,
  extractThinkingBlocks,
} from './thinkingExtraction'

interface AssistantMessageProps {
  block: Extract<ConversationBlock, { kind: 'assistant' }>
  reasoningText?: string | null
  showThinking?: boolean
}

export function AssistantMessageContent({
  block,
  reasoningText,
  showThinking = true,
}: AssistantMessageProps) {
  const streaming = block.status === 'streaming'
  const streamingParts =
    streaming && !reasoningText
      ? cachedThinkingExtraction(block.id, block.text)
      : null
  const staticParts = React.useMemo(() => {
    if (reasoningText || streaming) return null
    return extractThinkingBlocks(block.text)
  }, [block.text, reasoningText, streaming])
  const assistantParts = reasoningText
    ? { visibleText: block.text, thinkingBlocks: [reasoningText] }
    : (streamingParts ?? staticParts ?? { visibleText: '', thinkingBlocks: [] })

  return (
    <div className="relative min-w-0 max-w-full wrap-anywhere bg-transparent py-2 text-text-primary prose-chat">
      {showThinking &&
        assistantParts.thinkingBlocks.map((thinkingBlock, index) => (
          <details
            key={`thinking-${index}`}
            className="mb-3.5 bg-transparent border-none rounded-none overflow-visible group"
            open={streaming}
          >
            <summary className="inline-flex items-center gap-2 py-1 min-h-[24px] cursor-pointer select-none bg-transparent border-none rounded-none text-text-secondary/80 transition-opacity duration-150 ease-out text-[13px] font-medium list-none [&::-webkit-details-marker]:hidden hover:opacity-100">
              <span className="w-4 h-4 inline-flex items-center justify-center shrink-0 text-[13px] text-text-secondary/70">
                <Icon name="brain" size={15} />
              </span>
              <span className="font-outfit font-semibold tracking-wide text-text-secondary/75">
                Thinking
              </span>
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-secondary opacity-50 transition-transform duration-150 ease-out group-open:rotate-90">
                <Icon name="chevron-right" size={13} />
              </span>
            </summary>
            <div className="mb-3 ml-2 mt-2 border-l-2 border-border pl-4 wrap-anywhere text-[13.5px] leading-relaxed text-text-secondary/80 prose-chat">
              {streaming ? (
                <StreamingMarkdown
                  text={thinkingBlock}
                  cacheKey={`${block.id}:thinking:${index}`}
                />
              ) : (
                <MarkdownContent text={thinkingBlock} />
              )}
            </div>
          </details>
        ))}
      {streaming ? (
        assistantParts.visibleText ? (
          <StreamingMarkdown
            text={assistantParts.visibleText}
            cacheKey={`${block.id}:visible`}
          />
        ) : null
      ) : assistantParts.visibleText ? (
        <MarkdownContent text={assistantParts.visibleText} />
      ) : null}
    </div>
  )
}

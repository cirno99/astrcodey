import type { ConversationMetrics } from '../../services/types'

/** token 数按量级缩写，避免状态行被长数字撑开；精确值放在 tooltip 里。 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toLocaleString()
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

interface ConversationMetricsBarProps {
  metrics: ConversationMetrics
}

/**
 * 会话用量行：最近一次请求的输入、输出与缓存命中率，以及上下文占用与当前轮生成速度。
 *
 * 用量读数统一取最近一次模型请求，与 provider 账单同口径：每轮 step 都会重发整段历史，
 * 累计 prompt 会随请求数线性膨胀，累计输出也不对应账单里的任何一行，直接展示会与账单对不上。
 * 累计值只放在 tooltip 里。没有样本的指标（尚无请求、上下文身份刚变化、缺少计时锚点）不渲染，
 * 避免出现误导性的 0。
 */
export default function ConversationMetricsBar({
  metrics,
}: ConversationMetricsBarProps) {
  const {
    requests,
    promptTokens,
    cachedTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningOutputTokens,
    lastPromptTokens,
    lastCachedTokens,
    lastOutputTokens,
    lastReasoningOutputTokens,
    contextTokens,
    modelContextWindow,
    outputTokensPerSecond,
  } = metrics

  // 在守卫内构造展示值：`title` 需要原始 token 数，直接引用会在 JSX 里失去收窄。
  const lastRequest =
    lastPromptTokens != null && lastPromptTokens > 0
      ? {
          prompt: lastPromptTokens,
          cached: lastCachedTokens ?? 0,
          hitRate: (lastCachedTokens ?? 0) / lastPromptTokens,
        }
      : null
  const lastOutput = lastOutputTokens ?? null
  const lastReasoning = lastReasoningOutputTokens ?? null
  const cumulativeHitRate =
    promptTokens > 0 ? cachedTokens / promptTokens : null

  const context =
    contextTokens != null && modelContextWindow
      ? {
          ratio: contextTokens / modelContextWindow,
          title: `上下文 ${contextTokens.toLocaleString()} / ${modelContextWindow.toLocaleString()} tokens`,
        }
      : null

  return (
    <div
      className="flex w-full flex-wrap items-center gap-x-5 gap-y-1"
      title={`请求 ${requests.toLocaleString()} 次 · 缓存写入 ${cacheCreationTokens.toLocaleString()} tokens · 推理 ${reasoningOutputTokens.toLocaleString()} tokens`}
    >
      {lastRequest && (
        <span
          title={`最近一次请求输入 ${lastRequest.prompt.toLocaleString()} tokens · 本会话累计非缓存输入 ${(promptTokens - cachedTokens).toLocaleString()} tokens`}
        >
          输入 {formatTokens(lastRequest.prompt)}
        </span>
      )}

      {lastOutput != null && (
        <span
          title={`最近一次请求输出 ${lastOutput.toLocaleString()} tokens${lastReasoning != null ? ` · 其中推理 ${lastReasoning.toLocaleString()} tokens` : ''} · 本会话累计输出 ${outputTokens.toLocaleString()} tokens`}
        >
          输出 {formatTokens(lastOutput)}
        </span>
      )}
      {lastRequest && (
        <span
          title={`最近一次请求命中 ${lastRequest.cached.toLocaleString()} / ${lastRequest.prompt.toLocaleString()} tokens · 本会话累计命中率 ${cumulativeHitRate != null ? formatPercent(cumulativeHitRate) : 'n/a'}`}
        >
          缓存 {formatPercent(lastRequest.hitRate)}
        </span>
      )}

      {context && (
        <span title={context.title}>上下文 {formatPercent(context.ratio)}</span>
      )}
      {outputTokensPerSecond != null && (
        <span title="按最近一轮的模型请求时长估算，不含工具执行时间">
          速度 {outputTokensPerSecond.toFixed(1)} tok/s
        </span>
      )}
    </div>
  )
}

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
 * 会话累计用量行：累计输入/输出、缓存命中率、上下文占用与当前轮生成速度。
 *
 * 数值全部来自 `metricsUpdated` 携带的绝对累计值，本组件只负责展示；没有样本的指标
 * （命中率分母为 0、上下文身份刚变化、缺少计时锚点）不渲染，避免出现误导性的 0。
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
    contextTokens,
    modelContextWindow,
    outputTokensPerSecond,
  } = metrics

  const hitRate = promptTokens > 0 ? cachedTokens / promptTokens : null
  // 在守卫内构造展示值：`title` 需要原始 token 数，直接引用会在 JSX 里失去收窄。
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
      <span title={`累计输入 ${promptTokens.toLocaleString()} tokens`}>
        输入 {formatTokens(promptTokens)}
      </span>
      <span title={`累计输出 ${outputTokens.toLocaleString()} tokens`}>
        输出 {formatTokens(outputTokens)}
      </span>
      {hitRate != null && (
        <span
          title={`缓存命中 ${cachedTokens.toLocaleString()} / ${promptTokens.toLocaleString()} tokens`}
        >
          缓存 {formatPercent(hitRate)}
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

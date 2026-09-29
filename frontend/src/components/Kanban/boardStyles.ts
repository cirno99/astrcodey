/**
 * 看板的视觉基元。
 *
 * 页面、卡片、日历列与手风琴四处必须共用同一套几何与状态色，否则同一页会长出两套
 * 语言（左边圆角卡片、右边直角表格），因此集中在这里而不是各文件内联。
 *
 * 颜色一律取 `index.css` 里已有的 token，不新增全局变量。
 */

import type { KanbanCardColumn } from '../../services/types'

/** 一列的状态色：圆点、列头淡底、容器描边。 */
interface ColumnTone {
  dot: string
  header: string
  border: string
}

export const COLUMN_TONES: Record<KanbanCardColumn, ColumnTone> = {
  backlog: {
    dot: 'bg-text-muted',
    header: '',
    border: 'border-border',
  },
  ready: {
    dot: 'bg-accent',
    header: 'bg-accent-soft/60',
    border: 'border-accent/25',
  },
  analyzing: {
    dot: 'bg-phase-calling-tool',
    header: 'bg-phase-calling-tool/10',
    border: 'border-phase-calling-tool/25',
  },
  implementing: {
    dot: 'bg-phase-streaming',
    header: 'bg-phase-streaming/10',
    border: 'border-phase-streaming/25',
  },
  done: {
    dot: 'bg-success',
    header: 'bg-success-soft/70',
    border: 'border-success/25',
  },
  blocked: {
    dot: 'bg-danger',
    header: 'bg-danger-soft/70',
    border: 'border-danger/25',
  },
}

/** 公共区的一格：卡片浮在浅色底上，靠阴影而不是色差分层。 */
export const publicColumnShell =
  'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-surface-soft shadow-soft transition-[border-color,box-shadow] duration-150'
export const publicColumnHeader = 'shrink-0 border-b border-border px-3 py-2.5'
/** 列头右侧的数量角标。 */
export const countBadge =
  'shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-text-secondary'

/** 一张卡片。选中与拖拽态由调用方叠加。 */
export const cardShell =
  'group/card relative rounded-xl border border-border bg-surface px-3 py-2.5 shadow-soft transition-[border-color,box-shadow,opacity] duration-150 hover:border-border-strong'
/** 卡片上的日期、次数等小标记。 */
export const cardMetaBadge =
  'shrink-0 rounded bg-surface-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-text-secondary'
/** 卡片展开区的操作行；按钮默认隐身，悬停或键盘聚焦时显形。 */
export const cardActionRow =
  'mt-2 flex items-center gap-1.5 border-t border-border/70 pt-2'
export const cardActionButtons =
  'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 focus-within:opacity-100 max-md:opacity-100'

/** 日历的外壳：圆角容器，列与列之间只留一条分隔线。 */
export const calendarShell =
  'relative flex min-h-0 flex-1 overflow-x-auto rounded-xl border border-border bg-surface-soft'
/** 日历里的一列；直角、无间隙，靠分隔线连成一张表。 */
export const calendarColumn =
  'flex flex-none flex-col overflow-hidden border-r border-border/70 bg-surface-soft last:border-r-0'
/** 表头是整张表的第一行，空列与非空列必须同高，横线才连得起来。 */
export const calendarHeader =
  'relative flex h-10 shrink-0 items-center justify-center gap-1.5 border-b border-border px-2 text-text-primary'

/** 按项目分组的组头。 */
export const groupHeader =
  'flex items-center gap-1.5 rounded-md bg-surface-muted/70 px-1.5 py-1 text-[11px] text-text-muted'

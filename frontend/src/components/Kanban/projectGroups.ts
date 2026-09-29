/**
 * 看板卡片按项目路径分组。
 *
 * 只做纯数据整理，不碰 React 与 DOM，因此可以直接在 node 下跑测试。
 * 日历列里的「待办」与「已完成」各自成槽，同一槽位内同项目的卡片必须相邻；
 * 组间顺序取首次出现顺序——后端按插入顺序返回卡片，这样分组不会随 5 秒轮询跳动。
 */

import type { KanbanCard } from '../../services/types'

/** 卡片没有工作目录时使用的组键；这类卡片不能因为分组而消失。 */
export const UNSPECIFIED_PROJECT_DIR = ''

/** 组键没有工作目录时显示的名字。 */
export const UNSPECIFIED_PROJECT_LABEL = '未指定项目'

export interface ProjectCardGroup {
  /** 组键：卡片上原始的 `workingDir`（已 trim）。 */
  workingDir: string
  /** 组头显示的项目名。 */
  name: string
  cards: KanbanCard[]
}

/** 项目路径的显示名：取最后一段；只有分隔符或为空时回落原文。 */
export function projectNameFromDir(workingDir: string): string {
  const trimmed = workingDir.trim()
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed
}

/**
 * 按 `workingDir` 把卡片归组。
 *
 * 组间顺序是首次出现顺序而不是字典序：看板每 5 秒轮询一次，任何一次重新排序
 * 都会让组头在用户眼皮底下跳位置。空路径的卡片自成一组并排在其首次出现的位置。
 */
export function groupCardsByProject(cards: KanbanCard[]): ProjectCardGroup[] {
  const groups = new Map<string, ProjectCardGroup>()
  for (const card of cards) {
    const workingDir = card.workingDir.trim()
    const existing = groups.get(workingDir)
    if (existing) {
      existing.cards.push(card)
      continue
    }
    groups.set(workingDir, {
      workingDir,
      name:
        workingDir === UNSPECIFIED_PROJECT_DIR
          ? UNSPECIFIED_PROJECT_LABEL
          : projectNameFromDir(workingDir),
      cards: [card],
    })
  }
  return [...groups.values()]
}

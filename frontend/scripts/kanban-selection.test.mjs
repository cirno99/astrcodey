import assert from 'node:assert/strict'

import {
  idsInRect,
  isSelectableCard,
  movesForDrop,
  rangeSelection,
  rectFromPoints,
  rectsIntersect,
  selectableIds,
  toggleSelection,
} from '../../target/frontend-kanban-selection/selection.js'

/** 只填判定用得到的字段，其余给稳定默认值。 */
function card(id, column, date = '2026-08-24') {
  return {
    id,
    title: id,
    body: '',
    column,
    workingDir: '/repo',
    attempt: 0,
    date,
    createdAt: '2026-08-24T00:00:00Z',
    updatedAt: '2026-08-24T00:00:00Z',
  }
}

const rect = (left, top, right, bottom) => ({ left, top, right, bottom })

// ── 矩形 ──

// 从右下往左上框选也要得到同一个规范矩形。
assert.deepEqual(rectFromPoints(10, 20, 30, 40), rect(10, 20, 30, 40))
assert.deepEqual(rectFromPoints(30, 40, 10, 20), rect(10, 20, 30, 40))
assert.deepEqual(rectFromPoints(10, 40, 30, 20), rect(10, 20, 30, 40))

// 边贴边不算相交：否则列与列之间的空隙会把相邻卡片也选中。
assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(5, 5, 15, 15)), true)
assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(10, 0, 20, 10)), false)
assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(0, 10, 10, 20)), false)
assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(20, 20, 30, 30)), false)

// 完全包含也算命中：小矩形框住大卡片的一角时必须选中它。
assert.equal(rectsIntersect(rect(2, 2, 4, 4), rect(0, 0, 10, 10)), true)

// ── 框选命中 ──

const entries = [
  { id: 'a', rect: rect(0, 0, 10, 10) },
  { id: 'b', rect: rect(20, 0, 30, 10) },
  { id: 'c', rect: rect(0, 20, 10, 30) },
]

// 命中结果保持传入顺序，页面才能拿它直接做区间语义。
assert.deepEqual(idsInRect(rect(-1, -1, 25, 25), entries), ['a', 'b', 'c'])
assert.deepEqual(idsInRect(rect(15, 0, 35, 12), entries), ['b'])
assert.deepEqual(idsInRect(rect(100, 100, 200, 200), entries), [])

// ── 点选 ──

const base = new Set(['a'])
const toggledOn = toggleSelection(base, 'b')
assert.deepEqual([...toggledOn], ['a', 'b'])
assert.deepEqual([...base], ['a'], '输入集合不能被就地修改')
assert.deepEqual([...toggleSelection(toggledOn, 'a')], ['b'])

// ── 区间选中 ──

const ordered = ['a', 'b', 'c', 'd']

// 含首尾，且不要求锚点在目标之前。
assert.deepEqual([...rangeSelection(ordered, 'b', 'd')], ['b', 'c', 'd'])
assert.deepEqual([...rangeSelection(ordered, 'd', 'b')], ['b', 'c', 'd'])
assert.deepEqual([...rangeSelection(ordered, 'a', 'a')], ['a'])

// 锚点或目标不在当前列表里（卡片被删、翻页换了列表）时返回空集，
// 而不是悄悄退化成单选——用户按 Shift 预期的是一个区间。
assert.deepEqual([...rangeSelection(ordered, 'missing', 'c')], [])
assert.deepEqual([...rangeSelection(ordered, 'a', 'missing')], [])

// ── 可选性 ──

// 运行中的两列由扩展独占，写入必然拿到 400，因此不参与多选。
assert.equal(isSelectableCard(card('a', 'ready')), true)
assert.equal(isSelectableCard(card('a', 'backlog')), true)
assert.equal(isSelectableCard(card('a', 'done')), true)
assert.equal(isSelectableCard(card('a', 'blocked')), true)
assert.equal(isSelectableCard(card('a', 'analyzing')), false)
assert.equal(isSelectableCard(card('a', 'implementing')), false)

const liveCards = [
  card('a', 'ready'),
  card('b', 'analyzing'),
  card('c', 'done'),
]
// 剪枝同时挡掉两类：已被删掉的 id，以及被自动化推进运行中列的卡片。
assert.deepEqual(
  [...selectableIds(liveCards, new Set(['a', 'b', 'c', 'gone']))],
  ['a', 'c']
)

// ── 落点折算 ──

const boardCards = [
  card('a', 'backlog'),
  card('b', 'backlog'),
  card('c', 'ready'),
  card('d', 'analyzing'),
  card('e', 'done', '2026-08-24'),
]

// 列落点：已经在目标列里的卡片被丢掉，否则只是白白落盘并刷新一次。
assert.deepEqual(
  movesForDrop(boardCards, ['a', 'b', 'c'], { column: 'ready' }),
  [
    { cardId: 'a', move: { column: 'ready' } },
    { cardId: 'b', move: { column: 'ready' } },
  ]
)

// 结果顺序跟随卡片列表而不是传入的 id 顺序，页面才能给出稳定的错误归因。
assert.deepEqual(movesForDrop(boardCards, ['c', 'a'], { column: 'blocked' }), [
  { cardId: 'a', move: { column: 'blocked' } },
  { cardId: 'c', move: { column: 'blocked' } },
])

// 运行中的卡片即使混进选中集也会被滤掉：选中之后、松手之前被自动化领走的情形。
assert.deepEqual(movesForDrop(boardCards, ['d'], { column: 'ready' }), [])
assert.deepEqual(movesForDrop(boardCards, ['d', 'a'], { column: 'ready' }), [
  { cardId: 'a', move: { column: 'ready' } },
])

// 日历落点同时改写归属日；列与归属日都一致的才是空操作。
assert.deepEqual(
  movesForDrop(boardCards, ['a', 'e'], {
    column: 'done',
    date: '2026-08-25',
  }),
  [
    { cardId: 'a', move: { column: 'done', date: '2026-08-25' } },
    { cardId: 'e', move: { column: 'done', date: '2026-08-25' } },
  ]
)
assert.deepEqual(
  movesForDrop(boardCards, ['e'], { column: 'done', date: '2026-08-24' }),
  []
)

// 全部被滤掉时返回空数组，页面据此跳过这次落点（不刷新、不清选中集）。
assert.deepEqual(movesForDrop(boardCards, [], { column: 'ready' }), [])
assert.deepEqual(movesForDrop(boardCards, ['unknown'], { column: 'ready' }), [])

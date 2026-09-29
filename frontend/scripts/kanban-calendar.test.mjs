import assert from 'node:assert/strict'

import {
  anchorLabel,
  bucketKeyOf,
  bucketsFor,
  cardDayKey,
  dateToDayKey,
  dayKeyFromIso,
  dayKeyToDate,
  listsCards,
  shiftAnchorDayKey,
  unscheduledCards,
} from '../../target/frontend-kanban-calendar/calendar.js'
import {
  isEditableColumn,
  opensConversation,
  resolveExpandedSlot,
  sameDropTarget,
} from '../../target/frontend-kanban-calendar/columns.js'
import {
  UNSPECIFIED_PROJECT_DIR,
  UNSPECIFIED_PROJECT_LABEL,
  groupCardsByProject,
  projectNameFromDir,
} from '../../target/frontend-kanban-calendar/projectGroups.js'

// ── 日键换算 ──

// 本地正午转 ISO 再解析回来，必须仍是同一天；这条不依赖运行机器的时区。
const localNoon = new Date(2026, 5, 15, 12, 0, 0)
assert.equal(dateToDayKey(localNoon), '2026-06-15')
assert.equal(dayKeyFromIso(localNoon.toISOString()), '2026-06-15')

// 本地凌晨也必须留在当天：直接截 UTC 字符串会让东八区凌晨落到前一天。
assert.equal(
  dayKeyFromIso(new Date(2026, 5, 15, 0, 30, 0).toISOString()),
  '2026-06-15'
)

// 损坏的时间戳返回空串，由调用方归入「未排期」。
assert.equal(dayKeyFromIso('not-a-timestamp'), '')

// ── 日键解析必须拒绝非规范输入 ──

assert.equal(dateToDayKey(dayKeyToDate('2026-06-15')), '2026-06-15')
assert.equal(dayKeyToDate('2026-2-3'), null, '缺补零的输入必须被拒')
assert.equal(dayKeyToDate('2026-02-30'), null, '不存在的日历日必须被拒')
assert.equal(dayKeyToDate('2026-13-01'), null)
assert.equal(dayKeyToDate(''), null)
assert.equal(dayKeyToDate('2026-06-15T00:00:00Z'), null)

// ── 分桶 ──

assert.equal(bucketKeyOf('day', '2026-08-24'), '2026-08-24')
assert.equal(bucketKeyOf('month', '2026-08-24'), '2026-08')
assert.equal(bucketKeyOf('year', '2026-08-24'), '2026')

// 2026-08-24 是周一；同一周的周三与周日都必须落到这个周一。
assert.equal(new Date(2026, 7, 24).getDay(), 1, '前置条件：2026-08-24 是周一')
assert.equal(new Date(2026, 7, 30).getDay(), 0, '前置条件：2026-08-30 是周日')
assert.equal(bucketKeyOf('week', '2026-08-24'), '2026-08-24')
assert.equal(bucketKeyOf('week', '2026-08-26'), '2026-08-24')
assert.equal(bucketKeyOf('week', '2026-08-30'), '2026-08-24')

// 周一自己不能跨回上一周。
assert.equal(bucketKeyOf('week', '2026-08-31'), '2026-08-31')

// 无法解析的归属日不产生桶。
assert.equal(bucketKeyOf('day', ''), '')
assert.equal(bucketKeyOf('week', 'nonsense'), '')

// ── 日刻度的桶列表 ──

const augustDays = bucketsFor('day', '2026-08-15')
assert.equal(augustDays.length, 31)
assert.equal(augustDays[0].key, '2026-08-01')
assert.equal(augustDays[30].key, '2026-08-31')
assert.equal(augustDays[0].startDay, augustDays[0].endDay)

// 平年 2 月 28 天、闰年 2 月 29 天。
assert.equal(bucketsFor('day', '2026-02-10').length, 28)
assert.equal(bucketsFor('day', '2028-02-10').length, 29)

// ── 周刻度的桶列表 ──

// 2026-08-01 是周六、2026-08-31 是周一，因此覆盖整个 8 月需要 6 个周桶。
assert.equal(new Date(2026, 7, 1).getDay(), 6, '前置条件：2026-08-01 是周六')
assert.equal(new Date(2026, 7, 31).getDay(), 1, '前置条件：2026-08-31 是周一')
const augustWeeks = bucketsFor('week', '2026-08-15')
assert.deepEqual(
  augustWeeks.map((bucket) => bucket.key),
  [
    '2026-07-27',
    '2026-08-03',
    '2026-08-10',
    '2026-08-17',
    '2026-08-24',
    '2026-08-31',
  ]
)

// 每个周桶都是周一起、周日止，且彼此首尾相接。
for (const bucket of augustWeeks) {
  assert.equal(dayKeyToDate(bucket.key).getDay(), 1, `${bucket.key} 必须是周一`)
  assert.equal(
    bucket.endDay,
    dateToDayKey(
      new Date(
        2026,
        Number(bucket.startDay.slice(5, 7)) - 1,
        Number(bucket.startDay.slice(8)) + 6
      )
    ),
    `${bucket.key} 必须覆盖到周日`
  )
}

// 当月第一天与最后一天都落在可见的周桶里，否则卡片会凭空消失。
for (const day of ['2026-08-01', '2026-08-31']) {
  assert.ok(
    augustWeeks.some((bucket) => bucket.key === bucketKeyOf('week', day)),
    `${day} 必须落在某个可见周桶里`
  )
}

// ── 月刻度与年刻度 ──

const months = bucketsFor('month', '2026-08-15')
assert.equal(months.length, 12)
assert.equal(months[0].key, '2026-01')
assert.equal(months[11].key, '2026-12')
assert.equal(months[1].endDay, '2026-02-28', '平年 2 月结束于 28 日')
assert.equal(months[11].endDay, '2026-12-31')

const years = bucketsFor('year', '2026-08-15')
assert.equal(years.length, 10)
assert.equal(years[0].key, '2020')
assert.equal(years[9].key, '2029')
assert.equal(years[0].startDay, '2020-01-01')
assert.equal(years[9].endDay, '2029-12-31')

// 锚点无法解析时渲染空日历，而不是抛错或造出错误的月份。
assert.deepEqual(bucketsFor('day', ''), [])
assert.deepEqual(bucketsFor('month', 'nonsense'), [])

// ── 卡片归属 ──

// 后端归一化过的 date 优先。
assert.equal(
  cardDayKey({ date: '2026-08-24', createdAt: '2020-01-01T00:00:00Z' }),
  '2026-08-24'
)

// date 为空（旧数据回填失败）时回落到创建日期的本地日历日。
const createdIso = new Date(2026, 7, 24, 9, 0, 0).toISOString()
assert.equal(cardDayKey({ date: '', createdAt: createdIso }), '2026-08-24')

// 两者都不可用时不编造日期。
assert.equal(cardDayKey({ date: '', createdAt: 'broken' }), '')

const cards = [
  { id: 'in-august', date: '2026-08-24', createdAt: createdIso },
  { id: 'in-july', date: '2026-07-01', createdAt: createdIso },
  { id: 'unknown', date: '', createdAt: 'broken' },
]

// ── 翻页 ──

// 日/周刻度按整月翻，落在目标月的 1 号。
assert.equal(shiftAnchorDayKey('day', '2026-08-15', 1), '2026-09-01')
assert.equal(shiftAnchorDayKey('day', '2026-08-15', -1), '2026-07-01')
assert.equal(
  shiftAnchorDayKey('week', '2026-01-15', -1),
  '2025-12-01',
  '跨年要正确回退'
)
assert.equal(shiftAnchorDayKey('month', '2026-08-15', 1), '2027-01-01')
assert.equal(shiftAnchorDayKey('year', '2026-08-15', -1), '2016-01-01')
assert.equal(shiftAnchorDayKey('day', '', 1), '', '锚点不可解析时原样返回')

// 翻页后的桶必须真的换了周期，否则别的月份的卡片永远看不见。
assert.equal(
  bucketsFor('day', shiftAnchorDayKey('day', '2026-08-15', 1))[0].key,
  '2026-09-01'
)

// ── 周期标题 ──

assert.equal(anchorLabel('day', '2026-08-15'), '2026 年 8 月')
assert.equal(anchorLabel('week', '2026-08-15'), '2026 年 8 月')
assert.equal(anchorLabel('month', '2026-08-15'), '2026 年')
assert.equal(anchorLabel('year', '2026-08-15'), '2020 – 2029')
assert.equal(anchorLabel('day', ''), '')

// 归属日未知的卡片单独收纳。
assert.deepEqual(
  unscheduledCards(cards).map((card) => card.id),
  ['unknown']
)

// ── 手风琴展开项 ──

const noCards = { backlog: 0, done: 0 }
const backlogCards = { backlog: 2, done: 0 }
const doneCards = { backlog: 0, done: 2 }
const bothCards = { backlog: 2, done: 2 }

assert.equal(resolveExpandedSlot('backlog', backlogCards), 'backlog')
assert.equal(resolveExpandedSlot('done', doneCards), 'done')
assert.equal(resolveExpandedSlot('backlog', bothCards), 'backlog')
assert.equal(resolveExpandedSlot('done', bothCards), 'done')

// 两项都空时保留用户的选择，否则空列会莫名其妙地跳回「待办」。
assert.equal(resolveExpandedSlot('done', noCards), 'done')
assert.equal(resolveExpandedSlot('backlog', noCards), 'backlog')

// 用户点开的那项空而另一项有卡片时让位，否则卡片会被藏在收起的菜单项里。
assert.equal(resolveExpandedSlot('backlog', doneCards), 'done')
assert.equal(resolveExpandedSlot('done', backlogCards), 'backlog')

// 没点过任何一项时是对半态：两项同时展开、各占一半高度，不需要让位。
assert.equal(resolveExpandedSlot(null, noCards), null)
assert.equal(resolveExpandedSlot(null, backlogCards), null)
assert.equal(resolveExpandedSlot(null, bothCards), null)

// ── 落点比较 ──

const readyColumn = { kind: 'column', column: 'ready' }
const blockedColumn = { kind: 'column', column: 'blocked' }
const dayBacklog = { kind: 'bucket', bucketKey: '2026-08-15', slot: 'backlog' }
const dayDone = { kind: 'bucket', bucketKey: '2026-08-15', slot: 'done' }
const otherDayBacklog = {
  kind: 'bucket',
  bucketKey: '2026-08-16',
  slot: 'backlog',
}

assert.equal(sameDropTarget(null, null), true)
assert.equal(sameDropTarget(null, readyColumn), false)
assert.equal(sameDropTarget(readyColumn, null), false)
assert.equal(
  sameDropTarget(readyColumn, { kind: 'column', column: 'ready' }),
  true
)
assert.equal(sameDropTarget(readyColumn, blockedColumn), false)
assert.equal(sameDropTarget(dayBacklog, { ...dayBacklog }), true)
assert.equal(sameDropTarget(dayBacklog, dayDone), false)
assert.equal(sameDropTarget(dayBacklog, otherDayBacklog), false)
// 跨区域的两个落点永远不相等，否则公共区高亮会跟着日历一起亮。
assert.equal(sameDropTarget(readyColumn, dayBacklog), false)

// ── 列里是否列出卡片 ──

// 日/周/月列出卡片方便复盘；年刻度保留数量块，否则一列要塞进整年。
assert.equal(listsCards('day'), true)
assert.equal(listsCards('week'), true)
assert.equal(listsCards('month'), true)
assert.equal(listsCards('year'), false)

// ── 卡片可点 / 可编辑的列 ──

// 只有「分析中」「实施中」「已完成」「已阻塞」点击会跳对话。
for (const column of ['analyzing', 'implementing', 'done', 'blocked']) {
  assert.equal(opensConversation(column), true, `${column} 必须可跳对话`)
}
// 「待办」还没有对话；「待领取」即使续跑退回后仍留着 sessionId，点击也保持无反应。
for (const column of ['backlog', 'ready']) {
  assert.equal(opensConversation(column), false, `${column} 不该跳对话`)
}

// 只有「待办」可以改标题与正文；其余列要么正被扩展持有，要么已经产出了交付记录。
assert.equal(isEditableColumn('backlog'), true)
for (const column of [
  'ready',
  'analyzing',
  'implementing',
  'done',
  'blocked',
]) {
  assert.equal(isEditableColumn(column), false, `${column} 不该可编辑`)
}

// ── 按项目路径分组 ──

// 「待办」与「已完成」是仅有的两个日历槽位；槽位内同项目的卡片必须相邻，
// 因此分组键取 trim 后的完整路径，而不是只显示用的项目名。
const grouped = groupCardsByProject([
  { id: 'a1', workingDir: '/repo/alpha' },
  { id: 'b1', workingDir: '/repo/beta' },
  { id: 'a2', workingDir: '/repo/alpha' },
  { id: 'loose', workingDir: '' },
  { id: 'a3', workingDir: ' /repo/alpha ' },
])

// 组间顺序是首次出现顺序：后端按插入顺序返回卡片，按字典序重排会让组头在轮询时跳位置。
assert.deepEqual(
  grouped.map((group) => group.workingDir),
  ['/repo/alpha', '/repo/beta', UNSPECIFIED_PROJECT_DIR]
)
assert.deepEqual(
  grouped.map((group) => group.name),
  ['alpha', 'beta', UNSPECIFIED_PROJECT_LABEL]
)

// 组内保持传入顺序，且末尾空格的路径与不带空格的路径必须归到同一组。
assert.deepEqual(
  grouped[0].cards.map((card) => card.id),
  ['a1', 'a2', 'a3']
)

// 没有工作目录的卡片自成一组，而不是被丢掉。
assert.deepEqual(
  grouped[2].cards.map((card) => card.id),
  ['loose']
)

// 同名的不同项目不能并组：组键是完整路径，显示名才取最后一段。
const sameBasename = groupCardsByProject([
  { id: 'x1', workingDir: '/repo/alpha' },
  { id: 'x2', workingDir: '/other/alpha' },
])
assert.equal(sameBasename.length, 2)

// 空输入不产生空组头。
assert.deepEqual(groupCardsByProject([]), [])

// 项目名取路径最后一段；Windows 分隔符、尾斜杠都要处理。
assert.equal(projectNameFromDir('/repo/alpha'), 'alpha')
assert.equal(projectNameFromDir('C:\\repo\\beta'), 'beta')
assert.equal(projectNameFromDir('/repo/alpha/'), 'alpha')
assert.equal(projectNameFromDir('  /repo/alpha  '), 'alpha')

// 路径只有分隔符或为空时回落原文，不能返回空名字。
assert.equal(projectNameFromDir(''), '')
assert.equal(projectNameFromDir('/'), '/')

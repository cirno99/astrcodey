/**
 * 看板日历的纯日期逻辑：把卡片按归属日归进各刻度的时间桶。
 *
 * 只做日期运算，不碰 React 与 DOM，因此可以直接在 node 下跑测试。
 * 所有日键都是补零的 `YYYY-MM-DD` 本地日期字符串——字符串比较即时间先后，
 * 这也让前端分桶与后端 `Card.date` 的归一化格式一一对应。
 */

export const CALENDAR_SCALES = ['day', 'week', 'month', 'year'] as const

export type CalendarScale = (typeof CALENDAR_SCALES)[number]

export const CALENDAR_SCALE_LABELS: Record<CalendarScale, string> = {
  day: '日',
  week: '周',
  month: '月',
  year: '年',
}

/**
 * 这些刻度直接在列里列出卡片，方便复盘。
 *
 * 年刻度只给数量：一列要塞进整年，列出卡片既读不动也滚不完。
 */
export function listsCards(scale: CalendarScale): boolean {
  return scale === 'day' || scale === 'week' || scale === 'month'
}

/** 一个日历列：覆盖 `[startDay, endDay]`（含两端）的一段时间桶。 */
export interface CalendarBucket {
  /** 稳定标识，同时是字符串排序键；日刻度为当天，周刻度为该周周一。 */
  key: string
  /** 展开态的列标题。 */
  label: string
  /** 收起态（无卡片，宽度只有几个字符）用的短标题。 */
  shortLabel: string
  startDay: string
  endDay: string
}

/** 卡片归属日未知时使用的桶键；这类卡片不能凭空从日历上消失。 */
export const UNSCHEDULED_BUCKET_KEY = 'unscheduled'

const pad = (value: number) => String(value).padStart(2, '0')

/** 本地时区的日历日。 */
export function dateToDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 今天的本地日历日。 */
export function todayKey(now: Date = new Date()): string {
  return dateToDayKey(now)
}

/**
 * RFC3339 时间戳转本地日历日。
 *
 * 后端时间戳是 UTC，直接截字符串会让东八区凌晨的卡片落到前一天，因此必须按本地时区换算。
 * 解析失败返回空串，调用方据此把卡片归入「未排期」而不是编一个日期出来。
 */
export function dayKeyFromIso(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return ''
  return dateToDayKey(date)
}

/**
 * 日键转本地零点时刻。
 *
 * 非规范输入（缺补零、不存在的日历日）一律返回 `null`：`Date` 会把 `2026-02-30`
 * 静默滚到 3 月，放过去就会让日历把卡片放进一个不存在的列。
 */
export function dayKeyToDate(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  )
  if (Number.isNaN(date.getTime())) return null
  if (dateToDayKey(date) !== dayKey) return null
  return date
}

/** 卡片的归属日：优先用后端归一化过的 `date`，旧数据回落到创建日期。 */
export function cardDayKey(card: { date: string; createdAt: string }): string {
  return card.date || dayKeyFromIso(card.createdAt)
}

/** 卡片在指定刻度下所属的桶键；归属日无法确定时返回空串。 */
export function bucketKeyOf(scale: CalendarScale, dayKey: string): string {
  const date = dayKeyToDate(dayKey)
  if (!date) return ''
  switch (scale) {
    case 'day':
      return dayKey
    case 'week':
      return dateToDayKey(startOfWeek(date))
    case 'month':
      return dayKey.slice(0, 7)
    case 'year':
      return dayKey.slice(0, 4)
  }
}

/**
 * 指定刻度下要渲染的有序桶列表。
 *
 * 覆盖范围随刻度逐级放大：日看当月、周看覆盖当月的整周、月看当年、年看当前十年。
 * 锚点日无法解析时返回空列表——渲染一个空日历比渲染一个错误的日历好。
 */
export function bucketsFor(
  scale: CalendarScale,
  anchorDayKey: string
): CalendarBucket[] {
  const anchor = dayKeyToDate(anchorDayKey)
  if (!anchor) return []
  switch (scale) {
    case 'day':
      return dayBuckets(anchor)
    case 'week':
      return weekBuckets(anchor)
    case 'month':
      return monthBuckets(anchor)
    case 'year':
      return yearBuckets(anchor)
  }
}

/**
 * 按刻度把锚点前后翻一个周期。
 *
 * 每个刻度只渲染当前周期内的桶，没有翻页，别的月份里的卡片就永远看不见。
 * 日/周刻度按整月翻，月刻度按整年翻，年刻度按整十年翻。
 */
export function shiftAnchorDayKey(
  scale: CalendarScale,
  anchorDayKey: string,
  direction: -1 | 1
): string {
  const anchor = dayKeyToDate(anchorDayKey)
  if (!anchor) return anchorDayKey
  switch (scale) {
    case 'day':
    case 'week':
      return dateToDayKey(
        new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1)
      )
    case 'month':
      return dateToDayKey(new Date(anchor.getFullYear() + direction, 0, 1))
    case 'year':
      return dateToDayKey(new Date(anchor.getFullYear() + direction * 10, 0, 1))
  }
}

/** 日历头部显示的当前周期。 */
export function anchorLabel(
  scale: CalendarScale,
  anchorDayKey: string
): string {
  const anchor = dayKeyToDate(anchorDayKey)
  if (!anchor) return ''
  const year = anchor.getFullYear()
  switch (scale) {
    case 'day':
    case 'week':
      return `${year} 年 ${anchor.getMonth() + 1} 月`
    case 'month':
      return `${year} 年`
    case 'year': {
      const firstYear = Math.floor(year / 10) * 10
      return `${firstYear} – ${firstYear + 9}`
    }
  }
}

/** 归属日无法确定的卡片（旧数据），日历上必须给它们一个可见的落点。 */
export function unscheduledCards<T extends { date: string; createdAt: string }>(
  cards: T[]
): T[] {
  return cards.filter((card) => cardDayKey(card) === '')
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** ISO 周：以周一为起点。 */
function startOfWeek(date: Date): Date {
  const offset = (date.getDay() + 6) % 7
  return addDays(date, -offset)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function dayBuckets(anchor: Date): CalendarBucket[] {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const last = daysInMonth(year, month)
  const buckets: CalendarBucket[] = []
  for (let day = 1; day <= last; day += 1) {
    const key = dateToDayKey(new Date(year, month, day))
    buckets.push({
      key,
      label: `${month + 1}/${day}`,
      shortLabel: String(day),
      startDay: key,
      endDay: key,
    })
  }
  return buckets
}

function weekBuckets(anchor: Date): CalendarBucket[] {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const first = startOfWeek(new Date(year, month, 1))
  const last = startOfWeek(new Date(year, month, daysInMonth(year, month)))

  const buckets: CalendarBucket[] = []
  for (
    let cursor = first;
    cursor.getTime() <= last.getTime();
    cursor = addDays(cursor, 7)
  ) {
    const startDay = dateToDayKey(cursor)
    const endDay = dateToDayKey(addDays(cursor, 6))
    buckets.push({
      key: startDay,
      label: `${startDay.slice(5).replace('-', '/')}–${endDay.slice(5).replace('-', '/')}`,
      shortLabel: startDay.slice(5).replace('-', '/'),
      startDay,
      endDay,
    })
  }
  return buckets
}

function monthBuckets(anchor: Date): CalendarBucket[] {
  const year = anchor.getFullYear()
  return Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${pad(index + 1)}`
    return {
      key,
      label: `${index + 1} 月`,
      shortLabel: `${index + 1}月`,
      startDay: `${key}-01`,
      endDay: `${key}-${pad(daysInMonth(year, index))}`,
    }
  })
}

function yearBuckets(anchor: Date): CalendarBucket[] {
  const firstYear = Math.floor(anchor.getFullYear() / 10) * 10
  return Array.from({ length: 10 }, (_, index) => {
    const year = firstYear + index
    return {
      key: String(year),
      label: `${year} 年`,
      shortLabel: String(year),
      startDay: `${year}-01-01`,
      endDay: `${year}-12-31`,
    }
  })
}

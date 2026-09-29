import assert from 'node:assert/strict'

import {
  forgetProjectPath,
  mergeProjectPathCandidates,
  readProjectPathHistory,
  rememberProjectPath,
} from '../../target/frontend-project-path-history/projectPathHistory.js'

/** 用 Map 支撑的最小 localStorage 替身，并暴露写入过的 key 以便伪造损坏数据。 */
function createStorage() {
  const entries = new Map()
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    keys: () => [...entries.keys()],
  }
}

let storage = createStorage()
globalThis.window = { localStorage: storage }

// 从未写入过历史时返回空列表，而不是抛错或造出占位值。
assert.deepEqual(readProjectPathHistory(), [])

// 最近使用的路径在前；重复路径去重后提到最前。
rememberProjectPath('/a')
rememberProjectPath('/b')
rememberProjectPath('/a')
assert.deepEqual(readProjectPathHistory(), ['/a', '/b'])

// 空路径不入历史，首尾空白会被裁掉。
rememberProjectPath('   ')
assert.deepEqual(readProjectPathHistory(), ['/a', '/b'])
rememberProjectPath('  /c  ')
assert.deepEqual(readProjectPathHistory(), ['/c', '/a', '/b'])

// 超过上限时丢弃最久未使用的路径。
for (let index = 0; index < 15; index += 1) {
  rememberProjectPath(`/dir-${index}`)
}
const capped = readProjectPathHistory()
assert.equal(capped.length, 10)
assert.equal(capped[0], '/dir-14')
assert.equal(capped.includes('/a'), false, '超出上限的旧路径必须被丢弃')

// 删除只作用于历史：被删的路径落盘后不再出现。
assert.deepEqual(forgetProjectPath('/dir-14'), capped.slice(1))
assert.deepEqual(readProjectPathHistory(), capped.slice(1))

// 删除不存在的路径、以及空路径，都是无操作。
assert.deepEqual(forgetProjectPath('/never-stored'), capped.slice(1))
assert.deepEqual(forgetProjectPath('   '), capped.slice(1))

// 存储内容损坏时回退为空历史，而不是把异常抛给看板页。
storage = createStorage()
globalThis.window = { localStorage: storage }
rememberProjectPath('/a')
for (const key of storage.keys()) {
  storage.setItem(key, '{not json')
}
assert.deepEqual(readProjectPathHistory(), [])

// 存储不可用（例如配额耗尽）时只丢历史，本次创建仍应拿到返回值。
globalThis.window = {
  localStorage: {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded')
    },
  },
}
assert.deepEqual(rememberProjectPath('/a'), ['/a'])

// 候选合并：历史顺序优先，与其它来源去重，空值被丢弃。
assert.deepEqual(
  mergeProjectPathCandidates(
    ['/a', '/b'],
    ['/b', '/c', null, undefined, '   ', '/a']
  ),
  ['/a', '/b', '/c']
)
assert.deepEqual(mergeProjectPathCandidates([' /a '], []), ['/a'])
assert.deepEqual(mergeProjectPathCandidates([], ['/x', '/x']), ['/x'])
assert.deepEqual(mergeProjectPathCandidates([], [null, undefined, '']), [])

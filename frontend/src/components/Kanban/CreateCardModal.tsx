import { useCallback, useMemo, useState } from 'react'
import { Button, Dropdown, IconButton, Modal } from '../ui'
import * as api from '../../services/api'
import {
  forgetProjectPath,
  mergeProjectPathCandidates,
  readIgnoredProjectPaths,
  readProjectPathHistory,
  rememberProjectPath,
} from './projectPathHistory'

interface CreateCardModalProps {
  /** 未填路径时的默认值，通常是当前会话的工作目录。 */
  defaultWorkingDir: string
  /** 历史之外的路径候选，由页面从会话列表推导。 */
  extraPathCandidates: string[]
  /** 日期输入的初值，也是用户清空输入后的兜底。 */
  defaultDate: string
  onClose: () => void
  onCreated: () => Promise<void>
}

/**
 * 新建卡片弹窗。
 *
 * 表单原先内联在看板页顶部，会把泳道往下挤；改成弹窗后看板区域不再随输入状态变高。
 * 校验与请求错误都留在弹窗内显示——此时页面顶部的错误横幅被遮罩盖住，用户看不到。
 */
export function CreateCardModal({
  defaultWorkingDir,
  extraPathCandidates,
  defaultDate,
  onClose,
  onCreated,
}: CreateCardModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [pathHistory, setPathHistory] = useState<string[]>(() =>
    readProjectPathHistory()
  )
  /** 被用户删掉的候选；候选是多个来源的并集，只清历史挡不住会话目录。 */
  const [ignoredPaths, setIgnoredPaths] = useState<string[]>(() =>
    readIgnoredProjectPaths()
  )
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const pathCandidates = useMemo(
    () =>
      mergeProjectPathCandidates(
        pathHistory,
        [defaultWorkingDir, ...extraPathCandidates],
        ignoredPaths
      ),
    [defaultWorkingDir, extraPathCandidates, ignoredPaths, pathHistory]
  )

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim()
    const targetDir = workingDir.trim() || defaultWorkingDir
    if (!trimmedTitle) {
      setErrorMessage('卡片标题不能为空')
      return
    }
    if (!targetDir) {
      setErrorMessage('需要指定工作目录')
      return
    }
    setBusy(true)
    try {
      await api.createKanbanCard({
        title: trimmedTitle,
        body,
        workingDir: targetDir,
        date: date || defaultDate,
        column: 'backlog',
      })
      setPathHistory(rememberProjectPath(targetDir))
      await onCreated()
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [
    body,
    date,
    defaultDate,
    defaultWorkingDir,
    onClose,
    onCreated,
    title,
    workingDir,
  ])

  return (
    <Modal
      title="新建卡片"
      onClose={onClose}
      closeOnOverlay={!busy}
      className="w-[min(560px,92vw)]"
    >
      <div className="grid gap-3">
        <input
          className="rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
          placeholder="标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Dropdown
          open={pathMenuOpen && pathCandidates.length > 0}
          onClose={() => setPathMenuOpen(false)}
          align="left"
          label="项目路径候选"
          className="max-h-[240px] w-full min-w-full max-w-none overflow-y-auto"
          trigger={
            <input
              className="w-full rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
              placeholder={
                defaultWorkingDir ? `默认：${defaultWorkingDir}` : '项目路径'
              }
              value={workingDir}
              onChange={(event) => {
                setWorkingDir(event.target.value)
                setPathMenuOpen(true)
              }}
              onClick={() => setPathMenuOpen(true)}
              onFocus={() => setPathMenuOpen(true)}
            />
          }
        >
          {pathCandidates.map((dir) => (
            <div
              key={dir}
              className="flex items-center gap-1 rounded-md pl-2 hover:bg-surface-muted"
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left text-[12px] text-text-secondary"
                title={dir}
                onClick={() => {
                  setWorkingDir(dir)
                  setPathMenuOpen(false)
                }}
              >
                {dir}
              </button>
              {/* 任何候选都能删：删除会记进忽略集合，挡住会话目录与默认目录推导出的候选。 */}
              <IconButton
                icon="trash"
                size={14}
                className="p-0.5"
                label={`从候选中删除 ${dir}`}
                onClick={() => {
                  setPathHistory(forgetProjectPath(dir))
                  setIgnoredPaths(readIgnoredProjectPaths())
                }}
              />
            </div>
          ))}
        </Dropdown>
        <label className="flex items-center gap-3 text-[12px] text-text-secondary">
          <span className="shrink-0">归属日</span>
          <input
            type="date"
            className="rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <textarea
          className="h-24 w-full resize-none rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
          placeholder="需求正文"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      {errorMessage && (
        <div className="mt-3 rounded-lg border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {errorMessage}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          className="h-9 px-3 text-[13px]"
          onClick={onClose}
        >
          取消
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void handleSubmit()}
        >
          添加到待办
        </Button>
      </div>
    </Modal>
  )
}

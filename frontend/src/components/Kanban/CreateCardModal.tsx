import { useCallback, useState } from 'react'
import { Button, Modal } from '../ui'
import * as api from '../../services/api'
import { ProjectPathField } from './ProjectPathField'
import { rememberProjectPath } from './projectPathHistory'

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
  /** 文件夹选择器是否打开；选择器自己会列举目录，这里只负责显示与回填。 */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  /**
   * 选择器开着时忽略 Esc。
   *
   * 两个弹窗都把 Esc 监听挂在 window 上，新建弹窗先注册、先收到事件；不挡住的话
   * 按一次 Esc 会把两个弹窗一起关掉，用户填了一半的标题与正文跟着丢。
   */
  const handleClose = useCallback(() => {
    if (pickerOpen) return
    onClose()
  }, [onClose, pickerOpen])

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
      rememberProjectPath(targetDir)
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
    <>
      <Modal
        title="新建卡片"
        onClose={handleClose}
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
          <ProjectPathField
            value={workingDir}
            onChange={setWorkingDir}
            defaultWorkingDir={defaultWorkingDir}
            extraPathCandidates={extraPathCandidates}
            onPickerOpenChange={setPickerOpen}
          />
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
    </>
  )
}

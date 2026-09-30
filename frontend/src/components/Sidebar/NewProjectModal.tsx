import { useState, useCallback } from 'react'
import { btnPrimary } from '../../lib/styles'
import { Modal, Button } from '../ui'
import { ProjectPathField } from '../Kanban/ProjectPathField'
import { rememberProjectPath } from '../Kanban/projectPathHistory'

interface NewProjectModalProps {
  /** 未填路径时的默认值，通常是当前会话的工作目录。 */
  defaultWorkingDir: string
  /** 历史之外的路径候选，由侧边栏从会话列表推导。 */
  extraPathCandidates?: string[]
  onConfirm: (workingDir: string) => Promise<void>
  onCancel: () => void
}

export default function NewProjectModal({
  defaultWorkingDir,
  extraPathCandidates,
  onConfirm,
  onCancel,
}: NewProjectModalProps) {
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 文件夹选择器是否打开；选择器开着时忽略 Esc，避免一次 Esc 关掉两层弹窗。 */
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleClose = useCallback(() => {
    if (loading || pickerOpen) return
    onCancel()
  }, [loading, pickerOpen, onCancel])

  const handleSubmit = useCallback(() => {
    const trimmed = path.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    onConfirm(trimmed)
      .then(() => {
        rememberProjectPath(trimmed)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [path, loading, onConfirm])

  return (
    <Modal title="新建项目" onClose={handleClose} closeOnOverlay={!loading}>
      <div className="mb-4">
        <label className="mb-1.5 block text-[13px] text-text-secondary">
          工作目录
        </label>
        <ProjectPathField
          value={path}
          onChange={setPath}
          defaultWorkingDir={defaultWorkingDir}
          extraPathCandidates={extraPathCandidates}
          disabled={loading}
          onPickerOpenChange={setPickerOpen}
        />
      </div>
      {error && (
        <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <button
          type="button"
          className={btnPrimary}
          onClick={handleSubmit}
          disabled={!path.trim() || loading}
        >
          {loading ? '创建中...' : '创建'}
        </button>
      </div>
    </Modal>
  )
}

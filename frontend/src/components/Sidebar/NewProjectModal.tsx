import { useState, useCallback } from 'react'
import { btnPrimary } from '../../lib/styles'
import { Modal, Input, Button } from '../ui'

interface NewProjectModalProps {
  onConfirm: (workingDir: string) => Promise<void>
  onCancel: () => void
}

export default function NewProjectModal({
  onConfirm,
  onCancel,
}: NewProjectModalProps) {
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(() => {
    const trimmed = path.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    onConfirm(trimmed).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    })
  }, [path, loading, onConfirm])

  return (
    <Modal
      title="新建项目"
      onClose={loading ? () => {} : onCancel}
      closeOnOverlay={!loading}
    >
      <div className="mb-4">
        <label className="mb-1.5 block text-[13px] text-text-secondary">
          工作目录
        </label>
        <div className="flex gap-2">
          <Input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="输入目录路径..."
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
        </div>
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

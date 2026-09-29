import { useCallback, useState } from 'react'
import { Button, Modal } from '../ui'
import * as api from '../../services/api'
import type { KanbanCard } from '../../services/types'

interface EditCardModalProps {
  card: KanbanCard
  onClose: () => void
  onSaved: () => Promise<void>
}

/**
 * 编辑待办卡片的弹窗。
 *
 * 只暴露标题与需求正文：工作目录、归属日、列都靠拖拽或卡片上的下拉框改，
 * 放进这里会让「编辑」变成第二个看板编辑面，两边规则迟早对不齐。
 *
 * 提交时卡片可能已被自动化领取（看板每 5 秒轮询，弹窗打开期间状态会变），
 * 那种情况由扩展返回 400，错误留在弹窗里显示。
 */
export function EditCardModal({ card, onClose, onSaved }: EditCardModalProps) {
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setErrorMessage('卡片标题不能为空')
      return
    }
    setBusy(true)
    try {
      await api.updateKanbanCard(card.id, { title: trimmedTitle, body })
      await onSaved()
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [body, card.id, onClose, onSaved, title])

  return (
    <Modal
      title="编辑卡片"
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
          保存
        </Button>
      </div>
    </Modal>
  )
}

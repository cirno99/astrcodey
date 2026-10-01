import { memo, useState, useCallback, useEffect, useRef } from 'react'
import type { SessionListItem } from '../../services/types'
import { cn } from '../../lib/utils'
import { PHASE_BG_CLASS } from '../../lib/styles'
import { Icon } from '../ui/Icon'

interface SessionItemProps {
  session: SessionListItem
  isActive: boolean
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onDelete,
}: SessionItemProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setConfirmDelete(false)
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
        setConfirmDelete(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  const handleRequestDelete = useCallback(() => {
    setConfirmDelete(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    setContextMenu(null)
    setConfirmDelete(false)
    onDelete(session.sessionId)
  }, [onDelete, session.sessionId])

  const handleCancelDelete = useCallback(() => {
    setContextMenu(null)
    setConfirmDelete(false)
  }, [])

  return (
    <>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg py-2 text-left outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ease-out border focus-visible:shadow-focus-accent',
          isActive
            ? 'bg-surface border-border shadow-soft border-l-[3px] border-l-accent-strong pl-1.75 pr-2.5'
            : 'border-transparent px-2.5 hover:bg-surface-muted'
        )}
        onClick={() => onSelect(session.sessionId)}
        onContextMenu={handleContextMenu}
      >
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full transition-[background-color] duration-300 ease-out',
            PHASE_BG_CLASS[session.phase] ?? PHASE_BG_CLASS.idle
          )}
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-[13px]',
              isActive ? 'text-text-primary font-medium' : 'text-text-secondary'
            )}
          >
            {session.firstUserMessage || '新会话'}
          </div>
          <div className="truncate text-[11px] text-text-muted opacity-85 mt-0.5">
            {session.workingDir}
          </div>
        </div>
      </button>
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-100 rounded-xl border border-border bg-surface py-1 shadow-surface-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {confirmDelete ? (
            <div className="px-3 py-2">
              <div className="mb-2 text-[12px] text-text-secondary">
                确认删除此会话?
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-border bg-surface-soft px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-muted"
                  onClick={handleCancelDelete}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-danger/20 bg-danger-soft px-2.5 py-1 text-[12px] font-semibold text-danger hover:brightness-98"
                  onClick={handleConfirmDelete}
                >
                  删除
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-text-secondary transition-[background-color,color] duration-100 ease-out hover:bg-danger-soft hover:text-danger"
              onClick={handleRequestDelete}
            >
              <Icon name="trash" size={14} />
              删除会话
            </button>
          )}
        </div>
      )}
    </>
  )
}

export default memo(SessionItem)

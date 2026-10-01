import { useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { dialogSurface, overlay } from '../../lib/styles'
import { IconButton } from './IconButton'

interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
  closeOnOverlay?: boolean
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((element) => element.getClientRects().length > 0)
}

export function Modal({
  title,
  children,
  onClose,
  className,
  closeOnOverlay = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // 记住打开前的焦点，关闭时归还给触发元素；否则焦点会掉回 body。
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  useEffect(() => {
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
    }
  }, [])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = focusableWithin(dialog)
      if (focusable.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || active === dialog) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className={overlay}
      role="presentation"
      onClick={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(dialogSurface, className)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-[18px] flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-xl font-bold text-text-primary">
            {title}
          </h2>
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}

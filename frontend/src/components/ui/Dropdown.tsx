import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface DropdownProps {
  open: boolean
  onClose: () => void
  trigger: ReactNode
  children: ReactNode
  className?: string
  align?: 'left' | 'right'
  label?: string
}

export function Dropdown({
  open,
  onClose,
  trigger,
  children,
  className,
  align = 'right',
  label,
}: DropdownProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 只关掉最内层的弹层：阻止冒泡，避免同时触发外层 Modal 的 Escape 关闭。
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  return (
    <div ref={menuRef} className="relative shrink-0">
      {trigger}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-full z-50 mt-1 min-w-[220px] max-w-[360px] rounded-lg border border-border bg-surface p-2 shadow-surface-lg animate-popover-in motion-reduce:animate-none',
            align === 'right'
              ? 'right-0 origin-top-right'
              : 'left-0 origin-top-left',
            className
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

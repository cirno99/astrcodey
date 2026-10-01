import { useState, useCallback, useRef, useEffect, type RefObject } from 'react'

const STORAGE_KEY = 'astrcode-sidebar-width'
const DEFAULT_WIDTH = 300
const MIN_WIDTH = 240
const MAX_WIDTH = 380

export interface UseSidebarResize {
  width: number
  isOpen: boolean
  toggle: () => void
  onResizeStart: (e: React.PointerEvent) => void
  isResizing: boolean
  /** 拖拽期间宽度直接写在元素上，避免每次 pointermove 触发整棵树重渲染。 */
  containerRef: RefObject<HTMLDivElement | null>
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))
}

export function useSidebarResize(): UseSidebarResize {
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = Number(stored)
      if (
        Number.isFinite(parsed) &&
        parsed >= MIN_WIDTH &&
        parsed <= MAX_WIDTH
      ) {
        return parsed
      }
    }
    return DEFAULT_WIDTH
  })
  const [isOpen, setIsOpen] = useState(true)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const pendingWidthRef = useRef(width)
  const containerRef = useRef<HTMLDivElement>(null)

  const persistWidth = useCallback((nextWidth: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(nextWidth))
    } catch {
      // Ignore storage errors
    }
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (e: PointerEvent) => {
      const delta = e.clientX - startXRef.current
      const nextWidth = clampWidth(startWidthRef.current + delta)
      pendingWidthRef.current = nextWidth
      const element = containerRef.current
      if (element) element.style.width = `${nextWidth}px`
    }

    const handlePointerUp = () => {
      const committed = pendingWidthRef.current
      setIsResizing(false)
      persistWidth(committed)
      setWidth(committed)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [isResizing, persistWidth])

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = width
      pendingWidthRef.current = width
      setIsResizing(true)
    },
    [width]
  )

  const toggle = useCallback(() => {
    setIsOpen((v) => !v)
  }, [])

  return { width, isOpen, toggle, onResizeStart, isResizing, containerRef }
}

import { useCallback, useEffect, useState } from 'react'
import { Button, Icon, Modal } from '../ui'
import * as api from '../../services/api'
import type { KanbanDirectoryListing } from '../../services/types'

interface ProjectFolderPickerProps {
  /** 打开时定位到的目录；为空时由扩展回落到它自己的当前目录。 */
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}

/** 一次列举的结果：成功给数据，失败给可展示的消息。 */
type ListingResult =
  | { ok: true; listing: KanbanDirectoryListing }
  | { ok: false; message: string }

async function fetchListing(path: string): Promise<ListingResult> {
  try {
    return { ok: true, listing: await api.listKanbanDirectories(path) }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 文件夹选择器弹窗。
 *
 * 浏览器的文件夹选择器只能给出文件夹名、给不出本机绝对路径，所以这里由服务端列举目录、
 * 前端自绘：只浏览目录，不预览文件内容。
 */
export function ProjectFolderPicker({
  initialPath,
  onSelect,
  onClose,
}: ProjectFolderPickerProps) {
  const [listing, setListing] = useState<KanbanDirectoryListing | null>(null)
  /** 挂载时必定列举一次，因此初始就是读取中。 */
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** 正在列举的目录；列举失败时列表是空的，靠它告诉用户「刚才找的是哪儿」。 */
  const [requestedPath, setRequestedPath] = useState(initialPath)

  const applyListing = useCallback((result: ListingResult) => {
    if (result.ok) {
      setListing(result.listing)
      setErrorMessage(null)
    } else {
      setListing(null)
      setErrorMessage(result.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchListing(initialPath).then((result) => {
      if (!cancelled) applyListing(result)
    })
    return () => {
      cancelled = true
    }
  }, [initialPath, applyListing])

  const goTo = (path: string) => {
    setRequestedPath(path)
    setLoading(true)
    void fetchListing(path).then(applyListing)
  }

  const parent = listing?.parent ?? null
  const currentPath = listing?.path ?? requestedPath

  return (
    <Modal title="选择文件夹" onClose={onClose} className="w-[min(560px,92vw)]">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="folder" size={14} className="shrink-0 text-text-muted" />
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-text-secondary"
          title={currentPath || undefined}
        >
          {currentPath || '服务端当前目录'}
        </span>
        {parent && (
          <Button
            variant="ghost"
            className="h-7 shrink-0 px-2 text-[12px]"
            disabled={loading}
            onClick={() => goTo(parent)}
          >
            上级目录
          </Button>
        )}
      </div>

      <div className="h-[280px] overflow-y-auto rounded-lg border border-border bg-panel-bg">
        {loading && (
          <div className="px-3 py-3 text-[12px] text-text-muted">读取中…</div>
        )}
        {!loading && errorMessage && (
          <div className="flex flex-col items-start gap-2 px-3 py-3">
            <span className="text-[12px] text-danger">{errorMessage}</span>
            {/* 起始路径可能来自用户手输的草稿，列不出来时给一条回到服务端当前目录的退路。 */}
            <Button
              variant="ghost"
              className="h-7 px-2 text-[12px]"
              onClick={() => goTo('')}
            >
              从服务端当前目录开始
            </Button>
          </div>
        )}
        {!loading && !errorMessage && listing?.entries.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-text-muted">
            没有子目录
          </div>
        )}
        {!loading &&
          !errorMessage &&
          listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-muted"
              title={entry.path}
              onClick={() => goTo(entry.path)}
            >
              <Icon
                name="folder"
                size={13}
                className="shrink-0 text-text-muted"
              />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          ))}
        {!loading && !errorMessage && listing?.truncated && (
          <div className="px-3 py-2 text-[11px] text-text-muted">
            目录过多，列表已截断
          </div>
        )}
      </div>

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
          disabled={loading || listing === null}
          onClick={() => {
            if (!listing) return
            onSelect(listing.path)
          }}
        >
          选择此文件夹
        </Button>
      </div>
    </Modal>
  )
}

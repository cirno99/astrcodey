import { useMemo, useState } from 'react'
import { Button, Dropdown, IconButton } from '../ui'
import { ProjectFolderPicker } from './ProjectFolderPicker'
import {
  forgetProjectPath,
  mergeProjectPathCandidates,
  readIgnoredProjectPaths,
  readProjectPathHistory,
} from './projectPathHistory'

interface ProjectPathFieldProps {
  /** 输入框当前值。 */
  value: string
  /** 值变化回调：输入、选中候选、文件夹选择器回填都会触发。 */
  onChange: (value: string) => void
  /** 未填路径时的默认值，也是文件夹选择器的初始路径。 */
  defaultWorkingDir: string
  /** 历史之外的路径候选，由页面从会话列表推导。 */
  extraPathCandidates?: string[]
  /** 请求进行中时禁用输入与文件夹按钮。 */
  disabled?: boolean
  /** 文件夹选择器的打开状态，供外层弹窗协调 Esc（避免一次 Esc 关掉两层弹窗）。 */
  onPickerOpenChange?: (open: boolean) => void
}

/**
 * 项目路径输入：候选下拉 + 文件夹选择器。
 *
 * 看板新建卡片与会话新建项目共用同一套交互：候选由历史、默认目录与会话目录合并而来，
 * 任何候选都能删除（记进忽略集合），也能打开服务端目录选择器挑选文件夹。
 */
export function ProjectPathField({
  value,
  onChange,
  defaultWorkingDir,
  extraPathCandidates = [],
  disabled = false,
  onPickerOpenChange,
}: ProjectPathFieldProps) {
  const [pathHistory, setPathHistory] = useState<string[]>(() =>
    readProjectPathHistory()
  )
  /** 被用户删掉的候选；候选是多个来源的并集，只清历史挡不住会话目录。 */
  const [ignoredPaths, setIgnoredPaths] = useState<string[]>(() =>
    readIgnoredProjectPaths()
  )
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  /** 文件夹选择器是否打开；选择器自己会列举目录，这里只负责显示与回填。 */
  const [pickerOpen, setPickerOpen] = useState(false)

  const pathCandidates = useMemo(
    () =>
      mergeProjectPathCandidates(
        pathHistory,
        [defaultWorkingDir, ...extraPathCandidates],
        ignoredPaths
      ),
    [defaultWorkingDir, extraPathCandidates, ignoredPaths, pathHistory]
  )

  const openPicker = () => {
    setPathMenuOpen(false)
    setPickerOpen(true)
    onPickerOpenChange?.(true)
  }

  const closePicker = () => {
    setPickerOpen(false)
    onPickerOpenChange?.(false)
  }

  return (
    <>
      <Dropdown
        open={pathMenuOpen && pathCandidates.length > 0}
        onClose={() => setPathMenuOpen(false)}
        align="left"
        label="项目路径候选"
        className="max-h-[240px] w-full min-w-full max-w-none overflow-y-auto"
        trigger={
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-border bg-panel-bg px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={
                defaultWorkingDir ? `默认：${defaultWorkingDir}` : '项目路径'
              }
              value={value}
              disabled={disabled}
              onChange={(event) => {
                onChange(event.target.value)
                setPathMenuOpen(true)
              }}
              onClick={() => setPathMenuOpen(true)}
              onFocus={() => setPathMenuOpen(true)}
            />
            {/* 浏览器拿不到本机绝对路径，所以选择器由前端自绘。 */}
            <Button
              variant="ghost"
              className="h-9 shrink-0 px-3 text-[13px]"
              disabled={disabled}
              onClick={openPicker}
            >
              选择文件夹
            </Button>
          </div>
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
                onChange(dir)
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

      {pickerOpen && (
        <ProjectFolderPicker
          initialPath={value.trim() || defaultWorkingDir}
          onSelect={(path) => {
            onChange(path)
            closePicker()
          }}
          onClose={closePicker}
        />
      )}
    </>
  )
}

import { lazy, Suspense, useEffect, useState } from 'react'
import { useAppStore } from './store/conversation'
import Sidebar from './components/Sidebar/Sidebar'
import ChatView from './components/Chat/ChatView'
import ConnectingScreen from './components/ConnectingScreen'
import ErrorBoundary from './components/ErrorBoundary'
import TransientHintDialog from './components/TransientHintDialog'
import { useSidebarResize } from './hooks/useSidebarResize'

const PluginsPage = lazy(() => import('./components/Plugins/PluginsPage'))
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'))
const KanbanPage = lazy(() => import('./components/Kanban/KanbanPage'))

export type MainView = 'chat' | 'plugins' | 'settings' | 'kanban'

function DeferredViewFallback() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-panel-bg text-[13px] text-text-muted">
      正在加载…
    </div>
  )
}

export default function App() {
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const initServer = useAppStore((s) => s.initServer)
  const kanbanExtensionAvailable = useAppStore(
    (s) => s.kanbanExtensionAvailable
  )
  const [mainView, setMainView] = useState<MainView>('chat')
  /**
   * 会话视图的后退目标。
   *
   * 只有「从看板点卡片跳进会话」会留下来路，它决定顶栏是否出现后退按钮；其余入口
   * （侧边栏切会话、切插件/设置）都必须清掉它，否则会留下指向打不开的视图的死按钮。
   */
  const [chatBackView, setChatBackView] = useState<MainView | null>(null)

  const openView = (view: MainView) => {
    setChatBackView(null)
    setMainView(view)
  }

  const openConversationFromKanban = () => {
    setChatBackView('kanban')
    setMainView('chat')
  }

  const { width, isOpen, toggle, onResizeStart, isResizing } =
    useSidebarResize()

  useEffect(() => {
    void initServer()
  }, [initServer])

  // 看板页随看板插件启用状态显示或隐藏；插件不可用时不能停留在该视图。
  const activeView: MainView =
    mainView === 'kanban' && kanbanExtensionAvailable !== true
      ? 'chat'
      : mainView

  // 看板插件被禁用时来路失效：不显示后退按钮，免得跳回一个已被隐藏的视图。
  const backToKanban =
    chatBackView === 'kanban' && kanbanExtensionAvailable === true

  if (connectionStatus !== 'connected') {
    return <ConnectingScreen />
  }

  return (
    <ErrorBoundary>
      <div
        className={`flex h-full min-h-0 overflow-hidden bg-app-bg text-text-primary${isResizing ? ' select-none' : ''}`}
      >
        {isOpen && (
          <button
            type="button"
            aria-label="关闭边栏"
            className="fixed inset-0 z-30 bg-overlay-backdrop md:hidden"
            onClick={toggle}
          />
        )}
        {isOpen && (
          <div
            className="fixed inset-y-0 left-0 z-40 min-h-0 min-w-0 flex-none shadow-surface-lg md:static md:z-auto md:shadow-none"
            style={{ width, maxWidth: 'calc(100vw - 64px)' }}
          >
            <Sidebar
              activeView={activeView}
              onToggleSidebar={toggle}
              onOpenChat={() => openView('chat')}
              onOpenPlugins={() => openView('plugins')}
              onOpenKanban={() => openView('kanban')}
              onOpenSettings={() => openView('settings')}
            />
          </div>
        )}
        {isOpen && (
          <div
            className={`relative z-10 hidden w-px flex-none cursor-col-resize bg-border transition-colors duration-100 hover:bg-border-strong md:block ${isResizing ? 'bg-border-strong' : ''}`}
            onPointerDown={onResizeStart}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Suspense fallback={<DeferredViewFallback />}>
            {activeView === 'plugins' && (
              <PluginsPage
                isSidebarOpen={isOpen}
                onToggleSidebar={toggle}
                onOpenSettings={() => openView('settings')}
              />
            )}
            {activeView === 'settings' && (
              <SettingsPage
                isSidebarOpen={isOpen}
                onToggleSidebar={toggle}
                onOpenPlugins={() => openView('plugins')}
              />
            )}
            {activeView === 'chat' && (
              <ChatView
                isSidebarOpen={isOpen}
                onToggleSidebar={toggle}
                onBack={backToKanban ? () => openView('kanban') : undefined}
              />
            )}
            {activeView === 'kanban' && (
              <KanbanPage
                isSidebarOpen={isOpen}
                onToggleSidebar={toggle}
                onOpenChat={openConversationFromKanban}
              />
            )}
          </Suspense>
          <TransientHintDialog />
        </div>
      </div>
    </ErrorBoundary>
  )
}

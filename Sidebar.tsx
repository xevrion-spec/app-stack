import { NAV_ITEMS, type ViewId } from '@/types/navigation';
import {
  Bot,
  ChevronLeft,
  Settings,
  Home,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

interface SidebarProps {
  current: ViewId;
  onNavigate: (view: ViewId) => void;
}

export default function Sidebar({ current, onNavigate }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`${
        collapsed ? 'w-16' : 'w-64'
      } shrink-0 glass border-r border-white/[0.06] flex flex-col transition-all duration-300 ease-out`}
    >
      {/* Logo */}
      <div className="h-16 flex items-center gap-3 px-4 border-b border-white/[0.04]">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center shadow-glow-sm shrink-0">
          <Bot className="w-5 h-5 text-white" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden animate-slide-in">
            <p className="text-sm font-semibold text-white leading-tight">AI Workspace</p>
            <p className="text-xs text-gray-500 leading-tight">Control Center</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2.5 py-4 space-y-1">
        <button
          onClick={() => onNavigate('landing')}
          className={`nav-item w-full ${
            current === 'landing' ? 'nav-item-active' : ''
          }`}
          title="Marketing Landing Page"
        >
          <Home className="w-4.5 h-4.5 shrink-0" />
          {!collapsed && <span>Landing Page</span>}
        </button>

        <div className="px-3.5 pt-4 pb-2">
          {!collapsed && (
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              Workspaces
            </span>
          )}
        </div>

        {NAV_ITEMS.map((item) => {
          const Icon: LucideIcon = item.icon;
          const active = current === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`nav-item w-full ${active ? 'nav-item-active' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="w-4.5 h-4.5 shrink-0" />
              {!collapsed && (
                <div className="flex flex-col text-left animate-slide-in">
                  <span>{item.label}</span>
                  <span className="text-[11px] text-gray-600 font-normal">
                    {item.description}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-2.5 py-3 border-t border-white/[0.04] space-y-1">
        <button className="nav-item w-full" title="Settings">
          <Settings className="w-4.5 h-4.5 shrink-0" />
          {!collapsed && <span>Settings</span>}
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="nav-item w-full"
          title="Collapse sidebar"
        >
          <ChevronLeft
            className={`w-4.5 h-4.5 shrink-0 transition-transform ${
              collapsed ? 'rotate-180' : ''
            }`}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

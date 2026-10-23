import { useState } from 'react';
import Sidebar from '@/components/Sidebar';
import LandingPage from '@/views/LandingPage';
import ChatEngineWorkspace from '@/views/ChatEngineWorkspace';
import ScrapingConsole from '@/views/ScrapingConsole';
import AgentTeamHub from '@/views/AgentTeamHub';
import PerformanceAnalytics from '@/views/PerformanceAnalytics';
import type { ViewId } from '@/types/navigation';

export default function App() {
  const [view, setView] = useState<ViewId>('landing');

  const navigate = (v: ViewId) => setView(v);

  return (
    <div className="h-screen flex overflow-hidden bg-ink-950">
      {view !== 'landing' && <Sidebar current={view} onNavigate={navigate} />}
      <main className="flex-1 overflow-hidden">
        {view === 'landing' && <LandingPage onNavigate={navigate} />}
        {view === 'chat' && <ChatEngineWorkspace />}
        {view === 'scraping' && <ScrapingConsole />}
        {view === 'agents' && <AgentTeamHub />}
        {view === 'analytics' && <PerformanceAnalytics />}
      </main>
    </div>
  );
}

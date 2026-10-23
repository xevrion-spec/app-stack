import { useState, useRef, useEffect } from 'react';
import {
  Globe,
  Play,
  Square,
  Settings2,
  Chrome,
  Terminal,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  RefreshCw,
  CircleDot,
} from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

const SAMPLE_LOGS: LogEntry[] = [
  { id: 'l1', timestamp: '00:00.12', level: 'info', message: 'Launching Steel Browser session (headless)' },
  { id: 'l2', timestamp: '00:00.34', level: 'info', message: 'Navigating to https://example.com' },
  { id: 'l3', timestamp: '00:01.02', level: 'info', message: 'Crawl4AI: extracting text content' },
  { id: 'l4', timestamp: '00:01.45', level: 'success', message: 'Extracted 1,247 tokens from page body' },
  { id: 'l5', timestamp: '00:01.47', level: 'info', message: 'Crawling pagination: page 2 of 5' },
  { id: 'l6', timestamp: '00:02.31', level: 'warn', message: 'Rate limit reached — backing off 2.5s' },
  { id: 'l7', timestamp: '00:04.82', level: 'info', message: 'Resuming crawl' },
  { id: 'l8', timestamp: '00:05.10', level: 'success', message: 'Crawl complete: 5 pages, 6,210 tokens' },
];

const LEVEL_STYLES: Record<LogEntry['level'], string> = {
  info: 'text-accent-400',
  warn: 'text-amber2-400',
  error: 'text-rose2-400',
  success: 'text-emerald2-400',
};

export default function ScrapingConsole() {
  const [url, setUrl] = useState('https://example.com');
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [strategy, setStrategy] = useState('crawl4ai');
  const [browserMode, setBrowserMode] = useState('headless');
  const [maxPages, setMaxPages] = useState('5');
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running && logs.length === 0) {
      let idx = 0;
      const interval = setInterval(() => {
        if (idx < SAMPLE_LOGS.length) {
          setLogs((l) => [...l, SAMPLE_LOGS[idx]]);
          idx++;
        } else {
          clearInterval(interval);
          setRunning(false);
        }
      }, 350);
      return () => clearInterval(interval);
    }
  }, [running, logs.length]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight, behavior: 'smooth' });
  }, [logs]);

  const startCrawl = () => {
    setLogs([]);
    setRunning(true);
  };

  const stopCrawl = () => {
    setRunning(false);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 flex items-center gap-3 px-5 border-b border-white/[0.05] bg-ink-900/50">
        <Globe className="w-4.5 h-4.5 text-emerald2-400" />
        <h2 className="text-sm font-semibold text-white">Web Scraping &amp; Browser Console</h2>
        <span className="badge bg-emerald2-500/10 text-emerald2-400 border border-emerald2-500/20">
          {running ? (
            <>
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> Running
            </>
          ) : (
            <>
              <CheckCircle2 className="w-2.5 h-2.5" /> Idle
            </>
          )}
        </span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ── Config panel ── */}
        <div className="w-72 shrink-0 border-r border-white/[0.05] bg-ink-900/40 overflow-y-auto">
          <div className="p-5 space-y-5">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Target URL
              </label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="input-dark w-full"
                placeholder="https://example.com"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Scraping Strategy
              </label>
              <div className="space-y-1.5">
                {[
                  { id: 'crawl4ai', label: 'Crawl4AI (LLM-extract)' },
                  { id: 'steel', label: 'Steel Browser (DOM)' },
                  { id: 'hybrid', label: 'Hybrid (Crawl4AI + Steel)' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setStrategy(opt.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all ${
                      strategy === opt.id
                        ? 'bg-accent-500/10 border border-accent-500/30 text-white'
                        : 'border border-transparent text-gray-400 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                        strategy === opt.id ? 'border-accent-400 bg-accent-500' : 'border-gray-600'
                      }`}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Browser Mode
              </label>
              <div className="grid grid-cols-2 gap-2">
                {['headless', 'headed'].map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setBrowserMode(mode)}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium capitalize transition-all ${
                      browserMode === mode
                        ? 'bg-accent-500/10 border border-accent-500/30 text-white'
                        : 'border border-white/[0.06] text-gray-400 hover:bg-white/[0.04]'
                    }`}
                  >
                    <Chrome className="w-3.5 h-3.5" />
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Max Pages
              </label>
              <input
                value={maxPages}
                onChange={(e) => setMaxPages(e.target.value)}
                className="input-dark w-full"
                type="number"
                min={1}
                max={100}
              />
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-gray-400">JavaScript Rendering</span>
              <button
                onClick={(e) => {
                  const btn = e.currentTarget;
                  btn.dataset.on = btn.dataset.on === 'true' ? 'false' : 'true';
                }}
                data-on="true"
                className="relative w-10 h-5 rounded-full bg-accent-500/30 data-[on=true]:bg-accent-500 transition-colors"
              >
                <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform data-[on=true]:translate-x-5" />
              </button>
            </div>

            <div className="pt-2 border-t border-white/[0.04] space-y-2">
              {running ? (
                <button
                  onClick={stopCrawl}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-rose2-500/15 border border-rose2-500/30 text-rose2-400 hover:bg-rose2-500/25 transition-all text-sm font-medium"
                >
                  <Square className="w-4 h-4" /> Stop Crawl
                </button>
              ) : (
                <button
                  onClick={startCrawl}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald2-500/15 border border-emerald2-500/30 text-emerald2-400 hover:bg-emerald2-500/25 transition-all text-sm font-medium"
                >
                  <Play className="w-4 h-4" /> Start Crawl
                </button>
              )}
              <button className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-all text-sm">
                <Settings2 className="w-4 h-4" /> Advanced Settings
              </button>
            </div>
          </div>
        </div>

        {/* ── Console + results ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Console output */}
          <div className="flex-1 flex flex-col p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-white">Console Output</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={startCrawl}
                  disabled={running}
                  className="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-white/[0.05] transition-all disabled:opacity-40"
                  title="Re-run"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={clearLogs}
                  className="p-1.5 rounded text-gray-500 hover:text-rose2-400 hover:bg-white/[0.05] transition-all"
                  title="Clear logs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div
              ref={consoleRef}
              className="flex-1 glass-card overflow-y-auto font-mono text-xs p-4"
            >
              {logs.length === 0 && !running ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-600">
                  <Terminal className="w-8 h-8 mb-3 opacity-40" />
                  <p>Console is idle. Start a crawl to see live output.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log) => {
                    const Icon =
                      log.level === 'success'
                        ? CheckCircle2
                        : log.level === 'error'
                        ? AlertCircle
                        : log.level === 'warn'
                        ? AlertCircle
                        : CircleDot;
                    const LIcon = Icon as typeof Terminal;
                    return (
                      <div key={log.id} className="flex items-start gap-2 animate-fade-in">
                        <span className="text-gray-600 shrink-0 select-none">
                          [{log.timestamp}]
                        </span>
                        <LIcon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${LEVEL_STYLES[log.level]}`} />
                        <span className={LEVEL_STYLES[log.level]}>{log.message}</span>
                      </div>
                    );
                  })}
                  {running && (
                    <div className="flex items-center gap-2 text-gray-500">
                      <span className="w-2 h-4 bg-emerald2-400 animate-blink" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Results strip */}
          <div className="px-5 pb-5 grid grid-cols-4 gap-3">
            {[
              { label: 'Pages Crawled', value: logs.filter((l) => l.level === 'success' && l.message.includes('Crawl complete')).length > 0 ? '5' : running ? '...' : '0', color: 'text-white' },
              { label: 'Tokens Extracted', value: logs.some((l) => l.message.includes('6,210')) ? '6,210' : running ? '...' : '0', color: 'text-emerald2-400' },
              { label: 'Errors', value: logs.filter((l) => l.level === 'error').length.toString(), color: 'text-rose2-400' },
              { label: 'Duration', value: logs.some((l) => l.message.includes('Crawl complete')) ? '5.10s' : running ? '...' : '—', color: 'text-accent-400' },
            ].map((stat) => (
              <div key={stat.label} className="glass-card p-4">
                <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
                <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}



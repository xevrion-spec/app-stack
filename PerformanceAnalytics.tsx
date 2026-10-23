import { useState } from 'react';
import {
  LineChart as LineChartIcon,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Clock,
  Gauge,
  Activity,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

// ── Sparkline (pure SVG, no deps) ──
function Sparkline({
  data,
  color,
  height = 40,
  width = 120,
}: {
  data: number[];
  color: string;
  height?: number;
  width?: number;
}) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${height - ((v - min) / range) * height * 0.85 - 4}`);
  const path = `M ${points.join(' L ')}`;
  const areaPath = `${path} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`grad-${color}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#grad-${color})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={height - ((data[data.length - 1] - min) / range) * height * 0.85 - 4} r="3" fill={color} />
    </svg>
  );
}

// ── Bar chart ──
function BarChart({ data, labels }: { data: number[]; labels: string[] }) {
  const max = Math.max(...data);
  return (
    <div className="flex items-end justify-between gap-2 h-32">
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-2">
          <div className="w-full flex-1 flex items-end">
            <div
              className="w-full rounded-t bg-gradient-to-t from-accent-700 to-accent-400 transition-all duration-500 hover:from-accent-600 hover:to-accent-300 group relative"
              style={{ height: `${(v / max) * 100}%` }}
            >
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">
                {v}
              </span>
            </div>
          </div>
          <span className="text-[10px] text-gray-600">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

const STATS = [
  {
    label: 'Total Requests',
    value: '12,847',
    delta: '+18.2%',
    up: true,
    color: '#4a8cff',
    icon: Activity,
    spark: [30, 45, 38, 52, 48, 62, 70, 68, 82, 90],
  },
  {
    label: 'Avg Latency',
    value: '1.24s',
    delta: '-12.4%',
    up: true,
    color: '#34d399',
    icon: Clock,
    spark: [2.1, 1.9, 1.8, 1.6, 1.5, 1.4, 1.35, 1.3, 1.25, 1.24],
  },
  {
    label: 'Token Cost',
    value: '$842.50',
    delta: '+5.1%',
    up: false,
    color: '#fbbf24',
    icon: DollarSign,
    spark: [60, 65, 70, 68, 75, 72, 80, 78, 84, 84],
  },
  {
    label: 'Success Rate',
    value: '97.3%',
    delta: '+0.8%',
    up: true,
    color: '#fb7185',
    icon: Gauge,
    spark: [94, 95, 95, 96, 96, 96, 97, 97, 97, 97],
  },
];

const TRACES = [
  { name: 'chat-engine', model: 'gpt-4o', tokens: 1240, latency: '1.8s', status: 'success', cost: '$0.043' },
  { name: 'scrape-pipeline', model: 'claude-3.5', tokens: 820, latency: '0.9s', status: 'success', cost: '$0.021' },
  { name: 'crew-writer', model: 'gpt-4o', tokens: 2100, latency: '2.4s', status: 'success', cost: '$0.072' },
  { name: 'crew-reviewer', model: 'gpt-4o', tokens: 1850, latency: '2.1s', status: 'success', cost: '$0.061' },
  { name: 'crew-publisher', model: 'gpt-4o-mini', tokens: 340, latency: '0.5s', status: 'error', cost: '$0.003' },
  { name: 'scrape-batch-2', model: 'claude-3.5', tokens: 1620, latency: '1.2s', status: 'success', cost: '$0.039' },
  { name: 'chat-engine', model: 'gpt-4o', tokens: 980, latency: '1.6s', status: 'success', cost: '$0.031' },
];

export default function PerformanceAnalytics() {
  const [range, setRange] = useState('7d');

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-5 border-b border-white/[0.05] bg-ink-900/50 sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <LineChartIcon className="w-4.5 h-4.5 text-rose2-400" />
          <h2 className="text-sm font-semibold text-white">Performance Analytics</h2>
          <span className="text-xs text-gray-500">·</span>
          <span className="text-xs text-gray-400">Langfuse Metrics</span>
        </div>
        <div className="flex rounded-lg bg-ink-800/60 border border-white/[0.06] p-0.5">
          {['24h', '7d', '30d', '90d'].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                range === r ? 'bg-accent-500/20 text-accent-300' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* ── Stat cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STATS.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="glass-card p-5 hover:border-white/[0.1] transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
                    <p className="text-2xl font-bold text-white">{stat.value}</p>
                  </div>
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${stat.color}15`, border: `1px solid ${stat.color}30` }}
                  >
                    <Icon className="w-4.5 h-4.5" style={{ color: stat.color }} />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    className={`flex items-center gap-1 text-xs font-medium ${
                      stat.up ? 'text-emerald2-400' : 'text-rose2-400'
                    }`}
                  >
                    {stat.up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                    {stat.delta}
                  </span>
                  <Sparkline data={stat.spark} color={stat.color} width={100} height={32} />
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Charts row ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Token usage bar chart */}
          <div className="glass-card p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-semibold text-white">Token Usage by Day</h3>
                <p className="text-xs text-gray-500 mt-0.5">Prompt + completion tokens</p>
              </div>
              <span className="badge bg-accent-500/10 text-accent-300 border border-accent-500/20">
                Last 7 days
              </span>
            </div>
            <BarChart
              data={[4200, 5100, 3800, 6200, 7100, 5900, 8400]}
              labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}
            />
          </div>

          {/* Model distribution */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-semibold text-white mb-1">Model Distribution</h3>
            <p className="text-xs text-gray-500 mb-5">Share of total requests</p>
            <div className="space-y-3.5">
              {[
                { name: 'gpt-4o', pct: 42, color: '#4a8cff' },
                { name: 'claude-3.5-sonnet', pct: 28, color: '#34d399' },
                { name: 'gpt-4o-mini', pct: 18, color: '#fbbf24' },
                { name: 'llama-3.1-70b', pct: 12, color: '#fb7185' },
              ].map((m) => (
                <div key={m.name}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-gray-300">{m.name}</span>
                    <span className="text-gray-500">{m.pct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-ink-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${m.pct}%`, backgroundColor: m.color }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Latency area chart (pure SVG) ── */}
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-sm font-semibold text-white">Latency Over Time</h3>
              <p className="text-xs text-gray-500 mt-0.5">P50, P95, and P99 response times</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-accent-400">
                <span className="w-2 h-2 rounded-full bg-accent-400" /> P50
              </span>
              <span className="flex items-center gap-1.5 text-amber2-400">
                <span className="w-2 h-2 rounded-full bg-amber2-400" /> P95
              </span>
              <span className="flex items-center gap-1.5 text-rose2-400">
                <span className="w-2 h-2 rounded-full bg-rose2-400" /> P99
              </span>
            </div>
          </div>
          <svg viewBox="0 0 600 160" className="w-full h-40">
            {/* Grid lines */}
            {[0, 40, 80, 120, 160].map((y) => (
              <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
            ))}
            {/* P50 */}
            <path
              d="M 0,120 L 60,110 L 120,115 L 180,100 L 240,105 L 300,90 L 360,95 L 420,80 L 480,85 L 540,75 L 600,70"
              fill="none"
              stroke="#4a8cff"
              strokeWidth="2"
            />
            {/* P95 */}
            <path
              d="M 0,80 L 60,70 L 120,75 L 180,55 L 240,60 L 300,45 L 360,50 L 420,35 L 480,40 L 540,30 L 600,25"
              fill="none"
              stroke="#fbbf24"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
            {/* P99 */}
            <path
              d="M 0,50 L 60,40 L 120,45 L 180,25 L 240,30 L 300,15 L 360,20 L 420,5 L 480,10 L 540,0 L 600,-5"
              fill="none"
              stroke="#fb7185"
              strokeWidth="2"
              strokeDasharray="6 3"
            />
          </svg>
        </div>

        {/* ── Trace table ── */}
        <div className="glass-card overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.05]">
            <h3 className="text-sm font-semibold text-white">Recent Traces</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-5 py-2.5 font-semibold">Name</th>
                  <th className="text-left px-5 py-2.5 font-semibold">Model</th>
                  <th className="text-right px-5 py-2.5 font-semibold">Tokens</th>
                  <th className="text-right px-5 py-2.5 font-semibold">Latency</th>
                  <th className="text-right px-5 py-2.5 font-semibold">Cost</th>
                  <th className="text-center px-5 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {TRACES.map((trace, i) => (
                  <tr
                    key={i}
                    className="border-t border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-5 py-3 text-gray-300 font-mono text-xs">{trace.name}</td>
                    <td className="px-5 py-3 text-gray-400">{trace.model}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{trace.tokens.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-400">{trace.latency}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{trace.cost}</td>
                    <td className="px-5 py-3 text-center">
                      {trace.status === 'success' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald2-400 inline" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose2-400 inline" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

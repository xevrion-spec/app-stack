import { useState } from 'react';
import {
  Users,
  Plus,
  Bot,
  Link2,
  Play,
  Settings,
  Trash2,
  Workflow,
  Zap,
  Eye,
  Code2,
} from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  role: string;
  goal: string;
  model: string;
  x: number;
  y: number;
  color: string;
}

interface Connection {
  from: string;
  to: string;
}

const INITIAL_AGENTS: Agent[] = [
  {
    id: 'a1',
    name: 'Researcher',
    role: 'Research Analyst',
    goal: 'Gather and summarize source material',
    model: 'gpt-4o',
    x: 40,
    y: 60,
    color: 'accent',
  },
  {
    id: 'a2',
    name: 'Writer',
    role: 'Content Writer',
    goal: 'Draft article from research notes',
    model: 'claude-3.5-sonnet',
    x: 340,
    y: 30,
    color: 'emerald',
  },
  {
    id: 'a3',
    name: 'Reviewer',
    role: 'Editor',
    goal: 'Review, fact-check, and polish draft',
    model: 'gpt-4o',
    x: 340,
    y: 180,
    color: 'amber',
  },
  {
    id: 'a4',
    name: 'Publisher',
    role: 'Publishing Agent',
    goal: 'Format and publish the final article',
    model: 'gpt-4o-mini',
    x: 640,
    y: 105,
    color: 'rose',
  },
];

const INITIAL_CONNECTIONS: Connection[] = [
  { from: 'a1', to: 'a2' },
  { from: 'a1', to: 'a3' },
  { from: 'a2', to: 'a4' },
  { from: 'a3', to: 'a4' },
];

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  accent: { bg: 'bg-accent-500/10', border: 'border-accent-500/30', text: 'text-accent-400', glow: 'shadow-glow-sm' },
  emerald: { bg: 'bg-emerald2-500/10', border: 'border-emerald2-500/30', text: 'text-emerald2-400', glow: 'shadow-glow-emerald' },
  amber: { bg: 'bg-amber2-500/10', border: 'border-amber2-500/30', text: 'text-amber2-400', glow: 'shadow-glow-amber' },
  rose: { bg: 'bg-rose2-500/10', border: 'border-rose2-500/30', text: 'text-rose2-400', glow: 'shadow-glow-sm' },
};

const MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'llama-3.1-70b', 'mixtral-8x7b'];

export default function AgentTeamHub() {
  const [agents, setAgents] = useState<Agent[]>(INITIAL_AGENTS);
  const [connections] = useState<Connection[]>(INITIAL_CONNECTIONS);
  const [selected, setSelected] = useState<string | null>('a1');
  const [view, setView] = useState<'canvas' | 'code'>('canvas');

  const selectedAgent = agents.find((a) => a.id === selected) || null;

  const addAgent = () => {
    const colors = ['accent', 'emerald', 'amber', 'rose'];
    const newAgent: Agent = {
      id: `a${Date.now()}`,
      name: `Agent ${agents.length + 1}`,
      role: 'New Agent',
      goal: 'Define goal…',
      model: 'gpt-4o',
      x: 200 + Math.random() * 200,
      y: 100 + Math.random() * 100,
      color: colors[agents.length % colors.length],
    };
    setAgents((a) => [...a, newAgent]);
    setSelected(newAgent.id);
  };

  const deleteAgent = (id: string) => {
    setAgents((a) => a.filter((x) => x.id !== id));
    if (selected === id) setSelected(null);
  };

  const updateAgent = (id: string, field: keyof Agent, value: string) => {
    setAgents((a) => a.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
  };

  const getAgent = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-5 border-b border-white/[0.05] bg-ink-900/50">
        <div className="flex items-center gap-2.5">
          <Users className="w-4.5 h-4.5 text-amber2-400" />
          <h2 className="text-sm font-semibold text-white">Agent Team Hub</h2>
          <span className="text-xs text-gray-500">·</span>
          <span className="text-xs text-gray-400">CrewAI + Dify Canvas</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-ink-800/60 border border-white/[0.06] p-0.5">
            <button
              onClick={() => setView('canvas')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === 'canvas' ? 'bg-accent-500/20 text-accent-300' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Workflow className="w-3.5 h-3.5 inline mr-1" /> Canvas
            </button>
            <button
              onClick={() => setView('code')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === 'code' ? 'bg-accent-500/20 text-accent-300' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Code2 className="w-3.5 h-3.5 inline mr-1" /> Code
            </button>
          </div>
          <button className="btn-primary flex items-center gap-1.5 text-xs">
            <Play className="w-3.5 h-3.5" /> Run Crew
          </button>
        </div>
      </div>

      {view === 'canvas' ? (
        <div className="flex-1 flex overflow-hidden">
          {/* ── Canvas ── */}
          <div className="flex-1 relative overflow-auto bg-ink-950"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          >
            {/* SVG connections */}
            <svg className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }}>
              {connections.map((conn, i) => {
                const from = getAgent(conn.from);
                const to = getAgent(conn.to);
                if (!from || !to) return null;
                const x1 = from.x + 130;
                const y1 = from.y + 40;
                const x2 = to.x;
                const y2 = to.y + 40;
                const midX = (x1 + x2) / 2;
                return (
                  <g key={i}>
                    <path
                      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="rgba(37, 99, 235, 0.35)"
                      strokeWidth="2"
                      strokeDasharray="6 4"
                    />
                    <circle cx={x2} cy={y2} r="3" fill="#4a8cff" />
                  </g>
                );
              })}
            </svg>

            {/* Agent nodes */}
            {agents.map((agent) => {
              const c = COLOR_MAP[agent.color];
              const isSel = selected === agent.id;
              return (
                <div
                  key={agent.id}
                  onClick={() => setSelected(agent.id)}
                  style={{ left: agent.x, top: agent.y }}
                  className={`absolute w-[130px] glass-card p-3 cursor-pointer transition-all duration-200 hover:scale-[1.03] ${
                    isSel ? `${c.border} ${c.glow} ring-1 ring-white/10` : 'border-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-7 h-7 rounded-lg ${c.bg} border ${c.border} flex items-center justify-center`}>
                      <Bot className={`w-4 h-4 ${c.text}`} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">{agent.name}</p>
                      <p className="text-[10px] text-gray-500 truncate">{agent.role}</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-400 leading-snug line-clamp-2">{agent.goal}</p>
                  <div className="mt-2 flex items-center gap-1 text-[9px] text-gray-600">
                    <Zap className="w-2.5 h-2.5" />
                    <span className="truncate">{agent.model}</span>
                  </div>
                </div>
              );
            })}

            {/* Add button */}
            <button
              onClick={addAgent}
              className="absolute bottom-5 right-5 w-12 h-12 rounded-full bg-accent-500 hover:bg-accent-400 text-white flex items-center justify-center shadow-glow transition-all hover:scale-110"
              title="Add agent"
            >
              <Plus className="w-5 h-5" />
            </button>

            {/* Legend */}
            <div className="absolute bottom-5 left-5 glass-card px-3 py-2 flex items-center gap-3 text-[10px] text-gray-500">
              <span className="flex items-center gap-1">
                <Bot className="w-3 h-3" /> Agent
              </span>
              <span className="flex items-center gap-1">
                <Link2 className="w-3 h-3" /> Task flow
              </span>
            </div>
          </div>

          {/* ── Agent inspector ── */}
          <div className="w-72 shrink-0 border-l border-white/[0.05] bg-ink-900/40 overflow-y-auto">
            {selectedAgent ? (
              <div className="p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Agent Config</h3>
                  <button
                    onClick={() => deleteAgent(selectedAgent.id)}
                    className="p-1.5 rounded text-gray-500 hover:text-rose2-400 hover:bg-rose2-500/10 transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Name
                  </label>
                  <input
                    value={selectedAgent.name}
                    onChange={(e) => updateAgent(selectedAgent.id, 'name', e.target.value)}
                    className="input-dark w-full"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Role
                  </label>
                  <input
                    value={selectedAgent.role}
                    onChange={(e) => updateAgent(selectedAgent.id, 'role', e.target.value)}
                    className="input-dark w-full"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Goal
                  </label>
                  <textarea
                    value={selectedAgent.goal}
                    onChange={(e) => updateAgent(selectedAgent.id, 'goal', e.target.value)}
                    rows={3}
                    className="input-dark w-full resize-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Model
                  </label>
                  <select
                    value={selectedAgent.model}
                    onChange={(e) => updateAgent(selectedAgent.id, 'model', e.target.value)}
                    className="input-dark w-full"
                  >
                    {MODELS.map((m) => (
                      <option key={m} value={m} className="bg-ink-800">
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Color
                  </label>
                  <div className="flex gap-2">
                    {Object.keys(COLOR_MAP).map((c) => (
                      <button
                        key={c}
                        onClick={() => updateAgent(selectedAgent.id, 'color', c)}
                        className={`w-7 h-7 rounded-lg border-2 transition-all ${
                          selectedAgent.color === c ? 'scale-110' : 'opacity-60'
                        } ${
                          c === 'accent' ? 'bg-accent-500 border-accent-400' :
                          c === 'emerald' ? 'bg-emerald2-500 border-emerald2-400' :
                          c === 'amber' ? 'bg-amber2-500 border-amber2-400' :
                          'bg-rose2-500 border-rose2-400'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <div className="pt-3 border-t border-white/[0.04]">
                  <button className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-all text-sm">
                    <Settings className="w-4 h-4" /> Advanced Config
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 p-8 text-center">
                <Eye className="w-8 h-8 mb-3 opacity-40" />
                <p className="text-sm">Select an agent node to configure its role, goal, and model.</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Code view (Dify YAML) ── */
        <div className="flex-1 overflow-y-auto p-5">
          <div className="glass-card font-mono text-xs p-5 max-w-3xl mx-auto">
            <div className="text-gray-500 mb-3"># CrewAI crew definition (generated from canvas)</div>
            <pre className="text-gray-300 leading-relaxed whitespace-pre-wrap">{`crew:
  name: content_pipeline
  process: sequential

agents:
${agents
  .map(
    (a) => `  - name: ${a.name}
    role: ${a.role}
    goal: ${a.goal}
    llm: ${a.model}`
  )
  .join('\n\n')}

tasks:
${connections
  .map((c) => {
    const f = getAgent(c.from);
    const t = getAgent(c.to);
    return f && t
      ? `  - from: ${f.name}
    to: ${t.name}
    type: handoff`
      : '';
  })
  .join('\n')}

config:
  verbose: true
  max_iter: 25
  memory: true`}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

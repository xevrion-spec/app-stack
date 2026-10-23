import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Gauge,
  Globe,
  LineChart,
  MessageSquareText,
  Sparkles,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import type { ViewId } from '@/types/navigation';

interface LandingPageProps {
  onNavigate: (view: ViewId) => void;
}

const FEATURES = [
  {
    icon: MessageSquareText,
    title: 'Chat Engine Workspace',
    desc: 'Pair-program with AI in an Aider-style coding panel. Diff-based edits, repo context, and live file tracking.',
    color: 'text-accent-400',
    view: 'chat' as ViewId,
  },
  {
    icon: Globe,
    title: 'Web Scraping & Browser Console',
    desc: 'Configure Crawl4AI pipelines and Steel Browser sessions. Headless automation with real-time console output.',
    color: 'text-emerald2-400',
    view: 'scraping' as ViewId,
  },
  {
    icon: Users,
    title: 'Agent Team Hub',
    desc: 'Visual canvas for CrewAI crews and Dify workflows. Drag agents, wire tasks, and orchestrate multi-agent runs.',
    color: 'text-amber2-400',
    view: 'agents' as ViewId,
  },
  {
    icon: LineChart,
    title: 'Performance Analytics',
    desc: 'Langfuse-powered metrics mockups: token usage, latency traces, cost breakdowns, and eval dashboards.',
    color: 'text-rose2-400',
    view: 'analytics' as ViewId,
  },
];

const STACK = ['Crawl4AI', 'Steel Browser', 'CrewAI', 'Dify', 'Langfuse', 'Aider'];

const PRICING = [
  {
    name: 'Hacker',
    price: '$0',
    tagline: 'For solo builders',
    features: ['1 workspace', 'Chat engine access', 'Community support', '5 agent runs / day'],
    highlighted: false,
  },
  {
    name: 'Team',
    price: '$49',
    tagline: 'For growing teams',
    features: ['10 workspaces', 'All 4 panels unlocked', 'Priority support', 'Unlimited agent runs', 'Analytics dashboard'],
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    tagline: 'For org-wide deployment',
    features: ['Unlimited workspaces', 'SSO + RBAC', 'Dedicated infra', 'Custom integrations', 'SLA guarantee'],
    highlighted: false,
  },
];

export default function LandingPage({ onNavigate }: LandingPageProps) {
  return (
    <div className="min-h-full bg-ink-950">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-accent-500/[0.08] via-transparent to-transparent" />
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 30%, rgba(37,99,235,0.3) 0%, transparent 40%), radial-gradient(circle at 80% 60%, rgba(16,185,129,0.15) 0%, transparent 40%)',
          }}
        />
        <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 badge bg-accent-500/10 border border-accent-500/20 text-accent-300 mb-6 animate-fade-in">
            <Sparkles className="w-3.5 h-3.5" />
            <span>The all-in-one AI developer cockpit</span>
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-white leading-[1.1] animate-fade-in">
            Build, orchestrate &amp; measure
            <br />
            <span className="bg-gradient-to-r from-accent-400 via-accent-500 to-emerald2-500 bg-clip-text text-transparent">
              AI workflows
            </span>{' '}
            in one place
          </h1>
          <p className="mt-6 text-lg text-gray-400 max-w-2xl mx-auto animate-fade-in">
            A unified workspace for AI-assisted coding, web scraping, multi-agent orchestration,
            and production-grade observability — all behind a single, developer-grade dashboard.
          </p>
          <div className="mt-9 flex items-center justify-center gap-4 animate-fade-in">
            <button onClick={() => onNavigate('chat')} className="btn-primary flex items-center gap-2">
              Open Dashboard <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onNavigate('analytics')}
              className="btn-ghost flex items-center gap-2"
            >
              <Gauge className="w-4 h-4" /> View Metrics
            </button>
          </div>

          {/* Stack chips */}
          <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
            {STACK.map((s) => (
              <span
                key={s}
                className="badge bg-white/[0.04] border border-white/[0.06] text-gray-400"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Feature cards ── */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white">Four workspaces. One platform.</h2>
          <p className="mt-3 text-gray-400">Switch instantly between coding, scraping, agent orchestration, and observability.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.title}
                onClick={() => onNavigate(f.view)}
                className="group glass-card text-left p-6 hover:border-accent-500/30 hover:shadow-glow-sm transition-all duration-300"
              >
                <div className="flex items-start gap-4">
                  <div className="w-11 h-11 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform duration-300">
                    <Icon className={`w-5.5 h-5.5 ${f.color}`} />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-white font-semibold mb-1.5 group-hover:text-accent-300 transition-colors">
                      {f.title}
                    </h3>
                    <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
                    <span className="mt-3 inline-flex items-center gap-1 text-xs text-accent-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                      Open workspace <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="glass-card p-8">
          <h2 className="text-2xl font-bold text-white mb-6">How it works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              { icon: Terminal, title: '1. Configure', desc: 'Set up your scrapers, crews, and chat sessions with a few clicks.' },
              { icon: Zap, title: '2. Run', desc: 'Launch agents and jobs from any workspace with live console output.' },
              { icon: LineChart, title: '3. Observe', desc: 'Track costs, latency, and quality in the analytics dashboard.' },
            ].map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="flex flex-col gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent-500/10 border border-accent-500/20 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-accent-400" />
                  </div>
                  <h3 className="text-white font-semibold">{s.title}</h3>
                  <p className="text-sm text-gray-400 leading-relaxed">{s.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white">Simple pricing</h2>
          <p className="mt-3 text-gray-400">Start free. Scale when you need it.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PRICING.map((plan) => (
            <div
              key={plan.name}
              className={`glass-card p-7 flex flex-col ${
                plan.highlighted
                  ? 'border-accent-500/40 shadow-glow-sm ring-1 ring-accent-500/20'
                  : ''
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold text-lg">{plan.name}</h3>
                {plan.highlighted && (
                  <span className="badge bg-accent-500/15 text-accent-300 border border-accent-500/30">
                    Popular
                  </span>
                )}
              </div>
              <div className="mb-1">
                <span className="text-3xl font-bold text-white">{plan.price}</span>
                {plan.price !== 'Custom' && <span className="text-gray-500"> /mo</span>}
              </div>
              <p className="text-sm text-gray-500 mb-5">{plan.tagline}</p>
              <ul className="space-y-2.5 mb-6">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-center gap-2.5 text-sm text-gray-300">
                    <Check className="w-4 h-4 text-emerald2-400 shrink-0" />
                    {feat}
                  </li>
                ))}
              </ul>
              <button
                className={`mt-auto ${plan.highlighted ? 'btn-primary' : 'btn-ghost border border-white/[0.08]'}`}
              >
                Get started
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA strip ── */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <div className="glass-card p-8 flex flex-col sm:flex-row items-center justify-between gap-5">
          <div className="flex items-center gap-3">
            <Code2 className="w-6 h-6 text-accent-400" />
            <div>
              <p className="text-white font-semibold">Ready to ship faster?</p>
              <p className="text-sm text-gray-400">Launch your first AI workspace in under a minute.</p>
            </div>
          </div>
          <button onClick={() => onNavigate('chat')} className="btn-primary flex items-center gap-2 shrink-0">
            Launch Dashboard <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.04] py-8">
        <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Bot className="w-4 h-4" />
            <span>AI Workspace — © 2026</span>
          </div>
          <div className="flex items-center gap-5 text-sm text-gray-500">
            <a className="hover:text-gray-300 cursor-pointer transition-colors">Docs</a>
            <a className="hover:text-gray-300 cursor-pointer transition-colors">Privacy</a>
            <a className="hover:text-gray-300 cursor-pointer transition-colors">GitHub</a>
          </div>
        </div>
      </footer>

      {/* ────────────────────────────────────────────────────────── */}
      {/* Kapa AI support chat widget — placeholder slot                 */}
      {/* Paste the Kapa embed script snippet below to render the        */}
      {/* floating chat bubble on the bottom-right of the page.          */}
      {/* ────────────────────────────────────────────────────────── */}
      <div id="kapa-ai-widget-placeholder" className="contents" />
      {/* TODO: Embed Kapa AI support chat widget here, e.g.:           */}
      {/*   <script dangerouslySetInnerHTML={{ __html: kapaSnippet }} /> */}
      {/* ────────────────────────────────────────────────────────── */}
    </div>
  );
}

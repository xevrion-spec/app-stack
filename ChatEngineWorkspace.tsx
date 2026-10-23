import { useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  GitBranch,
  FileCode2,
  Plus,
  Check,
  X,
  Loader2,
  Terminal,
  CircleDot,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  diff?: FileChange[];
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted';
  lines: { type: 'add' | 'remove' | 'context'; text: string }[];
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    content:
      "Welcome to the Chat Engine Workspace — an Aider-style coding panel. I can read your repo, propose edits, and show you diffs before applying changes. What would you like to work on?",
  },
];

const SAMPLE_DIFF: FileChange[] = [
  {
    filename: 'src/api/handler.ts',
    status: 'modified',
    lines: [
      { type: 'context', text: 'export async function handleRequest(req: Request) {' },
      { type: 'remove', text: '  const data = await req.json();' },
      { type: 'remove', text: '  return Response.json(data);' },
      { type: 'add', text: '  const data = await req.json();' },
      { type: 'add', text: '  const validated = validateSchema(data, schema);' },
      { type: 'add', text: '  if (!validated.ok) {' },
      { type: 'add', text: '    return Response.json({ error: validated.error }, { status: 400 });' },
      { type: 'add', text: '  }' },
      { type: 'add', text: '  return Response.json(validated.data);' },
      { type: 'context', text: '}' },
    ],
  },
];

const REPO_FILES = [
  'src/api/handler.ts',
  'src/api/router.ts',
  'src/lib/db.ts',
  'src/index.ts',
  'package.json',
  'README.md',
];

export default function ChatEngineWorkspace() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>(['src/api/handler.ts']);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  const send = () => {
    if (!input.trim() || thinking) return;
    const userMsg: ChatMessage = {
      id: `u${Date.now()}`,
      role: 'user',
      content: input,
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setThinking(true);

    setTimeout(() => {
      const reply: ChatMessage = {
        id: `a${Date.now()}`,
        role: 'assistant',
        content:
          "I've analyzed the request and prepared a diff. Review the proposed changes below — I'll add input validation to the request handler before passing data downstream.",
        diff: SAMPLE_DIFF,
      };
      setMessages((m) => [...m, reply]);
      setThinking(false);
    }, 1400);
  };

  const toggleFile = (file: string) => {
    setSelectedFiles((f) =>
      f.includes(file) ? f.filter((x) => x !== file) : [...f, file]
    );
  };

  return (
    <div className="flex h-full">
      {/* ── Chat panel ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-5 border-b border-white/[0.05] bg-ink-900/50">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4.5 h-4.5 text-accent-400" />
            <h2 className="text-sm font-semibold text-white">Chat Engine</h2>
            <span className="badge bg-emerald2-500/10 text-emerald2-400 border border-emerald2-500/20">
              <CircleDot className="w-2.5 h-2.5" /> Connected
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <GitBranch className="w-3.5 h-3.5" />
            <span>main</span>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-5">
          {messages.map((msg) => (
            <div key={msg.id} className="animate-fade-in">
              <div
                className={`flex gap-3 ${
                  msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    msg.role === 'user'
                      ? 'bg-accent-500/15 border border-accent-500/30'
                      : 'bg-gradient-to-br from-accent-500 to-accent-700 shadow-glow-sm'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <span className="text-xs font-semibold text-accent-300">U</span>
                  ) : (
                    <span className="text-xs font-semibold text-white">AI</span>
                  )}
                </div>
                <div className={`max-w-[78%] ${msg.role === 'user' ? 'text-right' : ''}`}>
                  <div
                    className={`inline-block text-left rounded-xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-accent-500/10 border border-accent-500/20 text-gray-200'
                        : 'glass-card text-gray-300'
                    }`}
                  >
                    {msg.content}
                  </div>
                  {/* Diff viewer */}
                  {msg.diff && (
                    <div className="mt-3 space-y-3 max-w-[85%]">
                      {msg.diff.map((change) => (
                        <div
                          key={change.filename}
                          className="glass-card overflow-hidden font-mono text-xs"
                        >
                          <div className="flex items-center justify-between px-3 py-2 bg-ink-800/60 border-b border-white/[0.04]">
                            <div className="flex items-center gap-2">
                              <FileCode2 className="w-3.5 h-3.5 text-accent-400" />
                              <span className="text-gray-300">{change.filename}</span>
                            </div>
                            <span
                              className={`badge text-[10px] ${
                                change.status === 'modified'
                                  ? 'bg-amber2-500/10 text-amber2-400'
                                  : change.status === 'added'
                                  ? 'bg-emerald2-500/10 text-emerald2-400'
                                  : 'bg-rose2-500/10 text-rose2-400'
                              }`}
                            >
                              {change.status}
                            </span>
                          </div>
                          <div className="py-1 overflow-x-auto">
                            {change.lines.map((line, i) => (
                              <div
                                key={i}
                                className={`px-3 py-0.5 ${
                                  line.type === 'add'
                                    ? 'bg-emerald2-500/10 text-emerald2-300'
                                    : line.type === 'remove'
                                    ? 'bg-rose2-500/10 text-rose2-300'
                                    : 'text-gray-500'
                                }`}
                              >
                                <span className="select-none mr-2">
                                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                                </span>
                                {line.text}
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 px-3 py-2 bg-ink-800/40 border-t border-white/[0.04]">
                            <button className="flex items-center gap-1 text-xs text-emerald2-400 hover:text-emerald2-300 transition-colors">
                              <Check className="w-3.5 h-3.5" /> Accept
                            </button>
                            <button className="flex items-center gap-1 text-xs text-rose2-400 hover:text-rose2-300 transition-colors">
                              <X className="w-3.5 h-3.5" /> Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex gap-3 animate-fade-in">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center shrink-0 shadow-glow-sm">
                <span className="text-xs font-semibold text-white">AI</span>
              </div>
              <div className="glass-card px-4 py-3 flex items-center gap-2 text-sm text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin text-accent-400" />
                Analyzing repository &amp; generating edits…
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-5 py-4 border-t border-white/[0.05] bg-ink-900/50">
          <div className="glass-card flex items-end gap-2 p-2">
            <button className="p-2 text-gray-500 hover:text-gray-300 transition-colors shrink-0">
              <Paperclip className="w-4.5 h-4.5" />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Describe a change, ask a question, or paste an error…"
              rows={1}
              className="flex-1 bg-transparent resize-none text-sm text-gray-200 placeholder-gray-500 focus:outline-none py-2 max-h-32"
            />
            <button
              onClick={send}
              disabled={!input.trim() || thinking}
              className="p-2.5 rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-2 text-[11px] text-gray-600 px-1">
            Enter to send · Shift+Enter for newline · AI proposes diffs you can accept or reject
          </p>
        </div>
      </div>

      {/* ── Repo context sidebar ── */}
      <div className="w-64 shrink-0 border-l border-white/[0.05] bg-ink-900/40 flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-white/[0.05]">
          <GitBranch className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-semibold text-white">Repo Context</h3>
        </div>
        <div className="px-3 py-3">
          <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-all">
            <Plus className="w-3.5 h-3.5" /> Add file to context
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {REPO_FILES.map((file) => {
            const selected = selectedFiles.includes(file);
            return (
              <button
                key={file}
                onClick={() => toggleFile(file)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-all ${
                  selected
                    ? 'bg-accent-500/10 text-accent-300 border border-accent-500/20'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] border border-transparent'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate text-left flex-1">{file}</span>
                {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-white/[0.05]">
          <div className="text-xs text-gray-500 mb-1">Files in context</div>
          <div className="text-lg font-semibold text-white">{selectedFiles.length}</div>
        </div>
      </div>
    </div>
  );
}

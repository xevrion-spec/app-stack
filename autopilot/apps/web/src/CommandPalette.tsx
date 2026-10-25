import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}
/** Ctrl/Cmd+K command palette: an accessible combobox + listbox; arrow keys, Enter to run, Escape to close. */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        opener.current = document.activeElement;
        setOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      input.current?.focus();
    } else (opener.current as HTMLElement | null)?.focus?.();
  }, [open]);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(n)) : commands;
  }, [q, commands]);
  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label={t("palette.open")} className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={list[i] ? `cmd-${list[i]!.id}` : undefined}
          aria-label={t("palette.placeholder")}
          placeholder={t("palette.placeholder")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, list.length - 1));
            else if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            else if (e.key === "Enter") run(list[i]);
            else if (e.key === "Escape") setOpen(false);
            else return;
            e.preventDefault();
          }}
        />
        <ul id="palette-list" role="listbox" aria-label={t("palette.open")}>
          {list.length === 0 ? <li className="muted">{t("palette.empty")}</li> : null}
          {list.map((c, k) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              {c.label}
              {c.hint ? <small className="muted"> {c.hint}</small> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

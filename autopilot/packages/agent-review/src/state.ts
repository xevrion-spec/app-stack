/**
 * Review request lifecycle: a pure state machine with no I/O, so the API, queue consumers and tests all share one set
 * of rules.
 *
 *   pending ──approve/edit (quorum met)──▶ approved
 *      │  ╲──reject (any reviewer: veto)──▶ rejected
 *      │   ╲─expire (deadline passed)────▶ expired
 *      │    ╲cancel (requester)──────────▶ cancelled
 *      └──escalate──▶ escalated ──(same exits as pending)
 *
 * Approvals are tied to a payload version. An edit creates a new version that the editor approves, and approvals of
 * older versions stop counting, so four-eyes always means N distinct people approved exactly what will run.
 * The requester (the agent's principal) can never approve its own request.
 */
export const STATUSES = ["pending", "escalated", "approved", "rejected", "expired", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export const FINAL: ReadonlySet<Status> = new Set(["approved", "rejected", "expired", "cancelled"]);
export const DECISIONS = ["approve", "reject", "edit", "escalate"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface Approval {
  reviewer: string;
  version: number;
  /** Chain step the approval counted for (chains only). */
  step?: number;
}
/** One stage of a multi-step approval chain (R3): its own group and approver count, cleared in order. */
export interface Step {
  name: string;
  group: string | null;
  approvals: number;
}
export interface Snapshot {
  status: Status;
  requester: string;
  requiredApprovals: number;
  payloadVersion: number;
  approvals: Approval[];
  /** Every reviewer who has made any decision, used to stop the same person deciding twice on one version. */
  deciders: Approval[];
  /** Multi-step chain: when present, steps clear in order and the request is approved after the last one. */
  steps?: Step[];
  stepIndex?: number;
}
export type ReviewEvent = { type: "decide"; decision: Decision; reviewer: string } | { type: "expire" } | { type: "cancel"; by: string };

export type TransitionErrorCode = "already_final" | "self_approval" | "duplicate_decision" | "already_escalated" | "not_requester";
export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export function initial(requester: string, requiredApprovals: number): Snapshot {
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 5) throw new RangeError("requiredApprovals must be 1..5");
  return { status: "pending", requester, requiredApprovals, payloadVersion: 1, approvals: [], deciders: [] };
}

/** A chain: every step needs 1..10 approvals, at most 5 steps, the total bounded by 20. */
export function initialChain(requester: string, steps: Step[]): Snapshot {
  if (steps.length < 1 || steps.length > 5) throw new RangeError("a chain has 1..5 steps");
  for (const st of steps) if (!Number.isInteger(st.approvals) || st.approvals < 1 || st.approvals > 10) throw new RangeError("step approvals must be 1..10");
  const total = steps.reduce((n, st) => n + st.approvals, 0);
  return { status: "pending", requester, requiredApprovals: Math.min(total, 20), payloadVersion: 1, approvals: [], deciders: [], steps, stepIndex: 0 };
}

/** The step currently being decided (null when the request is not a chain or the chain is done). */
export const currentStep = (s: Snapshot): Step | null => (s.steps && (s.stepIndex ?? 0) < s.steps.length ? s.steps[s.stepIndex ?? 0]! : null);

const stepApprovals = (s: Snapshot, step: number) =>
  new Set(s.approvals.filter((a) => a.version === s.payloadVersion && a.step === step).map((a) => a.reviewer)).size;

/** Records a chain approval and advances while the current step's quorum is met. */
function approveChain(s: Snapshot, who: string, deciders: Approval[]): Snapshot {
  const i = s.stepIndex ?? 0;
  const next: Snapshot = { ...s, deciders, approvals: [...s.approvals, { reviewer: who, version: s.payloadVersion, step: i }] };
  if (stepApprovals(next, i) < s.steps![i]!.approvals) return next;
  const after = i + 1;
  return after >= s.steps!.length ? { ...next, stepIndex: after, status: "approved" } : { ...next, stepIndex: after, status: "pending" };
}

export const currentApprovals = (s: Snapshot) => new Set(s.approvals.filter((a) => a.version === s.payloadVersion).map((a) => a.reviewer)).size;

/** Applies one event. Throws TransitionError for an illegal move and never mutates the input. */
export function apply(s: Snapshot, e: ReviewEvent): Snapshot {
  if (FINAL.has(s.status)) throw new TransitionError("already_final", `Request is already ${s.status}`);
  if (e.type === "expire") return { ...s, status: "expired" };
  if (e.type === "cancel") {
    if (e.by !== s.requester) throw new TransitionError("not_requester", "Only the requester can cancel");
    return { ...s, status: "cancelled" };
  }
  const who = e.reviewer;
  if (who === s.requester && e.decision !== "reject") throw new TransitionError("self_approval", "The requester cannot decide its own request");
  if (s.deciders.some((d) => d.reviewer === who && d.version === s.payloadVersion) && e.decision !== "edit")
    throw new TransitionError("duplicate_decision", "This reviewer already decided this version");
  const deciders = [...s.deciders, { reviewer: who, version: s.payloadVersion }];
  switch (e.decision) {
    case "reject":
      return { ...s, deciders, status: "rejected" };
    case "escalate":
      if (s.status === "escalated") throw new TransitionError("already_escalated", "Already escalated");
      return { ...s, deciders, status: "escalated" };
    case "edit": {
      // In a chain an edit proposes a new version and restarts the chain: every step re-approves what will run.
      if (s.steps)
        return {
          ...s,
          payloadVersion: s.payloadVersion + 1,
          deciders: [...deciders, { reviewer: who, version: s.payloadVersion + 1 }],
          stepIndex: 0,
          status: "pending",
        };
      const v = s.payloadVersion + 1;
      const next = {
        ...s,
        payloadVersion: v,
        deciders: [...deciders, { reviewer: who, version: v }],
        approvals: [...s.approvals, { reviewer: who, version: v }],
      };
      return currentApprovals(next) >= s.requiredApprovals ? { ...next, status: "approved" } : next;
    }
    case "approve": {
      if (s.steps) return approveChain(s, who, deciders);
      const next = { ...s, deciders, approvals: [...s.approvals, { reviewer: who, version: s.payloadVersion }] };
      return currentApprovals(next) >= s.requiredApprovals ? { ...next, status: "approved" } : next;
    }
  }
}

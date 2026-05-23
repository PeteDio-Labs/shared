import { z } from 'zod';

// ─── Agent Status ────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'waiting_approval' | 'complete' | 'failed';

// ─── Task Payload ────────────────────────────────────────────────

export const TaskPayloadSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  trigger: z.enum(['infra-event', 'cron', 'manual', 'github']),
  input: z.record(z.string(), z.unknown()),
  issuedAt: z.string(),
});
export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

// ─── Approval Preview ────────────────────────────────────────────
//
// Discriminated union shared with MC frontend (Phase 2.4 contract,
// `planning/MISSION-CONTROL-HOMELAB-UPGRADE.md` lines 192-195). Source
// of truth lived in `agents/infra-agent/src/runbooks/types.ts`; lifted
// here in 1.4.0 so MC backend, agents, and the web UI all import from
// one place.
//
// The MC frontend reads `pending_approval.preview` directly, so the
// shape (key names, case) MUST match what MC renders.

export const TextPreviewSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
});
export type TextPreview = z.infer<typeof TextPreviewSchema>;

export const TfPlanPreviewSchema = z.object({
  type: z.literal('tf-plan'),
  planText: z.string(),
  summary: z.object({
    add: z.number(),
    change: z.number(),
    destroy: z.number(),
  }),
});
export type TfPlanPreview = z.infer<typeof TfPlanPreviewSchema>;

export const AnsibleCheckTaskSchema = z.object({
  name: z.string(),
  host: z.string(),
  changed: z.boolean(),
  diff: z.string().optional(),
});
export type AnsibleCheckTask = z.infer<typeof AnsibleCheckTaskSchema>;

export const AnsibleCheckPreviewSchema = z.object({
  type: z.literal('ansible-check'),
  tasks: z.array(AnsibleCheckTaskSchema),
});
export type AnsibleCheckPreview = z.infer<typeof AnsibleCheckPreviewSchema>;

export const ApprovalPreviewSchema = z.discriminatedUnion('type', [
  TextPreviewSchema,
  TfPlanPreviewSchema,
  AnsibleCheckPreviewSchema,
]);
export type ApprovalPreview = z.infer<typeof ApprovalPreviewSchema>;

// ─── Status Updates ──────────────────────────────────────────────

export const GatedActionSchema = z.object({
  actionType: z.enum(['write-file', 'git-commit', 'git-push', 'publish', 'deploy', 'remediate', 'create-tasks']),
  description: z.string(),
  // Either a free-form string (legacy diff/task-list rendering) or a
  // structured ApprovalPreview that MC can render with a typed widget.
  preview: z.union([z.string(), ApprovalPreviewSchema]).optional(),
});
export type GatedAction = z.infer<typeof GatedActionSchema>;

export const AgentStatusUpdateSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  status: z.enum(['running', 'waiting_approval', 'complete', 'failed']),
  message: z.string().optional(),
  requiresApproval: GatedActionSchema.optional(),
  updatedAt: z.string(),
});
export type AgentStatusUpdate = z.infer<typeof AgentStatusUpdateSchema>;

// ─── Artifacts ───────────────────────────────────────────────────

export const ArtifactSchema = z.object({
  type: z.enum(['investigation-report', 'task-list', 'blog-draft', 'diff', 'log', 'pr-url', 'summary']),
  label: z.string(),
  content: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ─── Agent Result ────────────────────────────────────────────────

export const AgentResultSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  status: z.enum(['complete', 'failed']),
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
  durationMs: z.number(),
  completedAt: z.string(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ─── Approval ────────────────────────────────────────────────────

export const ApprovalRequestSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  action: GatedActionSchema,
  requestedAt: z.string(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export type ApprovalOutcome = 'approved' | 'rejected';

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  token?: string;
  reason?: string;
}

// ─── Plan service (PB.9) ─────────────────────────────────────────
//
// Mirrors the canonical types in
// `apps/mission-control/mission-control-backend/src/services/plans/types.ts`.
// Agents call `reporter.proposeAction()` / `reporter.updatePlan()`; those
// wrap MC's POST /api/v1/plans + PATCH /api/v1/plans/:id/status. Keep in
// sync with CreatePlanBodySchema + TransitionStatusBodySchema in
// `apps/mission-control/mission-control-backend/src/api/routes/plans.ts`.

export type PlanKind =
  | 'proposed_fix'
  | 'alert'
  | 'gated_action'
  | 'eval_regression'
  | 'capacity_warning';

export type PlanSeverity = 'info' | 'warn' | 'error' | 'critical';

export type ButtonStyle = 'primary' | 'secondary' | 'danger' | 'link';

export interface SuggestedAction {
  actionId: string;
  label: string;
  style?: ButtonStyle;
  clickPayload?: Record<string, unknown>;
}

export interface ProposedFix {
  agent: string;
  task: string;
  input?: Record<string, unknown>;
}

export interface ProposeActionInput {
  kind: PlanKind;
  severity?: PlanSeverity;
  target?: string;
  summary: string;
  proposedFix?: ProposedFix;
  actions: SuggestedAction[];
  sourceMetadata?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface UpdatePlanInput {
  toStatus: 'in_progress' | 'succeeded' | 'failed' | 'stuck' | 'resolved';
  result?: Record<string, unknown>;
  errorSummary?: string;
  proposals?: Array<{ label: string; task?: string; mcUrl?: string }>;
  triggeredAgentRunId?: string;
}

export interface ProposeActionResult {
  planId: string;
}

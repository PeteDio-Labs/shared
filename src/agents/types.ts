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

// ─── Status Updates ──────────────────────────────────────────────

export const GatedActionSchema = z.object({
  actionType: z.enum(['write-file', 'git-commit', 'git-push', 'publish', 'deploy', 'remediate', 'create-tasks']),
  description: z.string(),
  preview: z.string().optional(), // diff, task list, blog post, etc.
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

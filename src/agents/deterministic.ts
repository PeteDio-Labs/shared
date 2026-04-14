export interface DeterministicStep<TAction extends string = string> {
  title: string;
  action: TAction;
  args?: Record<string, unknown>;
}

export interface DeterministicStepResult {
  output: string;
  summary?: string;
}

export interface DeterministicStepLog<TAction extends string = string> {
  step: DeterministicStep<TAction>;
  status: 'complete' | 'failed' | 'skipped';
  output: string;
  summary?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface DeterministicRunOptions<TAction extends string = string> {
  steps: DeterministicStep<TAction>[];
  executeStep: (step: DeterministicStep<TAction>) => Promise<string | DeterministicStepResult>;
  onBeforeStep?: (
    step: DeterministicStep<TAction>,
    index: number,
  ) => Promise<'proceed' | 'skip' | 'abort'>;
  onStepStart?: (step: DeterministicStep<TAction>, index: number) => void | Promise<void>;
  onStepComplete?: (log: DeterministicStepLog<TAction>, index: number) => void | Promise<void>;
  stopOnError?: boolean;
}

export interface DeterministicRunResult<TAction extends string = string> {
  status: 'complete' | 'failed';
  logs: DeterministicStepLog<TAction>[];
  completedSteps: number;
  skippedSteps: number;
  failedStep?: DeterministicStepLog<TAction>;
}

function normalizeResult(result: string | DeterministicStepResult): DeterministicStepResult {
  return typeof result === 'string' ? { output: result } : result;
}

export async function runDeterministicPlan<TAction extends string = string>(
  opts: DeterministicRunOptions<TAction>,
): Promise<DeterministicRunResult<TAction>> {
  const logs: DeterministicStepLog<TAction>[] = [];
  const stopOnError = opts.stopOnError ?? true;

  for (const [index, step] of opts.steps.entries()) {
    // Gate: allow caller to skip or abort a step before it runs
    if (opts.onBeforeStep) {
      const gate = await opts.onBeforeStep(step, index);
      if (gate === 'abort') {
        const now = new Date().toISOString();
        const abortLog: DeterministicStepLog<TAction> = {
          step,
          status: 'failed',
          output: 'Aborted by gate',
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        };
        logs.push(abortLog);
        return {
          status: 'failed',
          logs,
          completedSteps: logs.filter((l) => l.status === 'complete').length,
          skippedSteps: logs.filter((l) => l.status === 'skipped').length,
          failedStep: abortLog,
        };
      }
      if (gate === 'skip') {
        const now = new Date().toISOString();
        const skipLog: DeterministicStepLog<TAction> = {
          step,
          status: 'skipped',
          output: 'Skipped by gate',
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        };
        logs.push(skipLog);
        await opts.onStepComplete?.(skipLog, index);
        continue;
      }
    }

    await opts.onStepStart?.(step, index);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const result = normalizeResult(await opts.executeStep(step));
      const log: DeterministicStepLog<TAction> = {
        step,
        status: 'complete',
        output: result.output,
        summary: result.summary,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      };
      logs.push(log);
      await opts.onStepComplete?.(log, index);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const log: DeterministicStepLog<TAction> = {
        step,
        status: 'failed',
        output: message,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      };
      logs.push(log);
      await opts.onStepComplete?.(log, index);

      if (stopOnError) {
        return {
          status: 'failed',
          logs,
          completedSteps: logs.filter((entry) => entry.status === 'complete').length,
          skippedSteps: logs.filter((entry) => entry.status === 'skipped').length,
          failedStep: log,
        };
      }
    }
  }

  return {
    status: 'complete',
    logs,
    completedSteps: logs.filter((entry) => entry.status === 'complete').length,
    skippedSteps: logs.filter((entry) => entry.status === 'skipped').length,
  };
}

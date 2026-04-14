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
  status: 'complete' | 'failed';
  output: string;
  summary?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface DeterministicRunOptions<TAction extends string = string> {
  steps: DeterministicStep<TAction>[];
  executeStep: (step: DeterministicStep<TAction>) => Promise<string | DeterministicStepResult>;
  onStepStart?: (step: DeterministicStep<TAction>, index: number) => void | Promise<void>;
  onStepComplete?: (log: DeterministicStepLog<TAction>, index: number) => void | Promise<void>;
  stopOnError?: boolean;
}

export interface DeterministicRunResult<TAction extends string = string> {
  status: 'complete' | 'failed';
  logs: DeterministicStepLog<TAction>[];
  completedSteps: number;
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
          failedStep: log,
        };
      }
    }
  }

  return {
    status: 'complete',
    logs,
    completedSteps: logs.filter((entry) => entry.status === 'complete').length,
  };
}

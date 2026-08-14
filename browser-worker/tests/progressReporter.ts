import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

// Posts per-test progress to the control plane during the main matrix run so the UI
// can show "running · 6/12 · <current test>". No-ops unless the run context is present
// (QA_RUN_ID/QA_CP_URL) and progress isn't explicitly disabled (flake reruns set
// QA_PROGRESS_OFF so they don't reset the main run's counter). Always best-effort.
export default class ProgressReporter implements Reporter {
  private total = 0;
  private done = 0;
  private readonly enabled: boolean;
  private readonly base: string;
  private readonly runId: string;
  private readonly token: string;
  private readonly phase: string;

  constructor() {
    const env = process.env;
    this.runId = env.QA_RUN_ID ?? '';
    this.base = env.QA_CP_URL ?? '';
    this.token = env.QA_API_TOKEN ?? '';
    this.phase = env.QA_PROGRESS_PHASE ?? 'running';
    this.enabled = Boolean(this.runId && this.base) && env.QA_PROGRESS_OFF !== '1';
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length;
    void this.post({ phase: this.phase, done: 0, total: this.total, current: null });
  }

  onTestEnd(test: TestCase, _result: TestResult): void {
    this.done += 1;
    void this.post({ done: this.done, total: this.total, current: test.title });
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    try {
      await fetch(`${this.base}/internal/runs/${this.runId}/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      /* progress is advisory */
    }
  }
}

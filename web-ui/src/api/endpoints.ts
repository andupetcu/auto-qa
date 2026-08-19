/** @fileoverview Typed Auto QA control-plane endpoint adapters. */

import { api } from './client';
import type {
  Capabilities,
  ConsoleEntry,
  FailureBundle,
  FullHarArtifact,
  MatrixRow,
  NetworkFailure,
  Project,
  ProjectCreateInput,
  ProjectCredentialsInput,
  ProjectPatchInput,
  RerunInput,
  Route,
  Run,
  RunCreateInput,
  RunCreateResponse,
  RunStatus,
  SignedArtifact,
  TestResult,
  VisualEvidence,
} from './types';

export const endpoints = {
  capabilities: () => api.get<Capabilities>('/capabilities'),

  projects: () => api.get<Project[]>('/projects'),
  project: (name: string) => api.get<Project>(`/projects/${encodeURIComponent(name)}`),
  createProject: (input: ProjectCreateInput) => api.post<Project>('/projects', input),
  patchProject: (name: string, input: ProjectPatchInput) =>
    api.patch<Project>(`/projects/${encodeURIComponent(name)}`, input),
  putProjectCredentials: (idOrName: string, input: ProjectCredentialsInput) =>
    api.put<void>(`/projects/${encodeURIComponent(idOrName)}/credentials`, input),
  runProject: (
    idOrName: string,
    input?: { routes?: string[] | 'ALL'; base_url?: string; app_version?: string },
  ) => api.post<RunCreateResponse>(`/projects/${encodeURIComponent(idOrName)}/run`, input ?? {}),

  routes: (project?: string) => api.get<Route[]>('/routes', { project }),
  matrix: (project?: string) => api.get<MatrixRow[]>('/matrix', { project }),

  runs: (params?: {
    limit?: number;
    status?: RunStatus;
    project?: string;
    trigger?: string;
    before?: string;
  }) => api.get<Run[]>('/runs', params),
  run: (id: string) => api.get<Run>(`/runs/${encodeURIComponent(id)}`),
  createRun: (input: RunCreateInput, idempotencyKey: string) =>
    api.post<RunCreateResponse>('/runs', input, { 'Idempotency-Key': idempotencyKey }),
  rerun: (id: string, input: RerunInput) =>
    api.post<RunCreateResponse>(`/runs/${encodeURIComponent(id)}/rerun`, input),
  cancelRun: (id: string) =>
    api.post<RunCreateResponse>(`/runs/${encodeURIComponent(id)}/cancel`, {}),
  runResults: (id: string, params?: { limit?: number; offset?: number; status?: string }) =>
    api.get<{ items: TestResult[]; total: number; offset: number; limit: number }>(
      `/runs/${encodeURIComponent(id)}/results`,
      params,
    ),
  runBundles: (id: string, severityMin?: string) =>
    api.get<FailureBundle[]>(`/runs/${encodeURIComponent(id)}/bundles`, {
      severity_min: severityMin,
    }),

  resultConsole: (resultId: string, params?: { level?: string; limit?: number }) =>
    api.get<ConsoleEntry[]>(`/results/${encodeURIComponent(resultId)}/console`, params),
  resultHarFailures: (resultId: string) =>
    api.get<NetworkFailure[]>(`/results/${encodeURIComponent(resultId)}/har`, {
      failures_only: true,
    }),
  resultHarFull: (resultId: string) =>
    api.get<FullHarArtifact>(`/results/${encodeURIComponent(resultId)}/har`, {
      failures_only: false,
    }),
  resultArtifacts: (resultId: string, types?: string) =>
    api.get<SignedArtifact[]>(`/results/${encodeURIComponent(resultId)}/artifacts`, { types }),
  resultVisualEvidence: (resultId: string) =>
    api.get<VisualEvidence>(`/results/${encodeURIComponent(resultId)}/visual-evidence`),
};

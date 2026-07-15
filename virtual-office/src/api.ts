export const API_BASE = '/api';

export interface AgentSummary {
  agent_id: string;
  character_name: string;
  role: string;
  department: string;
  status: string;
}

export interface AgentDetail extends AgentSummary {
  level?: number;
  base_prompt?: string;
  persona?: string;
  preferred_model?: string;
  telegram_bot_token?: string;
  avatar?: string;
  position?: { x: number; y: number };
}

export interface WorkflowResult {
  thread_id: string;
  final_status: string;
  iteration_count: number;
  worker_output: string;
  manager_review: string;
  latency_ms: number;
  event_id: string | null;
  bridge_updated: boolean;
}

export interface EventRecord {
  event_id: string;
  sender: string;
  target: string;
  payload: string;
  timestamp: string;
}

/* 단기기억 = GraphRAG 지식베이스 참조 상태 */
export interface KnowledgeStatus {
  path: string;
  available: boolean;
  is_git: boolean;
  branch: string | null;
  last_commit: string | null;
  total_nodes: number;
  by_category: { concepts: number; entities: number; comparisons: number };
  pull_ok?: boolean;
  pull_output?: string;
  error?: string;
}

export interface KnowledgeHit { node: string; line: string; }

async function safeJson<T>(p: Promise<Response>): Promise<T | null> {
  try {
    const r = await p;
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const api = {
  health: () => safeJson<{ status: string; redis: string; vllm: string }>(fetch(`${API_BASE}/health`)),
  listAgents: () => safeJson<{ total: number; agents: AgentSummary[] }>(fetch(`${API_BASE}/agents`)),
  getAgent: (id: string) => safeJson<AgentDetail>(fetch(`${API_BASE}/agents/${id}`)),
  updateAgent: (id: string, updates: Partial<AgentDetail>) =>
    safeJson<{ ok: boolean; agent: AgentDetail }>(
      fetch(`${API_BASE}/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    ),
  createAgent: (payload: any) =>
    safeJson<{ ok: boolean; agent: AgentDetail }>(
      fetch(`${API_BASE}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    ),
  deleteAgent: (id: string) =>
    safeJson<{ ok: boolean; deleted: string }>(
      fetch(`${API_BASE}/agents/${id}`, { method: 'DELETE' })
    ),
  triggerWorkflow: (deptId: string, taskInput: string, maxIter = 3, target?: string) =>
    safeJson<WorkflowResult>(
      fetch(`${API_BASE}/workflow/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department_id: deptId, task_input: taskInput, max_iterations: maxIter, target_department: target || null }),
      })
    ),
  listEvents: () => safeJson<{ total: number; events: EventRecord[] }>(fetch(`${API_BASE}/events`)),

  /* ── 단기기억: GraphRAG 지식베이스 (mrlee-wiki-graphrag) ── */
  knowledgeStatus: () => safeJson<KnowledgeStatus>(fetch(`${API_BASE}/knowledge/status`)),
  knowledgePull: () =>
    safeJson<KnowledgeStatus>(fetch(`${API_BASE}/knowledge/pull`, { method: 'POST' })),
  knowledgeSearch: (q: string) =>
    safeJson<{ query: string; hits: KnowledgeHit[] }>(
      fetch(`${API_BASE}/knowledge/search?q=${encodeURIComponent(q)}`)
    ),
  knowledgeRead: (slug: string) =>
    safeJson<{ slug: string; content: string }>(
      fetch(`${API_BASE}/knowledge/read?slug=${encodeURIComponent(slug)}`)
    ),
  /* ⚡ 지식 주입 → raw/ 저장 → (기본)자동 git 동기화 */
  knowledgeInject: (payload: { title: string; content: string; source_url?: string; sync?: boolean }) =>
    safeJson<{ ok: boolean; injected?: string; error?: string; sync_steps?: any[]; status?: KnowledgeStatus }>(
      fetch(`${API_BASE}/knowledge/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    ),
  /* ⬆ 백업 = git add/commit/pull/push */
  knowledgeSync: (message?: string) =>
    safeJson<{ ok: boolean; steps: any[]; status: KnowledgeStatus }>(
      fetch(`${API_BASE}/knowledge/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    ),

  /* ── Phase 4: 에이전트 워크스페이스 (FS/터미널) ── */
  fsList: (path = '') =>
    safeJson<{ path: string; entries: FsEntry[] }>(
      fetch(`${API_BASE}/fs/list?path=${encodeURIComponent(path)}`)
    ),
  fsRead: (path: string) =>
    safeJson<{ path: string; content: string }>(
      fetch(`${API_BASE}/fs/read?path=${encodeURIComponent(path)}`)
    ),
  fsWrite: (path: string, content: string) =>
    safeJson<{ ok: boolean; path?: string; error?: string }>(
      fetch(`${API_BASE}/fs/write`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      })
    ),
  termRun: (cmd: string) =>
    safeJson<{ ok: boolean; code?: number; output?: string; error?: string }>(
      fetch(`${API_BASE}/term/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      })
    ),

  /* ── Phase 5: 장기기억 FT (SFT 데이터셋 + Colab 노트북) ── */
  longtermBuildDataset: (mode = 'sft') =>
    safeJson<{ ok: boolean; count?: number; rel?: string; error?: string }>(
      fetch(`${API_BASE}/longterm/build-dataset`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
    ),
  longtermColab: (cfg: { base_model?: string; hf_repo?: string; rank?: number; epochs?: number; lr?: number }) =>
    safeJson<{ ok: boolean; rel?: string; base_model?: string; hf_repo?: string; error?: string }>(
      fetch(`${API_BASE}/longterm/colab`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
    ),
};

export interface FsEntry { name: string; is_dir: boolean; size: number; path: string; }

export const deptLabels: Record<string, string> = {
  research_dept:      '학술연구부',
  finance_dept:       '금융투자부',
  content_dept:       '콘텐츠생산부',
  dev_dept:           '개발팀',
  orchestration_dept: '오케스트레이션팀',
};

export const deptColors: Record<string, string> = {
  research_dept:      '#2ecc71',
  finance_dept:       '#3b82f6',
  content_dept:       '#a855f7',
  dev_dept:           '#ef4444',
  orchestration_dept: '#f59e0b',
};

export function avatarFor(agent: { role: string; department: string }): string {
  const isManager = agent.role.toLowerCase() === 'project manager' ||
                    agent.role.toLowerCase().includes('orchestrator');
  const dept = agent.department.replace('_dept', '');
  return `/sprites/npc_${dept}_${isManager ? 'manager' : 'worker'}.png`;
}

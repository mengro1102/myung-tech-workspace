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
};

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

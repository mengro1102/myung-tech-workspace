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

/* null 은 "서버에 닿지 못했다"는 뜻으로만 쓴다.
 *
 * 예전에는 2xx 가 아니면 무조건 null 을 돌려줬다. 그래서 서버가 이유를 적어
 * 보낸 응답(400 "empty command", 403 "터미널 실행 비활성화 — 켜려면 …")이
 * 통째로 버려지고, 화면에는 "백엔드 미연결"이 떴다. 고칠 수 있는 문제를
 * 고칠 수 없는 문제로 바꿔 보여 준 셈이다.
 *
 * 그래서 error 를 담아 보낸 응답은 그대로 넘긴다. 호출부는 이미 r.error 를
 * 확인하도록 되어 있다. */
async function safeJson<T>(p: Promise<Response>): Promise<T | null> {
  try {
    const r = await p;
    if (r.ok) return (await r.json()) as T;
    const body = await r.json().catch(() => null);
    if (body && typeof body === 'object' && 'error' in body) return body as T;
    return null;
  } catch {
    return null;
  }
}

export type StoreCollection = 'tasks' | 'services' | 'approvals';

export interface StoreItem {
  id: string;
  created_at: number;
  updated_at?: number;
  [key: string]: unknown;
}

export interface TaskRow extends StoreItem {
  text: string;
  done: boolean;
  /** 'user' 면 사람이, 부서 id 면 그 부서 에이전트가 쌓은 것 */
  source?: string;
  department?: string;
}

export interface ServiceRow extends StoreItem {
  name: string; url?: string; github?: string; desc?: string;
}

export interface ApprovalRow extends StoreItem {
  label: string;
  department?: string;
  detail?: string;
  status?: 'pending' | 'approved' | 'rejected';
  /** 'file' 이면 승인하는 순간 workspace 에 파일이 쓰인다.
   *  'project' 면 승인하는 순간 자율 실행이 시작된다 — 그 뒤로는
   *  결과가 나올 때까지 다시 묻지 않는다. */
  kind?: 'file' | 'project' | 'action';
  project_id?: string;
  /** kind==='action' — 승인하는 순간 바깥으로 나가는 호출이 일어난다 */
  integration?: string;
  action?: string;
  action_args?: Record<string, unknown>;
  /** 실행 결과(또는 실패 사유). 승인 뒤에 채워진다 */
  result?: string;
  file_path?: string;
  file_content?: string;
}

/* ── 자율 프로젝트 ─────────────────────────────────────────────────────────
   아이디어 → 계획 → 착수 승인(한 번) → 자율 실행 → 완료.
   상한은 없다. 진전이 멈추면 스스로 pause 하고 텔레그램으로 알린다. */
export type ProjectStatus =
  | 'intake' | 'planning' | 'awaiting_approval'
  | 'running' | 'paused' | 'done' | 'cancelled';

export interface Deliverable {
  id: string; title: string; dept: string; desc: string;
}

export interface ProjectStep {
  n: number;
  /** draft = 초안, review1 = 부서 1차, review2 = 오케스트레이터 2차 */
  phase: 'plan' | 'draft' | 'review1' | 'review2';
  dept: string;
  ok: boolean;
  /** 리뷰 점수. 초안 단계는 -1 */
  score: number;
  note: string;
  at: number;
}

export interface ProjectRow {
  id: string;
  title: string;
  idea: string;
  status: ProjectStatus;
  intent?: string;
  plan?: { goal?: string; done_when?: string[]; risks?: string[];
           deliverables?: Deliverable[] } | null;
  cursor: number;
  phase: string;
  /** 목록 응답에는 없다 — 산출물이 수만 자라 따로 받는다 */
  steps?: ProjectStep[];
  artifacts?: Record<string, string>;
  budget?: { calls: number; day: string };
  pause_reason?: string;
  progress: string;
  step_count?: number;
  budget_left: number;
  created_at: number;
  updated_at?: number;
}

/* ── 연동 ───────────────────────────────────────────────────────────────────
   state 가 세 가지인 것이 핵심이다. 예전 화면은 "키가 .env 에 비어 있지 않음"
   을 그대로 "연결됨" 이라고 불렀다 — 저장과 연결은 다르다. 'ok' 는 서버가
   그 키로 **실제 호출을 한 번 해 보고** 성공했을 때만 온다. */
export type IntegrationState = 'ok' | 'unset' | 'error';

export interface IntegrationStatus {
  name: string;
  label: string;
  icon: string;
  state: IntegrationState;
  ok: boolean;
  /** 사람이 읽을 한 줄. 성공이면 실제 수치, 실패면 이유 */
  detail: string;
  /** 비어 있는 필수 키 이름들 */
  missing: string[];
  required: string[];
  optional: string[];
  /** 결재를 거쳐 실행할 수 있는 동작 id 들 */
  actions: string[];
  /** Guidance 문서의 앵커 */
  docs: string;
}

/* ── 에이전트 대화 ─────────────────────────────────────────────────────────
   누가 누구에게 무엇을 말했는가. text 는 말풍선용 한 줄, detail 은 전문
   (검토 의견 · 한마디 · 인계 메모). restored 는 대화 기록 기능 이전에 돈
   프로젝트를 단계 기록에서 되살린 줄이다. */
export interface DialogueEntry {
  at: number;
  from: string; from_dept: string;
  to: string;   to_dept: string;
  kind: 'plan' | 'research' | 'approve' | 'submit' | 'retry' | 'pass'
      | 'reject' | 'handoff' | 'continue' | 'brief' | 'say';
  text: string;
  detail: string;
  score?: number | null;
  restored?: boolean;
  project_id?: string;
  project_title?: string;
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

  /* 할 일 · 등록 서비스 · 승인 큐.
   * 브라우저에만 있던 것들이라 에이전트가 읽을 수 없었다. 서버로 올렸고,
   * 디스패처가 같은 파일을 읽고 쓴다. */
  storeList: <T = StoreItem>(collection: StoreCollection) =>
    safeJson<{ items: T[] }>(fetch(`${API_BASE}/store/${collection}`)),
  storeAdd: <T = StoreItem>(collection: StoreCollection, item: Record<string, unknown>) =>
    safeJson<{ ok: boolean; item: T; error?: string }>(
      fetch(`${API_BASE}/store/${collection}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      })
    ),
  storeUpdate: <T = StoreItem>(collection: StoreCollection, id: string, patch: Record<string, unknown>) =>
    safeJson<{ ok: boolean; item: T; error?: string;
               followup?: { queued: boolean; task_id?: string; department?: string;
                            /** kind==='action' 이 승인돼 실제로 실행된 결과 한 줄 */
                            ran?: string; project_id?: string; autonomous?: boolean;
                            reason?: string; wrote?: string } }>(
      fetch(`${API_BASE}/store/${collection}/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    ),
  storeRemove: (collection: StoreCollection, id: string) =>
    safeJson<{ ok: boolean }>(
      fetch(`${API_BASE}/store/${collection}/${id}`, { method: 'DELETE' })
    ),

  /* YouTube Analytics OAuth. 구글이 인가 코드를 브라우저 리다이렉트로
   * 돌려주므로, 시작 → 사람이 로그인 → 완료 세 걸음으로 나뉜다. */
  ytOauthStatus: () =>
    safeJson<{ connected: boolean; has_client: boolean; redirect_uri: string; pending: boolean; error: string }>(
      fetch(`${API_BASE}/youtube/oauth/status`)
    ),
  ytOauthStart: () =>
    safeJson<{ ok: boolean; auth_url?: string; redirect_uri?: string; error?: string }>(
      fetch(`${API_BASE}/youtube/oauth/start`, { method: 'POST' })
    ),
  ytOauthFinish: () =>
    safeJson<{ ok: boolean; connected?: boolean; pending?: boolean; error?: string }>(
      fetch(`${API_BASE}/youtube/oauth/finish`, { method: 'POST' })
    ),

  listModels: () =>
    safeJson<{ models: { id: string; size: number }[]; error?: string }>(
      fetch(`${API_BASE}/models`)
    ),

  /* 공통 두뇌 — server.py 의 runtime_config.json 이 단일 출처다.
   * 디스패처도 같은 파일을 읽으므로 여기서 바꾸면 추론에 바로 반영된다. */
  getGlobalModel: () =>
    safeJson<{ global_model: string; default: string }>(
      fetch(`${API_BASE}/config/model`)
    ),
  setGlobalModel: (model: string) =>
    safeJson<{ ok: boolean; global_model?: string; error?: string }>(
      fetch(`${API_BASE}/config/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
    ),

  /* 축적된 경험 — 검토를 통과한 프로젝트가 위키에 쌓인 수 */
  experienceStats: () =>
    safeJson<{ available: boolean; count: number; latest?: string; path?: string }>(
      fetch(`${API_BASE}/experience`)),

  /* ── 연동 ── */
  listIntegrations: () =>
    safeJson<{ integrations: IntegrationStatus[]; error?: string }>(
      fetch(`${API_BASE}/integrations`)),
  probeIntegration: (name: string) =>
    safeJson<{ ok: boolean; status: IntegrationStatus; error?: string }>(
      fetch(`${API_BASE}/integrations/${name}/probe`, { method: 'POST' })),

  /* ── 에이전트 대화 ── */
  dialogue: (limit = 80, project = '') =>
    safeJson<{ dialogue: DialogueEntry[]; error?: string }>(
      fetch(`${API_BASE}/dialogue?limit=${limit}${project ? `&project=${project}` : ''}`)),

  /* ── 자율 프로젝트 ── */
  listProjects: () =>
    safeJson<{ projects: ProjectRow[] }>(fetch(`${API_BASE}/projects`)),
  getProject: (id: string) =>
    safeJson<{ project: ProjectRow }>(fetch(`${API_BASE}/projects/${id}`)),
  createProject: (idea: string) =>
    safeJson<{ ok: boolean; project: ProjectRow; error?: string }>(
      fetch(`${API_BASE}/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea }),
      })
    ),
  /** approve = 착수 승인, resume = 정지 해제, cancel = 접기 */
  projectAction: (id: string, action: 'approve' | 'resume' | 'cancel') =>
    safeJson<{ ok: boolean; project: ProjectRow; error?: string }>(
      fetch(`${API_BASE}/projects/${id}/${action}`, { method: 'POST' })
    ),
  deleteProject: (id: string) =>
    safeJson<{ ok: boolean }>(fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' })),

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

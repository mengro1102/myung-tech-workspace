import { DEPT_COLORS } from './deptTheme';
export const API_BASE = '/api';

export interface AgentSummary {
  agent_id: string;
  character_name: string;
  role: string;
  department: string;
  status: string;
  /** 지금 무엇을 하는 중인지. 부서 단위 활동에서 서버가 계산한다 —
   *  에이전트 개인이 뭘 하는지는 시스템이 모른다. */
  doing?: string;
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

/* ── 구글 캘린더 ──
   유튜브 OAuth 와 **같은** 구글 클라이언트를 쓴다(서버 CAL_SCOPE 주석).
   범위는 읽기 전용 하나다. */
export interface CalendarStatus {
  connected: boolean;
  has_client: boolean;     // 유튜브 칸의 Client ID/Secret 이 있는가
  pending?: boolean;
  error?: string;
  scope?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;           // ISO. 종일이면 날짜만
  end: string;
  all_day: boolean;
  where: string;
  link: string;
}

export interface CalendarEvents {
  ok: boolean;
  connected: boolean;
  events: CalendarEvent[];
  calendar?: string;
  /** ok=false 일 때 **왜** 안 되는지. 빈 목록과 구분해야 한다 —
      연결이 깨진 것과 일정이 없는 것은 전혀 다른 상태다. */
  error?: string;
}

/* ── FreeLLMAPI 라우터 ──
   화면의 "AI 모델" 점은 Ollama 를 본다. 그런데 부서 다섯 중 넷이
   `auto:hermes` 로 이 라우터를 탄다. 무료 한도를 공급자별로 나눠 쓰는
   구조라 한 곳이 막히면 그대로 병목이 된다. */
export interface RouterProvider {
  name: string;
  status: string;        // 'healthy' 등 freeapi.db 의 값 그대로
  enabled: boolean;
}

export interface RouterStatus {
  ok: boolean;           // 포트가 열렸고 **모델 목록까지** 받았을 때만 true
  up?: boolean;
  available: number;     // 지금 쓸 수 있는 모델. -1 이면 못 받았다
  total: number;
  providers: RouterProvider[];
  healthy: number;
  today: { name: string; calls: number; in: number; out: number }[];
  calls_today: number;
  recent: { at: string; name: string; status: string }[];
  port: number;
  reason?: string;       // ok=false 일 때 무엇이 안 되는지
}

/* ── 지식베이스 (GraphRAG 위키) ── */

/** 출처. 같은 폴더에 섞여 있던 셋을 구분한다 — 사람이 정리한 노드,
 *  arXiv 에서 모은 논문, 에이전트가 만든 산출물. 근거의 무게가 다르다. */
export type KbOrigin = 'node' | 'reference' | 'experience' | 'injected' | 'unknown';

export interface KbFile {
  path: string;          // 위키 루트 기준 상대경로 (예: concepts/ppo.md)
  name: string;
  title: string;
  size: number;
  mtime: number;         // **로컬** 수정시각(초). 깃 동기화 시각이 아니다.
  origin: KbOrigin;
  kind?: 'pdf';
}

export interface KbFolder {
  path: string;
  label: string;
  hint: string;
  count: number;
  mtime: number;         // 폴더 안에서 가장 최근 파일
  files: KbFile[];
}

export interface KbTree {
  available: boolean;
  root?: string;
  folders: KbFolder[];
  total: number;
  mtime: number;
  now?: number;
  error?: string;
}

export interface KbNeighbor {
  slug: string;
  title: string;
  path: string;          // 빈 값이면 그래프에만 있고 문서가 없는 링크
  hops: number;
  why: string;           // 'related' | 'wikilink' 등 엣지 종류
}

export interface KbDoc {
  path: string;
  title: string;
  front: Record<string, string>;
  text: string;
  size: number;
  mtime: number;
  origin: KbOrigin;
  neighbors: KbNeighbor[];
  error?: string;
}

export type StoreCollection = 'tasks' | 'services' | 'approvals' | 'notes' | 'notif_state';

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
  /** 서버가 읽을 때 계산해 붙인다 — 되돌릴 수 있는 정도.
   *  1 내부(태스크 하나) · 2 쓰기(workspace·프로젝트) · 3 바깥(업로드·PR).
   *  저장된 값이 아니라 응답에만 있다. 규칙이 바뀌면 옛 행도 새 등급으로 온다. */
  tier?: 1 | 2 | 3;
  tier_name?: string;
  tier_tone?: 'muted' | 'write' | 'danger';
  tier_why?: string;
  /** 3등급은 false — 일괄 승인에 넣지 않는다. 서버도 거부한다. */
  batchable?: boolean;
  /** 누가 결정했는가 — ui | batch | cli | telegram | runner.
   *  이것이 없어서 결재 9건이 왜 승인됐는지 사후에 밝힐 수 없었다. */
  decided_by?: string;
  decided_at?: number;
}

/** 막힌 프로젝트에서 건진 교훈.
 *
 *  완료된 프로젝트는 위키에 산출물로 쌓이고(experience), **막힌 것만** 여기
 *  남는다. 반려 사유를 되풀이 단위로 묶어 두었다가, 같은 주제로 다시 시킬 때
 *  계획 프롬프트에 넣는다 — 그래서 이 목록은 "다음 계획이 왜 그렇게 나왔나"
 *  를 설명하는 입력이기도 하다. 보이지 않으면 숨은 자율성이 된다. */
/** 보관된 호출 하나. `full=1` 일 때만 system/user 가 실린다. */
export interface ArchivedCall {
  at?: number;
  phase?: string;
  dept?: string;
  did?: string;
  deliverable?: string;
  backend?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  digest?: string;
  system?: string;
  user?: string;
  system_chars?: number;
  user_chars?: number;
}

export interface ArchiveResult {
  calls: ArchivedCall[];
  stats: { calls: number; broken: number; bytes: number; chars: number; path: string };
  full: boolean;
}

/** 맹비서 세션 하나. 디스코드·텔레그램·대시보드가 같은 목록을 본다. */
export interface AssistantSession {
  id: string;
  source?: string;          // discord · telegram · api_server
  title?: string | null;
  model?: string;
  started_at?: number;
  ended_at?: number | null;
  message_count?: number;
}

export interface AssistantMessage {
  role?: string;
  content?: string;
  created_at?: number;
}

export interface LessonRow extends StoreItem {
  project_id: string;
  title: string;
  idea?: string;
  status?: string;
  reason?: string;
  steps: number;
  rejections: number;
  /** 되풀이된 지적만. 같은 말을 여러 번 적으면 프롬프트만 길어진다. */
  recurring?: string[];
  /** 스스로 범위를 좁히며 덜어낸 요구. */
  dropped?: string[];
  at?: string;
}

/** 사람이 검증할 주장 하나. 기계가 실제 논문을 찾아 둔 상태로 온다. */
export interface VerifyClaim {
  id: string;
  /** 문서가 그 논문에 대해 뭐라고 적었는지 — 문맥째로. */
  claim: string;
  /** 근거 자료에 그 번호가 있었는지. 없으면 어디서 왔는지 물어야 한다. */
  in_sources: boolean;
  verdict?: string;
  note?: string;
  paper?: {
    /** true 있음 · false arXiv 에 없음 · null **조회 못 함**.
     *  셋을 섞으면 멀쩡한 논문을 "지어냈다" 고 표시하게 된다. */
    found: boolean | null;
    title?: string;
    summary?: string;
    published?: string;
    url?: string;
    error?: string;
    cached?: boolean;
  };
}

export interface VerifySummary {
  checked: number;
  total_cites: number;
  counts: { ok: number; wrong: number; unsure: number };
  by?: string;
  at?: number;
  wrong_ids?: string[];
  unsure_ids?: string[];
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
  phase: 'plan' | 'draft' | 'review1' | 'review2' | 'narrow';
  dept: string;
  ok: boolean;
  /** 리뷰 점수. 초안 단계는 -1 */
  score: number;
  note: string;
  at: number;
  /** 분량 초과로 잘려 다시 쓴 초안. 품질 실패가 아니라 길이 실패라
   *  안전망 계산에서도 빼고 화면에서도 따로 센다. */
  trunc?: boolean;
  /** 끝나지 못한 호출인지. 프로세스가 죽어 응답을 못 받은 것이라
   *  품질 실패도 길이 실패도 아니다 — 안전망 계산에서 빠진다. */
  dead?: boolean;
  /** 이 단계의 모델 호출에 걸린 초. "왜 오래 걸리지" 와 "어느 단계가
   *  비싼가" 는 이것 없이는 답할 수 없다. */
  secs?: number;
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
  /** 러너가 실제로 조회한 자료 이름들. 비어 있으면 **맞춰 볼 자료가 없었던
   *  것**이므로, 검토 점수는 사실 확인이 아니라 그럴듯함에 대한 평가다.
   *  확신·공백 패널이 이 하나로 검증됨/가정함을 갈라 세운다. */
  source_names?: string[];
  /** 지금 돌고 있는 모델 호출. 호출 **직전**에 서버가 적고 끝나면 지운다.
   *  단계 기록은 호출이 끝난 뒤에 남으므로, 이것이 없으면 2분짜리 호출이
   *  도는 동안 화면에는 아무 줄도 나타나지 않는다. */
  inflight?: { phase: string; dept: string; deliverable: string;
               model: string; at: number } | null;
  budget?: { calls: number; day: string };
  pause_reason?: string;
  /** 사장님의 방향 전환 지시. 멈춘 프로젝트를 "이렇게 바꿔서" 이어 갈 때
   *  받아 두고, 다음 초안부터 프롬프트에 **검토 지적보다 위**로 들어간다 —
   *  검토자는 원래 계획을 기준으로 말하는데 이 지시가 그 기준을 바꾼다. */
  steer?: string;
  /** 정체를 만나 스스로 줄인 산출물. 시킨 것보다 작아졌다는 뜻이므로
   *  화면에서 반드시 드러내야 한다. */
  narrowed?: Record<string, { dropped: string[]; why: string; at: number }>;
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

  /* ── 지식베이스 탭 ──
     knowledgeNodes 는 slug 목록만 준다. 227건의 논문을
     `2coool-2nd-workshop-on-the-challenge-of-out-of-label-haz…` 로
     늘어놓는 것이 전부라서, 제목·수정시각·출처가 붙은 트리를 따로 받는다. */
  knowledgeTree: () => safeJson<KbTree>(fetch(`${API_BASE}/knowledge/tree`)),
  /** FreeLLMAPI 라우터 현황. 서버가 맹비서의 stack_status 를 불러 센다 —
      같은 숫자를 두 군데서 세지 않으려고. */
  routerStatus: () => safeJson<RouterStatus>(fetch(`${API_BASE}/router/status`)),

  /* 구글 캘린더. 유튜브 OAuth 와 같은 클라이언트·같은 리다이렉트를 쓴다. */
  calendarStatus: () => safeJson<CalendarStatus>(fetch(`${API_BASE}/calendar/status`)),
  calendarEvents: (days = 14) =>
    safeJson<CalendarEvents>(fetch(`${API_BASE}/calendar/events?days=${days}`)),
  calOauthStart: () =>
    safeJson<{ ok: boolean; auth_url?: string; redirect_uri?: string; error?: string }>(
      fetch(`${API_BASE}/calendar/oauth/start`, { method: 'POST' })),
  calOauthFinish: () =>
    safeJson<{ ok: boolean; pending?: boolean; connected?: boolean; error?: string }>(
      fetch(`${API_BASE}/calendar/oauth/finish`, { method: 'POST' })),
  knowledgeDoc: (path: string) =>
    safeJson<KbDoc>(fetch(`${API_BASE}/knowledge/doc?path=${encodeURIComponent(path)}`)),
  /** 그림·PDF 는 JSON 이 아니라 바이트다. `<img src>`·`<iframe src>` 에 그대로 넣는다. */
  knowledgeFileUrl: (path: string) =>
    `${API_BASE}/knowledge/file?path=${encodeURIComponent(path)}`,
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
  /** 2등급까지 한 번에 승인한다. 3등급(바깥으로 나가는 것)은 ids 에 넣어도
   *  서버가 거부하고 skipped 로 돌려준다 — 화면을 믿지 않는다. */
  /** 막힌 프로젝트에서 건진 교훈. 최신순. */
  /** 산출물의 '방법' 절 — 어떤 모델이 무슨 설정으로, 무엇을 근거로,
   *  몇 번 반려를 거쳐 나왔는지. RAISE 가 요구하는 공개를 화면에서도
   *  볼 수 있어야 결재 전에 판단하실 수 있다. */
  provenance: (pid: string, did: string) =>
    safeJson<{ markdown: string; error?: string }>(
      fetch(`${API_BASE}/provenance/${pid}/${did}`)
    ),
  /** 반복 실행 일관성 시험 — 같은 조건으로 한 번 더 쓰게 하고 견준다.
   *  호출 하나를 쓰므로 사장님이 원할 때만 돈다. */
  runConsistency: (pid: string, did: string) =>
    safeJson<{ error?: string; shaky?: string[]; missed?: string[];
               invented?: string[]; chars?: number[] }>(
      fetch(`${API_BASE}/consistency/${pid}/${did}`, { method: 'POST' })
    ),
  /** 검증할 표본. arXiv 조회가 섞여 있어 처음 한 번은 느리다(결과는 캐시). */
  verifyClaims: (pid: string, did: string) =>
    safeJson<{ claims: VerifyClaim[]; total_cites: number; sampled: number;
               is_sample: boolean; summary?: VerifySummary; error?: string }>(
      fetch(`${API_BASE}/verify/${pid}/${did}`)
    ),
  /** 사람의 판정을 기록한다 — 누가 언제 했는지와 함께. */
  saveVerdicts: (pid: string, did: string,
                 verdicts: Record<string, { verdict: string; note?: string }>) =>
    safeJson<VerifySummary & { error?: string }>(
      fetch(`${API_BASE}/verify/${pid}/${did}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdicts }),
      })
    ),
  /** 보관된 프롬프트 전문. 지문은 대조용 값일 뿐이라 **실제 글**이 필요하다.
   *  full 없이 부르면 목록만(길이·모델·단계) 오고, true 면 본문까지 온다 —
   *  호출 하나가 1만 자를 넘어 기본값에서는 뺐다. */
  archivedPrompts: (pid: string, did?: string, full = false) =>
    safeJson<ArchiveResult & { error?: string }>(
      fetch(`${API_BASE}/archive/${pid}${did ? `/${did}` : ''}${full ? '?full=1' : ''}`)
    ),
  /** 맹비서가 살아 있나. 게이트웨이가 꺼져 있으면 여기서 먼저 드러난다. */
  assistantHealth: () =>
    safeJson<{ ok: boolean; status?: string; error?: string; hint?: string }>(
      fetch(`${API_BASE}/assistant/health`)
    ),
  /** 세션 목록 — 디스코드에서 한 대화도 여기 보인다. */
  assistantSessions: () =>
    safeJson<{ data?: AssistantSession[]; error?: string }>(
      fetch(`${API_BASE}/assistant/sessions`)
    ),
  /** 새 세션. 제목을 주면 목록에서 알아보기 쉽다.
   *
   *  **제목은 유일해야 한다.** 맹비서가 중복을 400 으로 거절한다
   *  (`Title '...' is already in use by session ...`). 그래서 부르는
   *  쪽이 시각을 붙인다 — 고정 문자열을 주면 두 번째부터 실패한다. */
  assistantNewSession: (title?: string) =>
    safeJson<{ session?: AssistantSession; error?: string }>(
      fetch(`${API_BASE}/assistant/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(title ? { title } : {}),
      })
    ),
  /** 그 세션의 대화 히스토리. '이어가기' 의 알맹이다. */
  assistantMessages: (sid: string) =>
    safeJson<{ data?: AssistantMessage[]; messages?: AssistantMessage[]; error?: string }>(
      fetch(`${API_BASE}/assistant/sessions/${encodeURIComponent(sid)}/messages`)
    ),
  /** 이어서 대화. 길다 — 디스코드 실측 27초, 서버 타임아웃 180초. */
  assistantChat: (sid: string, message: string) =>
    // message 는 **객체**다 — {role, content}. 문자열로 적어 뒀다가
    // React 가 "Objects are not valid as a React child" 로 죽었다.
    safeJson<{ message?: AssistantMessage | string; session_id?: string;
               error?: string; hint?: string }>(
      fetch(`${API_BASE}/assistant/sessions/${encodeURIComponent(sid)}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    ),
  listLessons: () =>
    safeJson<{ items: LessonRow[]; stats: { count: number; rejections: number } }>(
      fetch(`${API_BASE}/lessons`)
    ),
  batchApprove: (ids: string[]) =>
    safeJson<{ ok: boolean; error?: string;
               approved: { id: string; label: string; tier: number }[];
               skipped: { id: string; why: string; tier?: number; label?: string }[] }>(
      fetch(`${API_BASE}/approvals/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // confirm_count 는 사람이 건수를 직접 확인했다는 증거다. 서버가
        // 수와 맞는지 보고 다르면 거부한다 — window.confirm 만으로는
        // 자동화 브라우저를 막지 못했다(실제로 9건이 그렇게 넘어갔다).
        body: JSON.stringify({ ids, confirm_count: ids.length }),
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
  /** 착수 전 계획 수정. 산출물의 제목·설명·부서, 완료 조건을 고치거나
   *  산출물을 지운다. **추가는 안 된다** — 추가는 수정이 아니라 계획
   *  수립이고, 러너가 잡은 의도·부서 배정과 어긋난 채 실행되게 된다.
   *  서버가 착수 승인 대기 상태에서만 받는다. */
  revisePlan: (id: string, patch: { deliverables?: Deliverable[]; done_when?: string[] }) =>
    safeJson<{ ok: boolean; project: ProjectRow; error?: string }>(
      fetch(`${API_BASE}/projects/${id}/plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    ),
  /** steer 를 주면 "이렇게 바꿔서 이어가기" 가 된다. 그냥 이어 가면
   *  정체 기록만 비워지고 조건은 그대로라, 같은 자리에서 다시 막힌다. */
  projectAction: (id: string, action: 'approve' | 'resume' | 'cancel', steer?: string) =>
    safeJson<{ ok: boolean; project: ProjectRow; error?: string }>(
      fetch(`${API_BASE}/projects/${id}/${action}`, steer
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ steer }) }
        : { method: 'POST' })
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

/** 부서 이름의 **정본**. 화면 어디서든 여기를 읽는다.
 *
 *  접미사를 `~부` 로 맞췄다. 서버 id 가 전부 `_dept`(부서)이고 다섯 중
 *  셋이 이미 '부' 였다 — '팀' 으로 맞추면 셋을 바꿔야 하고 id 와도
 *  어긋난다. 전에는 이 정본 자체가 섞여 있었다(개발팀·오케스트레이션팀만
 *  '팀'), 그래서 같은 부서가 자리마다 다른 이름으로 나왔다.
 *
 *  낱말은 건드리지 않는다. 이름을 새로 짓는 것은 다른 일이고, 여기서
 *  고치는 것은 **같은 것이 여러 이름으로 불리던 상태**다. */
export const deptLabels: Record<string, string> = {
  research_dept:      '학술연구부',
  finance_dept:       '금융투자부',
  content_dept:       '콘텐츠생산부',
  dev_dept:           '개발부',
  orchestration_dept: '오케스트레이션부',
};

/* 부서 색은 deptTheme.ts 가 기준이다. 여기서 따로 정하면 사무실 방 색과
   어긋난다(실제로 연구부가 방에서는 파랑, 대화 프로필에서는 초록이었다). */
export const deptColors: Record<string, string> = DEPT_COLORS;

export function avatarFor(agent: { role: string; department: string }): string {
  const isManager = agent.role.toLowerCase() === 'project manager' ||
                    agent.role.toLowerCase().includes('orchestrator');
  const dept = agent.department.replace('_dept', '');
  return `/sprites/npc_${dept}_${isManager ? 'manager' : 'worker'}.png`;
}

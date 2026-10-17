import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Civilization,
  ConfigResponse,
  DecisionRecord,
  Narrative,
  PublicRun,
  RequestRecord,
  RunConfig,
  Snapshot,
  VisibleView,
  World,
  WorldEvent,
} from '../shared/types';
import { viewFor } from '../engine/index';
import { decodeArchive, isArchive } from '../shared/archive';
import { Universe3D } from './Universe3D';
import { HumanControlPanel, type HumanDecisionPayload, type HumanGuidance, type HumanSnapshot } from './HumanControlPanel';
import { MajorEventToast } from './MajorEventToast';
import { groupMajorAlerts, humanMajorCandidates, selectMajorEvents, type MajorAlert } from './importantEvents';
import { civilizationIdentities, civilizationIdentity, projectObserverTimeline, recentCivilizationObservations, type ObserverTimelineItem } from './observer';

type Tab = 'summary' | 'civilizations' | 'actions' | 'consequences' | 'references';
type ErrorKind = 'config' | 'engine' | 'import' | 'llm' | 'storage';
type AppError = { kind: ErrorKind; message: string };
type ExtendedRun = PublicRun & {
  humanCivilizationId?: string | null;
  usedRequests?: number;
  phase?: string;
  llmParameters?: { provider?: string; model?: string; verified?: boolean };
  committedIds?: string[];
  narrativeError?: string;
};
type ExtendedConfig = ConfigResponse & { verified?: boolean; protocol?: string };
type SnapshotWire = Snapshot | Record<string, unknown>;
type StoredSnapshot = { wire: SnapshotWire; snapshot: Snapshot };
type RunStatusResponse = Pick<ExtendedRun, 'id' | 'status' | 'phase' | 'usedRequests' | 'llmParameters' | 'error' | 'narrativeError' | 'requestLog'> & {
  tick: number;
  pendingTick: ExtendedRun['pendingTick'];
};

type HumanResponse = HumanSnapshot & { guidance?: HumanGuidance | null };

const DEFAULT_CONFIG: RunConfig = {
  seed: 'orion-2', civilizationCount: 12, segmentTicks: 100, maxTicks: 500,
  mode: 'llm', concurrency: 4, timeoutMs: 12_000, maxOutputTokens: 800,
  requestLimit: 500, failurePolicy: 'pause',
};

const layerLabels: Record<string, string> = {
  universe: '这段时代', civilization: '各文明的经历', relation: '关键时刻', reflection: '目前的结局',
};
const statusLabels: Record<string, string> = {
  idle: '准备就绪', running: '正在运行', paused: '已暂停', completed: '观察完成', error: '需要处理',
};
const actionLabels: Record<string, string> = {
  develop: '发展', explore: '探索', hide: '隐匿', defend: '防御', contact: '联络', broadcast: '广播',
  cooperate: '合作', strike: '攻击', salvage: '回收', wait: '观望',
};
const requestKindLabels: Record<RequestRecord['kind'], string> = {
  personality: '人格请求', decision: '决策请求', narrative: '叙事请求',
};
const requestStatusLabels: Record<RequestRecord['status'], string> = {
  pending: '进行中', success: '成功', failed: '失败', fallback: '已回退',
};
const actionThirdPerson: Record<string, string> = {
  develop: '扩建了研究设施', explore: '扩大了观测范围', hide: '降低了自身信号', defend: '加强了防护',
  contact: '把信号发往了目标文明', broadcast: '向周围文明广播了信号', cooperate: '发起了合作请求',
  strike: '发起了攻击', salvage: '派出了回收任务', wait: '选择了等待',
};
const eventKindLabels: Record<string, string> = {
  genesis: '创世', initialization: '初始化', commit: '轮次提交', observation: '观测',
  'decision-applied': '行动提交', 'attack-launched': '攻击发射', 'attack-arrived': '攻击抵达',
  'message-received': '消息抵达', 'broadcast-received': '广播抵达', 'site-discovery': '资源发现',
  salvage: '回收结算', cooperation: '合作结算', 'environment-change': '环境变化', warning: '环境警报',
  income: '收入结算', transmission: '信号发出', 'transmission-launched': '信号发出', 'attack-warning': '攻击预警',
  'salvage-failed': '回收未完成', 'decision-rejected': '行动未提交', 'attack-impact': '攻击结果',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const raw = await response.text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const data = body as { error?: string; code?: string; run?: PublicRun } | null;
    const error = new Error(data?.error || `请求失败（${response.status}）`) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  const isExport = path.split('?')[0].endsWith('/export');
  return (isExport || !isArchive(body) ? body : decodeArchive<T>(body)) as T;
}

function jsonBody(value: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(value) }; }

function runFromResponse(value: unknown): ExtendedRun | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { run?: unknown };
  const run = candidate.run && typeof candidate.run === 'object' ? candidate.run : value;
  return run && typeof run === 'object' && 'id' in run && 'world' in run ? run as ExtendedRun : null;
}

function formatNumber(value: number | undefined, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function sourceLabel(source?: string) {
  if (source === 'llm') return '真实 LLM';
  if (source === 'template') return '显式模板';
  if (source === 'human') return '用户指令';
  return '离线规则';
}

function modeLabel(mode?: string) {
  if (mode === 'llm') return '真实 LLM';
  if (mode === 'mixed') return '混合';
  return '离线规则';
}

function position(value: number, axis: 'x' | 'y') {
  const n = Number(value) || 0;
  return (Math.abs(n) <= 1 ? n * 100 : n) + (axis === 'y' ? 0 : 0);
}

function observedEventText(event: WorldEvent, world: World): string {
  const names = new Map(world.civilizations.map((civ, index) => [civ.id, civilizationIdentity(civ, index).label]));
  const actors = event.participants.map((id) => names.get(id) ?? id);
  const actor = actors[0] ?? '一个文明';
  const action = typeof event.facts?.action === 'string' ? event.facts.action : '';
  if (event.kind === 'decision-applied' && action) return `${actor}${actionThirdPerson[action] ?? `完成了${action}行动`}`;
  if (event.kind === 'decision-rejected') return `${actor}的行动没有通过冻结视图校验`;
  if (event.kind === 'transmission-launched' || event.kind === 'transmission') {
    const transit = world.transits.find((item) => item.payload.launchEventId === event.eventId);
    const target = transit ? names.get(transit.toId) : undefined;
    return target ? `${actor}把信号发往了${target}` : `${actor}发出了信号`;
  }
  if (event.kind === 'attack-launched') return `${actor}发起了攻击`;
  if (event.kind === 'attack-arrived' || event.kind === 'attack-impact') return `${actor}收到了攻击结果`;
  if (event.kind === 'message-received' || event.kind === 'broadcast-received') return `${actor}收到了新的信号`;
  if (event.kind === 'observation') return `${actor}观测到了新的远方文明`;
  if (event.kind === 'income') return `${actor}获得了本轮收入`;
  if (event.kind === 'salvage-failed') return `${actor}的回收任务没有找到可用资源`;
  if (event.kind === 'environment' || event.kind === 'environment-change') return '一场环境扰动穿过了这个区域';
  if (event.kind === 'warning' || event.kind === 'attack-warning') return `${actor}收到了接近中的轨迹警报`;
  if (event.kind === 'commit' || event.kind === 'genesis') return event.summary.replace(/第 (\d+) 轮完整提交/, '第 $1 轮完成');
  if (event.kind === 'initialization') return '这个区域建立了独立文明和有限资源点';
  return event.summary;
}

function narrativeDisplayText(text: string): string {
  return text.split('\n').map((line) => {
    const range = line.match(/^第 (\d+) 轮：A distant civilization was observed at range ([\d.]+)\.?$/);
    if (range) return `第 ${range[1]} 轮：在 ${range[2]} 个单位外观测到一个远方文明。`;
    const action = line.match(/^第 (\d+) 轮：Action ([a-z-]+) completed\.?$/);
    if (action) return `第 ${action[1]} 轮：一次${({ develop: '发展', explore: '探索', hide: '隐匿', defend: '防御', contact: '联络', broadcast: '广播', cooperate: '合作', strike: '攻击', salvage: '回收', wait: '等待' } as Record<string, string>)[action[2]] ?? action[2]}行动完成。`;
    return line.replace('The sector initialized with independent civilizations and finite sites.', '这个区域建立了独立文明和有限资源点。')
      .replace('Bounded local production was credited.', '本地生产已结算。')
      .replace('A resource signature was detected.', '检测到资源信号。')
      .replace('A transmission was launched.', '一条信号已发出。')
      .replace('A strike was launched toward an uncertain observed location.', '一次攻击已发射，目标位置仍有不确定性。')
      .replace('An approaching trajectory emitted a detectable signature.', '接近中的轨迹发出了可检测信号。');
  }).join('\n');
}

function classifyError(error: unknown, fallback: ErrorKind = 'engine'): AppError {
  const message = error instanceof Error ? error.message : '发生未知错误';
  const lower = message.toLowerCase();
  if (fallback === 'config') return { kind: 'config', message };
  if (fallback === 'import') return { kind: 'import', message };
  if (fallback === 'storage') return { kind: 'storage', message };
  if (lower.includes('llm') || lower.includes('model') || lower.includes('provider') || lower.includes('deepseek')) return { kind: 'llm', message };
  return { kind: fallback, message };
}

function getStoredSnapshot(): Promise<StoredSnapshot | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cosmic-civilizations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('snapshots', 'readonly');
      const get = transaction.objectStore('snapshots').get('latest-v1');
      get.onsuccess = () => {
        const wire = get.result as SnapshotWire | undefined;
        if (!wire) { resolve(null); return; }
        resolve({ wire, snapshot: isArchive(wire) ? decodeArchive<Snapshot>(wire) : wire as Snapshot });
      };
      get.onerror = () => reject(get.error ?? new Error('无法读取本地快照'));
    };
    request.onerror = () => reject(request.error ?? new Error('本地存储不可用'));
  });
}

function saveStoredSnapshot(snapshot: SnapshotWire): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cosmic-civilizations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(snapshot, 'latest-v1');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法保存本地快照'));
    };
    request.onerror = () => reject(request.error ?? new Error('本地存储不可用'));
  });
}

function StarMap({ world, selectedId, onSelect }: { world: World; selectedId: string | null; onSelect: (id: string) => void }) {
  const civs = world.civilizations ?? [];
  const sites = world.sites ?? [];
  const transits = world.transits ?? [];
  const coords = (p: { x: number; y: number }) => ({ x: Math.max(4, Math.min(96, position(p.x, 'x'))), y: Math.max(5, Math.min(95, position(p.y, 'y'))) });
  const byId = new Map(civs.map((c) => [c.id, c]));
  return (
    <div className="map-wrap" aria-label="文明星图">
      <svg className="star-map" viewBox="0 0 100 100" role="img">
        <title>第 {world.tick} 轮的文明位置、资源和在途事件</title>
        <rect className="map-field" x="0" y="0" width="100" height="100" rx="3" />
        {sites.map((site) => { const p = coords(site.position); return <g key={site.id} className="map-site"><path d={`M ${p.x} ${p.y - 1.7} L ${p.x + 1.7} ${p.y} L ${p.x} ${p.y + 1.7} L ${p.x - 1.7} ${p.y} Z`} /><title>{site.id} · {site.kind} · {formatNumber(site.resources)}</title></g>; })}
        {transits.map((transit) => { const from = byId.get(transit.fromId); const to = byId.get(transit.toId); if (!from || !to) return null; const a = coords(from.position); const b = coords(to.position); const attack = transit.kind === 'attack'; const environment = transit.kind === 'environment' || transit.kind === 'warning'; return <g key={transit.id} className={`map-transit ${attack ? 'attack' : environment ? 'environment' : 'signal'}`}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} /><circle cx={b.x} cy={b.y} r="1.1"><title>{transit.id} · {transit.kind} · {transit.arrivesAt === world.tick ? '本轮到达' : `第 ${transit.arrivesAt} 轮到达`}</title></circle></g>; })}
        {civs.map((civ) => { const p = coords(civ.position); const active = selectedId === civ.id; return <g key={civ.id} className={`map-civ ${active ? 'selected' : ''} ${civ.alive ? '' : 'dead'}`} onClick={() => onSelect(civ.id)} tabIndex={0} role="button" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(civ.id); }}><circle cx={p.x} cy={p.y} r={active ? 3.7 : 2.8} fill={civ.color} /><circle className="map-civ-ring" cx={p.x} cy={p.y} r={active ? 5.2 : 4.4} /><text x={p.x + 4.5} y={p.y + 1.2}>{civ.name}</text><title>{civ.id} · {civ.name} · {civ.alive ? '存活' : '已毁灭'}</title></g>; })}
      </svg>
      <div className="map-legend"><span><i className="legend-dot live" />文明</span><span><i className="legend-line" />信号</span><span><i className="legend-line danger" />攻击</span><span><i className="legend-line environment" />环境</span><span><i className="legend-diamond" />资源点</span></div>
    </div>
  );
}

function Metric({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }

function ErrorBanner({ error, onDismiss }: { error: AppError; onDismiss: () => void }) {
  return <div className={`error-banner error-${error.kind}`} role="alert"><div><strong>{error.kind === 'llm' ? 'LLM 请求需要处理' : error.kind === 'storage' ? '本地恢复不可用' : error.kind === 'import' ? '导入未完成' : error.kind === 'config' ? '配置读取失败' : '引擎请求失败'}</strong><p>{error.message}</p></div><button className="icon-button" onClick={onDismiss} aria-label="关闭错误提示">×</button></div>;
}

const importantEventKinds = new Set(['commit', 'genesis', 'decision-applied', 'decision-rejected', 'attack-launched', 'attack-arrived', 'attack-impact', 'attack-warning', 'message-received', 'broadcast-received', 'transmission-launched', 'salvage', 'salvage-failed', 'cooperation', 'cooperation-result', 'environment', 'environment-change', 'warning', 'site-discovery']);

function Timeline({ run, selectedEventId, onSelect, showAll, onToggleAll }: { run: ExtendedRun; selectedEventId: string | null; onSelect: (id: string) => void; showAll: boolean; onToggleAll: () => void }) {
  const events = [...(run.world.events ?? [])].sort((a, b) => a.occurredTick - b.occurredTick || a.eventId.localeCompare(b.eventId));
  const observerItems = projectObserverTimeline(run.world, run.history);
  const [visibleCount, setVisibleCount] = useState(160);
  useEffect(() => { setVisibleCount(160); }, [run.id, showAll]);
  if (!events.length) return <div className="empty-state">事件会按轮次出现在这里。</div>;
  const visibleCountSource = showAll ? events : observerItems;
  const selectedIndex = selectedEventId ? visibleCountSource.findIndex((item) => showAll ? (item as WorldEvent).eventId === selectedEventId : (item as ObserverTimelineItem).eventIds.includes(selectedEventId)) : -1;
  const windowStart = Math.max(0, visibleCountSource.length - visibleCount);
  const selectedPinned = selectedIndex >= 0 && selectedIndex < windowStart ? visibleCountSource[selectedIndex] : null;
  const renderedEvents = selectedPinned ? [selectedPinned, ...visibleCountSource.slice(windowStart)] : visibleCountSource.slice(windowStart);
  const hasEarlier = windowStart > 0;
  const eventLabel = showAll ? `全部 ${visibleCountSource.length} 条原始记录` : `观察摘要 ${visibleCountSource.length} 条`;
  const renderRaw = (event: WorldEvent) => <button key={event.eventId} className={`timeline-item ${selectedEventId === event.eventId ? 'active' : ''}`} onClick={() => onSelect(event.eventId)}><span className="timeline-tick">T{event.occurredTick}</span><span className="timeline-copy"><strong>{eventKindLabels[event.kind] ?? event.kind}</strong><span>{observedEventText(event, run.world)}</span><small>{event.source === 'engine' ? '引擎事实' : sourceLabel(event.source)} · {event.observations?.length ?? 0} 个观察记录</small></span></button>;
  const renderObserver = (item: ObserverTimelineItem) => <div key={item.id} className={`timeline-item observer-item ${item.eventIds.includes(selectedEventId ?? '') ? 'active' : ''}`}><button className="observer-main" onClick={() => item.eventIds[0] && onSelect(item.eventIds[0])}><span className="timeline-tick">T{item.fromTick && item.toTick ? `${item.fromTick}—${item.toTick}` : item.tick}</span><span className="timeline-copy"><strong>{item.title}</strong><span>{item.text}</span><small>{item.eventIds.length ? `${item.eventIds.length} 条原始事件 · 点击查看证据` : '由当前时点状态计算'}</small></span></button>{item.eventIds.length ? <details className="observer-refs" aria-label="原始事件引用" onClick={(event) => event.stopPropagation()}><summary>展开 {item.eventIds.length} 条原始依据</summary><div>{item.eventIds.map((eventId) => <button key={eventId} onClick={() => onSelect(eventId)}>原始 {eventId}</button>)}</div></details> : null}</div>;
  return <><div className="timeline-toolbar"><span>{eventLabel} · 已显示最近 {Math.min(visibleCount, visibleCountSource.length)} 条{selectedPinned ? ' · 已定位引用' : ''}</span><div className="button-row"><button className="text-button" onClick={() => setVisibleCount((count) => Math.min(visibleCountSource.length, count + 160))} disabled={!hasEarlier}>{hasEarlier ? '再显示160条较早记录' : '已显示全部'}</button><button className="text-button" onClick={onToggleAll}>{showAll ? '只看观察摘要' : '查看全部原始事件'}</button></div></div><div className="timeline">{showAll ? renderedEvents.map((event) => renderRaw(event as WorldEvent)) : renderedEvents.map((item) => renderObserver(item as ObserverTimelineItem))}</div></>;
}

function narrativeCardCivLabel(cardId: string, civilizations: Civilization[]): string | null {
  const match = cardId.match(/^v2-civ-(civ-\d+)$/) ?? cardId.match(/^civ-(civ-\d+)$/) ?? cardId.match(/^v2-relation-(civ-\d+)-(civ-\d+)$/);
  if (!match) return null;
  const ids = match.slice(1).filter(Boolean);
  return ids.map((id) => { const civ = civilizations.find((item) => item.id === id); return civ ? civilizationIdentity(civ, civilizations.indexOf(civ)).label : id; }).join(' → ');
}

function NarrativeView({ narratives, civilizations, narrativeError, onGenerate, onEventClick }: { narratives: Narrative[]; civilizations: Civilization[]; narrativeError?: string; onGenerate: (template: boolean) => void; onEventClick: (eventId: string) => void }) {
  return <section className="narrative-card panel"><div className="panel-heading"><div><p className="eyebrow">结局叙事</p><h2>把这段时代讲清楚</h2><p className="narrative-lede">时间跨度、文明往来和仍在途的任务都只来自已核对的事实卡。</p></div><div className="button-row"><button className="button quiet" onClick={() => onGenerate(true)}>用模板生成</button><button className="button primary small" onClick={() => onGenerate(false)}>重试真实生成</button></div></div>{narrativeError && <p className="inline-error">{narrativeError}</p>}{narratives.length === 0 ? <div className="empty-state">还没有结局叙事。生成前，事件事实会先被整理成可引用的卡片。</div> : narratives.slice().reverse().map((narrative, narrativeIndex) => <details className="narrative narrative-history" key={narrative.id} open={narrativeIndex === 0}><summary className="narrative-toggle"><div className="narrative-title-row"><div><h3>{narrative.title}</h3><p className="narrative-range">第 {narrative.fromTick}—{narrative.toTick} 轮 · {narrative.cards.length} 张事实卡</p></div><div className="narrative-meta"><span className="badge">{sourceLabel(narrative.source)}</span><span>{narrative.generatedBy}</span></div></div></summary><div className="narrative-body"><div className="narrative-sections">{narrative.sections.map((section, index) => { const selectedIds=new Set(section.factIds); const selectedCards=section.factIds.map(id=>narrative.cards.find(card=>card.id===id)).filter((card):card is Narrative['cards'][number]=>Boolean(card)); const remaining=narrative.cards.filter(card=>card.layer===section.layer&&!selectedIds.has(card.id)); const renderCard=(card:Narrative['cards'][number])=>{ const civLabel=narrativeCardCivLabel(card.id,civilizations); return <div className="narrative-fact" key={card.id}>{civLabel && <div className="narrative-card-identity muted">观察对象：{civLabel}</div>}<p>{narrativeDisplayText(card.text)}</p>{card.eventIds.length ? <details className="narrative-source"><summary>展开 {card.eventIds.length} 条事件依据</summary><div className="narrative-refs">{card.eventIds.map((eventId) => <button key={eventId} onClick={() => onEventClick(eventId)}>跳转 {eventId}</button>)}</div></details> : <small>无事件引用</small>}</div>; }; return <div className="narrative-section" key={`${narrative.id}-${section.layer}-${index}`}><div className="section-heading"><span className="section-label">{layerLabels[section.layer] ?? section.layer}</span><span className="badge">事实</span></div><div className="narrative-facts">{selectedCards.length ? selectedCards.map(renderCard) : <p>{narrativeDisplayText(section.text)}</p>}</div>{remaining.length > 0 && <details className="narrative-complete"><summary>展开其余 {remaining.length} 张完整事实卡</summary><div className="narrative-facts">{remaining.map(renderCard)}</div></details>}</div>; })}</div>{narrative.inferences.length > 0 && <div className="narrative-section narrative-inferences"><div className="section-heading"><span className="section-label">推测</span><span className="badge">仅供参考</span></div>{narrative.inferences.map((text,index)=><p key={index}>{text}</p>)}</div>}{narrative.fallbackReason && <p className="narrative-fallback">来源说明：{narrative.fallbackReason}</p>}</div></details>)}</section>;
}

export default function App() {
  const [config, setConfig] = useState<ExtendedConfig | null>(null);
  const [configError, setConfigError] = useState<AppError | null>(null);
  const [form, setForm] = useState<CreateForm>({ seed: DEFAULT_CONFIG.seed, civilizationCount: 12, segmentTicks: 100, mode: 'llm', failurePolicy: 'pause' });
  const [run, setRun] = useState<ExtendedRun | null>(null);
  const [selectedCiv, setSelectedCiv] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [speed, setSpeed] = useState(1);
  const [isPausing, setIsPausing] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [civView, setCivView] = useState<VisibleView | null>(null);
  const [human, setHuman] = useState<HumanSnapshot | null>(null);
  const [humanSubmitting, setHumanSubmitting] = useState(false);
  const [humanPerspective, setHumanPerspective] = useState<'observer' | 'human'>('observer');
  const [majorAlerts, setMajorAlerts] = useState<MajorAlert[]>([]);
  const [humanAlertEvent, setHumanAlertEvent] = useState<{ sourceEventId: string; occurredTick: number; observedTick: number; kind: string; summary: string } | null>(null);
  const [replayTick, setReplayTick] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(true);
  const [showRestore, setShowRestore] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const epoch = useRef(0);
  const runRef = useRef<ExtendedRun | null>(null);
  const inFlight = useRef(false);
  const pausingRef = useRef(false);
  const pauseNonceRef = useRef(0);
  const pollTimer = useRef<number | null>(null);
  const statusPollInFlight = useRef(false);
  const humanPollTimer = useRef<number | null>(null);
  const humanPollInFlight = useRef(false);
  const majorSeenRef = useRef<Set<string>>(new Set());
  const majorCursorRef = useRef<{ runId: string; mode: 'observer' | 'human'; worldTick: number; humanObservedTick: number } | null>(null);
  const speedRef = useRef(speed);
  const timer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { runRef.current = run; }, [run]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    let alive = true;
    api<ExtendedConfig>('/api/config').then((value) => { if (alive) { setConfig(value); setForm((previous) => ({ ...previous, seed: value.defaults.seed, civilizationCount: value.defaults.civilizationCount, segmentTicks: Math.max(1, value.defaults.segmentTicks), mode: value.defaults.mode === 'mixed' ? 'llm' : value.defaults.mode, failurePolicy: value.defaults.failurePolicy })); } }).catch((reason) => { if (alive) setConfigError(classifyError(reason, 'config')); });
    getStoredSnapshot().then((snapshot) => { if (!alive || !snapshot) return; void restoreLocalSnapshot(snapshot).then((restored) => { if (alive && !restored) setShowRestore(true); }); }).catch(() => { if (alive) setStorageAvailable(false); });
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
  }, []);

  const world = replayTick === null ? run?.world : run?.history.find((frame) => frame.tick === replayTick)?.world;
  const displayWorld = world ?? run?.world;
  const isReplay = replayTick !== null;
  const humanMode = Boolean(run && !isReplay && humanPerspective === 'human' && run.humanCivilizationId);
  const effectiveSelectedCivId = humanMode ? run?.humanCivilizationId ?? selectedCiv : selectedCiv;
  const selected = displayWorld?.civilizations.find((civ) => civ.id === effectiveSelectedCivId) ?? displayWorld?.civilizations[0];
  const events = isReplay ? (run?.world.events ?? []).filter((event) => event.occurredTick <= (replayTick ?? 0)) : (displayWorld?.events ?? []);
  const displayHistory = run ? (isReplay ? run.history.filter((frame) => frame.tick <= (replayTick ?? 0)) : run.history) : [];
  const displayRequestLog = run ? (isReplay ? run.requestLog.filter((record) => record.tick <= (replayTick ?? 0)) : run.requestLog) : [];
  const sideRun = run && displayWorld ? { ...run, world: { ...displayWorld, events }, history: displayHistory, requestLog: displayRequestLog } : run;
  const selectedEventRaw = events.find((event) => event.eventId === selectedEventId);
  const selectedEvent = selectedEventRaw && isReplay ? { ...selectedEventRaw, observations: selectedEventRaw.observations.filter((observation) => observation.observedTick <= (replayTick ?? 0)) } : selectedEventRaw;
  const displaySceneWorld = displayWorld ? { ...displayWorld, events } : displayWorld;
  const aliveCount = displayWorld?.civilizations.filter((civ) => civ.alive).length ?? 0;
  const usedRequests = run?.usedRequests ?? run?.requestLog.length ?? 0;
  const phase = run?.phase ?? (run?.pendingTick?.stage ?? (run?.status === 'completed' ? 'completed' : 'idle'));
  const configuredRequestLimit = config?.defaults.requestLimit ?? 500;
  const requestLimit = run?.config.requestLimit ?? configuredRequestLimit;
  const degraded = Boolean(run?.pendingTick?.failure || run?.error || run?.config.mode === 'mixed');
  const estimate = form.civilizationCount + form.civilizationCount * form.segmentTicks + 1;

  useEffect(() => {
    if (humanMode && run?.humanCivilizationId) {
      if (selectedCiv !== run.humanCivilizationId) setSelectedCiv(run.humanCivilizationId);
      return;
    }
    if (!selectedCiv && displayWorld?.civilizations[0]) setSelectedCiv(displayWorld.civilizations[0].id);
    if (selectedCiv && displayWorld && !displayWorld.civilizations.some((civ) => civ.id === selectedCiv)) setSelectedCiv(displayWorld.civilizations[0]?.id ?? null);
  }, [displayWorld, selectedCiv, humanMode, run?.humanCivilizationId]);

  useEffect(() => {
    if (!run || isReplay || (run.status !== 'running' && !run.pendingTick)) return;
    const expectedEpoch = epoch.current;
    const expectedId = run.id;
    const poll = async () => {
      if (statusPollInFlight.current) return;
      statusPollInFlight.current = true;
      try {
        const snapshot = await api<RunStatusResponse>(`/api/runs/${expectedId}/status`);
        if (epoch.current !== expectedEpoch || runRef.current?.id !== expectedId) return;
        if (snapshot.tick > (runRef.current?.world.tick ?? -1)) {
          const latest = await api<PublicRun>(`/api/runs/${expectedId}`);
          if (epoch.current !== expectedEpoch || runRef.current?.id !== expectedId) return;
          setRun((current) => current && current.id === expectedId ? latest as ExtendedRun : current);
          runRef.current = latest as ExtendedRun;
          return;
        }
        const remote = snapshot;
        setRun((current) => {
          if (!current || current.id !== expectedId) return current;
          return {
            ...current,
            status: snapshot.status,
            phase: remote.phase ?? current.phase,
            usedRequests: remote.usedRequests ?? current.usedRequests,
            llmParameters: remote.llmParameters ?? current.llmParameters,
            requestLog: snapshot.requestLog ?? current.requestLog,
            pendingTick: snapshot.pendingTick,
            error: snapshot.error,
            narrativeError: remote.narrativeError,
          };
        });
      } catch { /* A transient poll failure should not interrupt the active step. */ }
      finally { statusPollInFlight.current = false; }
    };
    void poll();
    pollTimer.current = window.setInterval(() => { void poll(); }, 700);
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current); pollTimer.current = null; };
  }, [run?.id, run?.status, Boolean(run?.pendingTick), isReplay]);

  useEffect(() => {
    if (!selected || !run) { setCivView(null); return; }
    if (isReplay) {
      try {
        const cutoff = replayTick ?? displayWorld?.tick ?? 0;
        const historical = viewFor(displayWorld ?? run.world, selected.id);
        setCivView({ ...historical, observations: historical.observations.filter((observation) => observation.observedTick <= cutoff) });
      } catch { setCivView(null); }
      return;
    }
    if (run.humanCivilizationId === selected.id && human?.view) {
      setCivView(human.view);
      return;
    }
    let live = true;
    api<VisibleView>(`/api/runs/${run.id}/view/${encodeURIComponent(selected.id)}`).then((view) => { if (live) setCivView(view); }).catch(() => { if (live) setCivView(null); });
    return () => { live = false; };
  }, [run?.id, run?.world.tick, run?.humanCivilizationId, displayWorld?.tick, selected?.id, human?.tick, isReplay, replayTick]);

  const applyRun = useCallback((next: PublicRun, expectedEpoch: number, expectedId?: string) => {
    if (expectedEpoch !== epoch.current || (expectedId && runRef.current?.id !== expectedId)) return false;
    setRun(next as ExtendedRun); runRef.current = next as ExtendedRun; return true;
  }, []);

  const loadHuman = useCallback(async (expectedEpoch: number, expectedId: string): Promise<HumanSnapshot | null> => {
    try {
      const response = await api<HumanResponse>(`/api/runs/${encodeURIComponent(expectedId)}/human`);
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return null;
      const next: HumanSnapshot = { ...response, guidance: response.guidance ?? null };
      if ((next.civilizationId ?? null) !== (runRef.current?.humanCivilizationId ?? null)) return null;
      setHuman(next);
      if (next.view && runRef.current?.humanCivilizationId === next.civilizationId && selectedCiv === next.civilizationId) setCivView(next.view);
      return next;
    } catch (reason) {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason));
      return null;
    }
  }, [selectedCiv]);

  useEffect(() => {
    if (!run?.humanCivilizationId || isReplay) {
      setHuman(null);
      if (humanPollTimer.current) window.clearInterval(humanPollTimer.current);
      humanPollTimer.current = null;
      return;
    }
    const expectedEpoch = epoch.current;
    const expectedId = run.id;
    const poll = async () => {
      if (humanPollInFlight.current) return;
      humanPollInFlight.current = true;
      try { await loadHuman(expectedEpoch, expectedId); } finally { humanPollInFlight.current = false; }
    };
    void poll();
    humanPollTimer.current = window.setInterval(() => { void poll(); }, 700);
    return () => { if (humanPollTimer.current) window.clearInterval(humanPollTimer.current); humanPollTimer.current = null; };
  }, [run?.id, run?.humanCivilizationId, isReplay, run?.world.tick, loadHuman]);

  useEffect(() => {
    if (!run || isReplay) {
      majorCursorRef.current = null;
      majorSeenRef.current = new Set();
      setMajorAlerts((current) => current.length ? [] : current);
      setHumanAlertEvent(null);
      return;
    }
    const mode = humanPerspective === 'human' && run.humanCivilizationId ? 'human' : 'observer';
    let cursor = majorCursorRef.current;
    if (!cursor || cursor.runId !== run.id) {
      cursor = { runId: run.id, mode, worldTick: run.world.tick, humanObservedTick: human?.tick ?? run.world.tick };
      majorCursorRef.current = cursor;
      majorSeenRef.current = new Set();
      setMajorAlerts([]);
      setHumanAlertEvent(null);
      return;
    }
    if (cursor.mode !== mode) {
      cursor.mode = mode;
      cursor.worldTick = run.world.tick;
      cursor.humanObservedTick = human?.tick ?? run.world.tick;
      setMajorAlerts([]);
      return;
    }
    const candidates = mode === 'human'
      ? (human?.view && human.civilizationId === run.humanCivilizationId ? humanMajorCandidates({ ...human.view, observations: human.view.observations.filter((observation) => observation.observedTick > cursor.humanObservedTick) }) : [])
      : run.world.events.filter((event) => event.occurredTick > cursor.worldTick).map((event) => ({ event: { ...event, participants: event.participants.map((id) => { const civ = run.world.civilizations.find((item) => item.id === id); return civ ? civilizationIdentity(civ, run.world.civilizations.indexOf(civ)).label : '相关文明'; }) } }));
    if (mode === 'human') cursor.humanObservedTick = Math.max(cursor.humanObservedTick, human?.tick ?? cursor.humanObservedTick);
    else cursor.worldTick = Math.max(cursor.worldTick, run.world.tick);
    const fresh = groupMajorAlerts(selectMajorEvents(run.id, candidates, majorSeenRef.current));
    if (!fresh.length) return;
    fresh.forEach((alert) => alert.key.split('|').forEach((key) => majorSeenRef.current.add(key)));
    setMajorAlerts((current) => [...current, ...fresh].slice(-3));
  }, [run?.id, run?.world.tick, run?.world.events.length, human?.tick, human?.view?.observations.length, humanPerspective, isReplay]);

  const persistRunSnapshot = async (expectedEpoch: number, expectedId: string): Promise<boolean> => {
    try {
      const snapshot = await api<SnapshotWire>(`/api/runs/${expectedId}/export`);
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return false;
      await saveStoredSnapshot(snapshot);
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setStorageAvailable(true);
      return expectedEpoch === epoch.current && runRef.current?.id === expectedId;
    } catch {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setStorageAvailable(false);
      return false;
    }
  };

  const takeOverCivilization = async (civilizationId: string) => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current;
    const expectedId = run.id;
    try {
      const response = await api<unknown>(`/api/runs/${encodeURIComponent(expectedId)}/control`, jsonBody({ civilizationId }));
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      const next = runFromResponse(response);
      if (next) applyRun(next, expectedEpoch, expectedId);
      setHuman(null);
      setCivView(null);
      setSelectedCiv(civilizationId);
      setHumanPerspective('human');
      setHumanAlertEvent(null);
      const prepared = await prepareHumanTurn(expectedEpoch, expectedId);
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      const stored = await persistRunSnapshot(expectedEpoch, expectedId);
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      setNotice(prepared?.waiting ? `已接管这个文明，当前回合已准备好。行动面板只显示它在冻结视图中知道的目标和消息。${stored ? '' : '本机恢复副本保存失败。'}` : '已接管这个文明，正在准备当前回合的冻结视图…');
    } catch (reason) {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason));
    }
  };

  const releaseCivilization = async () => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current;
    const expectedId = run.id;
    try {
      const response = await api<unknown>(`/api/runs/${encodeURIComponent(expectedId)}/control`, jsonBody({ civilizationId: null }));
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      const next = runFromResponse(response);
      if (next) applyRun(next, expectedEpoch, expectedId);
      setHuman(null);
      setHumanPerspective('observer');
      setHumanAlertEvent(null);
      const stored = await persistRunSnapshot(expectedEpoch, expectedId);
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      setNotice(stored ? '已交还自主决策，接下来由模型或离线规则推进。' : '已交还自主决策，接下来由模型或离线规则推进；本机恢复副本保存失败。');
    } catch (reason) {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason));
    }
  };

  const submitHumanDecision = async (decision: HumanDecisionPayload) => {
    if (!run || isReplay || !human?.turnId || !run.humanCivilizationId || humanSubmitting) return;
    const expectedEpoch = epoch.current;
    const expectedId = run.id;
    const turnId = human.turnId;
    setHumanSubmitting(true);
    try {
      const next = await api<PublicRun>(`/api/runs/${encodeURIComponent(expectedId)}/human`, jsonBody({ turnId, decision }));
      if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return;
      applyRun(next, expectedEpoch, expectedId);
      setHuman((current) => current && current.turnId === turnId ? { ...current, waiting: false, guidance: { ...(current.guidance ?? {}), disabledReason: '本轮用户行动已提交，等待其他文明完成。' } } : current);
      setNotice('本轮用户行动已提交，正在完成其他文明并准备下一次用户回合。');
      await requestStep(expectedEpoch, expectedId, false);
      const nextHuman = await prepareHumanTurn(expectedEpoch, expectedId);
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId && nextHuman?.waiting) setNotice('本轮已完成，下一次用户回合已准备好。');
    } catch (reason) {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) {
        const message = reason instanceof Error ? reason.message : '用户行动未通过校验，请修改后重试。';
        setHuman((current) => current && current.turnId === turnId ? { ...current, waiting: true, guidance: { ...(current.guidance ?? {}), disabledReason: message } } : current);
        setError({ kind: 'engine', message });
      }
    } finally {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setHumanSubmitting(false);
    }
  };

  const requestStep = useCallback(async (expectedEpoch = epoch.current, expectedId = runRef.current?.id, scheduleNext = true) => {
    if (!expectedId || inFlight.current || pausingRef.current || isReplay) return;
    const pauseNonce = pauseNonceRef.current;
    const beforeHistoryLength = runRef.current?.history.length ?? 0;
    inFlight.current = true;
    try {
      const next = await api<PublicRun>(`/api/runs/${expectedId}/step`, jsonBody({}));
      const applied = applyRun(next, expectedEpoch, expectedId);
      if (applied && next.history.length > beforeHistoryLength) void persistRunSnapshot(expectedEpoch, expectedId);
      if (applied && scheduleNext && (next.status === 'running' || next.status === 'idle') && !pausingRef.current && pauseNonceRef.current === pauseNonce && !isReplay) {
        timer.current = window.setTimeout(() => { void requestStep(expectedEpoch, expectedId, true); }, Math.max(100, 860 / speedRef.current));
      }
    } catch (reason) {
      const payload = (reason as Error & { payload?: { run?: PublicRun } }).payload;
      if (payload?.run) applyRun(payload.run, expectedEpoch, expectedId);
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason));
    } finally { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) inFlight.current = false; }
  }, [applyRun, isReplay]);

  // A takeover must leave the user at an actionable frozen turn. The control
  // endpoint only changes ownership; when no user turn exists yet, prepare one
  // through the same atomic step path used by observer mode.
  const prepareHumanTurn = useCallback(async (expectedEpoch: number, expectedId: string): Promise<HumanSnapshot | null> => {
    let snapshot = await loadHuman(expectedEpoch, expectedId);
    if (!snapshot || snapshot.waiting || snapshot.busy || snapshot.submitted || runRef.current?.status === 'completed') return snapshot;
    await requestStep(expectedEpoch, expectedId, false);
    if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return null;
    snapshot = await loadHuman(expectedEpoch, expectedId);
    return snapshot;
  }, [loadHuman, requestStep]);

  const createRun = async () => {
    setError(null); setNotice(null); epoch.current += 1; const localEpoch = epoch.current;
    try {
      const next = await api<PublicRun>('/api/runs', jsonBody({ seed: form.seed, civilizationCount: form.civilizationCount, segmentTicks: form.segmentTicks, maxTicks: DEFAULT_CONFIG.maxTicks, mode: form.mode, requestLimit: configuredRequestLimit, failurePolicy: form.failurePolicy }));
      if (localEpoch !== epoch.current) return;
      setHuman(null); setHumanPerspective('observer'); setRun(next as ExtendedRun); runRef.current = next as ExtendedRun; setReplayTick(null); setShowSetup(false); setSelectedCiv(next.world.civilizations[0]?.id ?? null); setActiveTab('summary');
      if (next.status === 'running' || next.status === 'idle') void requestStep(localEpoch, next.id);
    } catch (reason) { if (localEpoch === epoch.current) setError(classifyError(reason)); }
  };

  const pause = async () => {
    if (!run || isReplay || isPausing) return;
    const expectedEpoch = epoch.current; const expectedId = run.id; if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } setIsPausing(true); setNotice('正在暂停当前轮次…'); pausingRef.current = true; pauseNonceRef.current += 1;
    try { const next = await api<PublicRun>(`/api/runs/${expectedId}/pause`, jsonBody({})); applyRun(next, expectedEpoch, expectedId); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason)); }
    finally { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) { pausingRef.current = false; setIsPausing(false); setNotice(null); } }
  };

  const resume = async (schedule = true) => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const next = await api<PublicRun>(`/api/runs/${expectedId}/resume`, jsonBody({})); if (applyRun(next, expectedEpoch, expectedId) && schedule) void requestStep(expectedEpoch, expectedId, true); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason)); }
  };

  const toggleRun = () => { if (isReplay) return; if (!run) return void createRun(); if (humanMode && human?.waiting && !human.submitted) { setNotice('当前是你的行动回合，请先提交行动。'); return; } if (run.status === 'running' || run.status === 'idle') return void pause(); if (run.status === 'paused' || run.status === 'error') return void resume(); };
  const openHistory = async (tick: number) => {
    if (!run) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    pauseNonceRef.current += 1;
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    pausingRef.current = true; setIsPausing(true);
    try {
      if (run.status === 'running' || run.status === 'idle') {
        const paused = await api<PublicRun>(`/api/runs/${expectedId}/pause`, jsonBody({}));
        if (!applyRun(paused, expectedEpoch, expectedId)) return;
      }
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) { setHumanAlertEvent(null); setHumanPerspective('observer'); setReplayTick(tick); setSelectedEventId(null); }
    } catch (reason) {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason));
    } finally {
      if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) { pausingRef.current = false; setIsPausing(false); }
    }
  };
  const reset = () => { const oldRunId = runRef.current?.id; epoch.current += 1; pauseNonceRef.current += 1; if (timer.current) window.clearTimeout(timer.current); if (pollTimer.current) window.clearInterval(pollTimer.current); if (humanPollTimer.current) window.clearInterval(humanPollTimer.current); timer.current = null; pollTimer.current = null; humanPollTimer.current = null; inFlight.current = false; pausingRef.current = false; humanPollInFlight.current = false; setHumanSubmitting(false); if (oldRunId) void api<PublicRun>(`/api/runs/${oldRunId}/cancel`, jsonBody({})).catch(() => {}); setHuman(null); setHumanAlertEvent(null); setHumanPerspective('observer'); setRun(null); runRef.current = null; setReplayTick(null); setSelectedEventId(null); setSelectedCiv(null); setShowSetup(true); setNotice('已重置，可用新的 seed 开始一场推演。'); setError(null); };
  const oneStep = async () => { if (!run || isReplay || run.status === 'completed') return; if (humanMode && human?.waiting && !human.submitted) { setNotice('当前是你的行动回合，单步不会跳过你的决定。'); return; } await requestStep(epoch.current, run.id, false); };
  const setSelection = (id: string) => { setSelectedCiv(id); setActiveTab('civilizations'); setDrawerOpen(true); };

  const extend = async (ticks: 50 | 100) => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const next = await api<PublicRun>(`/api/runs/${expectedId}/extend`, jsonBody({ ticks })); if (applyRun(next, expectedEpoch, expectedId) && (next.status === 'running' || next.status === 'idle')) void requestStep(expectedEpoch, expectedId, true); setNotice(`期限已增加 ${ticks} 轮。`); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason)); }
  };
  const fallback = async (enabled: boolean) => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const next = await api<PublicRun>(`/api/runs/${expectedId}/fallback`, jsonBody({ enabled })); if (applyRun(next, expectedEpoch, expectedId) && (next.status === 'running' || next.status === 'idle')) void requestStep(expectedEpoch, expectedId, true); setNotice(enabled ? '已开启离线回退；失败请求会显式标记为规则来源。' : '已关闭离线回退。'); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason)); }
  };
  const generateNarrative = async (template: boolean) => {
    if (!run || isReplay) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const next = await api<PublicRun>(`/api/runs/${expectedId}/narrative`, jsonBody({ template })); if (!applyRun(next, expectedEpoch, expectedId)) return; setActiveTab('summary'); const resultMessage = next.narrativeError ? '模型叙事生成失败，世界结果仍可查看' : '叙事已生成'; setNotice(resultMessage + '，正在保存本机恢复副本…'); const stored = await persistRunSnapshot(expectedEpoch, expectedId); if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setNotice(resultMessage + (stored ? '，已保存到本机恢复库。' : '；本地恢复不可用，当前运行仍已保留。')); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason, 'llm')); }
  };

  const exportSnapshot = async () => {
    if (!run) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const snapshot = await api<SnapshotWire>(`/api/runs/${expectedId}/export`); if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return; let stored = true; try { await saveStoredSnapshot(snapshot); setStorageAvailable(true); } catch { stored = false; setStorageAvailable(false); } if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return; const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `cosmic-${expectedId}-snapshot.json`; link.click(); URL.revokeObjectURL(link.href); setNotice(stored ? 'JSON 快照已导出并保存到本机恢复库。' : '本地恢复不可用；JSON 快照仍已导出，请妥善保存文件。'); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason, 'storage')); }
  };
  const exportMarkdown = async () => {
    if (!run) return;
    const expectedEpoch = epoch.current; const expectedId = run.id;
    try { const markdown = await api<string>(`/api/runs/${expectedId}/markdown`); if (expectedEpoch !== epoch.current || runRef.current?.id !== expectedId) return; const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `cosmic-${expectedId}-report.md`; link.click(); URL.revokeObjectURL(link.href); setNotice('Markdown 报告已导出。'); }
    catch (reason) { if (expectedEpoch === epoch.current && runRef.current?.id === expectedId) setError(classifyError(reason)); }
  };
  const adoptRun = (next: PublicRun, message: string) => {
    setHuman(null); setHumanAlertEvent(null); setHumanPerspective('observer'); setHumanSubmitting(false); setRun(next as ExtendedRun); runRef.current = next as ExtendedRun; setSelectedCiv(next.world.civilizations[0]?.id ?? null); setReplayTick(null); setShowRestore(false); setShowSetup(false); setNotice(message);
  };
  const restoreSnapshot = async (snapshot: SnapshotWire): Promise<boolean> => {
    majorCursorRef.current = null;
    majorSeenRef.current = new Set();
    setMajorAlerts([]);
    setHumanAlertEvent(null);
    epoch.current += 1;
    const expectedEpoch = epoch.current;
    pauseNonceRef.current += 1;
    if (timer.current) window.clearTimeout(timer.current);
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    timer.current = null; pollTimer.current = null; inFlight.current = false; statusPollInFlight.current = false; pausingRef.current = false; setIsPausing(false);
    try { const next = await api<PublicRun>('/api/import', jsonBody(snapshot)); if (expectedEpoch !== epoch.current) return false; adoptRun(next, '已导入，正在保存本机恢复副本…'); const stored = await persistRunSnapshot(expectedEpoch, next.id); if (expectedEpoch === epoch.current && runRef.current?.id === next.id) setNotice(stored ? '快照已导入并保存到本机恢复库。' : '快照已导入，但本地恢复不可用；当前运行仍已保留。'); return true; }
    catch (reason) { if (expectedEpoch === epoch.current) setError(classifyError(reason, 'import')); return false; }
  };
  const restoreLocalSnapshot = async (stored: StoredSnapshot): Promise<boolean> => {
    const expectedEpoch = epoch.current;
    try {
      let remote: ExtendedRun;
      try {
        remote = await api<ExtendedRun>(`/api/runs/${encodeURIComponent(stored.snapshot.runId)}`);
      } catch (reason) {
        const status = (reason as Error & { status?: number }).status;
        if (status === 404) return restoreSnapshot(stored.wire);
        throw reason;
      }
      if (expectedEpoch !== epoch.current) return false;
      if (remote.status === 'running' || remote.status === 'idle') {
        remote = await api<ExtendedRun>(`/api/runs/${encodeURIComponent(stored.snapshot.runId)}/pause`, jsonBody({}));
        if (expectedEpoch !== epoch.current) return false;
      }
      adoptRun(remote, '已优先读取服务端最新状态；本机快照保留作离线恢复。');
      return true;
    } catch (reason) {
      if (expectedEpoch === epoch.current) setError(classifyError(reason, 'engine'));
      return false;
    }
  };
  const restoreLocal = async () => { try { const stored = await getStoredSnapshot(); if (!stored) return setNotice('本机没有可恢复的快照。'); await restoreLocalSnapshot(stored); } catch (reason) { setStorageAvailable(false); setError(classifyError(reason, 'storage')); } };
  const importFile = async (file: File) => { try { if (file.size > 128 * 1024 * 1024) throw new Error('导入文件超过 128 MB 限制，请先缩小快照或使用服务端导出的分段结果。'); const snapshot = JSON.parse(await file.text()) as SnapshotWire; await restoreSnapshot(snapshot); } catch (reason) { setError(classifyError(reason, 'import')); } finally { if (fileRef.current) fileRef.current.value = ''; } };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (target?.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return;
      if (event.key === ' ') { event.preventDefault(); toggleRun(); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void oneStep(); }
      if (event.key === '+') setSpeed((current) => Math.min(4, current + .5));
      if (event.key === '-') setSpeed((current) => Math.max(.5, current - .5));
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); reset(); }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !humanMode) { const civs = displayWorld?.civilizations ?? []; if (!civs.length) return; const current = Math.max(0, civs.findIndex((civ) => civ.id === (selected?.id ?? selectedCiv))); const nextIndex = event.key === 'ArrowLeft' ? (current - 1 + civs.length) % civs.length : (current + 1) % civs.length; setSelectedCiv(civs[nextIndex].id); }
      if (event.key === 'Enter' && selectedEventId) { setActiveTab('references'); setDrawerOpen(true); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  const controlsDisabled = !run || isReplay || Boolean(humanMode && human?.waiting && !human.submitted);
  const canExtend = Boolean(run && !isReplay && run.status === 'completed' && run.terminalReason === '阶段结局');
  const extensionRemaining = Math.max(0, requestLimit - usedRequests);
  const extensionBudgetHint = (ticks: number) => run && run.config.mode !== 'offline' ? `续看 ${ticks} 轮预计最多 ${aliveCount}×${ticks}+1 = ${aliveCount * ticks + 1} 次基础请求；剩余 ${extensionRemaining}。不足时会按失败策略暂停或显式回退。` : null;
  const configStatus = config ? `${config.provider || 'LLM'} · ${config.model || '默认模型'}` : '正在读取 LLM 配置…';
  const observedLlmSuccess = Boolean(run?.requestLog.some((record) => (record.kind === 'personality' || record.kind === 'decision') && record.status === 'success' && record.source === 'llm'));
  const verified = Boolean(config?.verified || observedLlmSuccess);
  const latestBehaviorEvent = events.filter((event) => importantEventKinds.has(event.kind)).slice(-1)[0];
  const latestBehavior = latestBehaviorEvent && displayWorld ? observedEventText(latestBehaviorEvent, displayWorld) : null;
  const topStatusLabel = run?.humanCivilizationId && human?.waiting ? '等待我的行动' : run?.status === 'completed' ? '阶段完成' : run ? statusLabels[run.status] : '等待一场推演';

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">✦</span><div><p className="eyebrow">COSMIC CIVILIZATIONS</p><h1>宇宙文明推演器</h1></div></div><div className="topbar-status"><span className={`status-dot ${run?.status === 'running' ? 'on' : ''}`} /><span>{topStatusLabel}</span>{run && <><span className="topbar-divider" /><span>第 {displayWorld?.tick ?? 0} 轮</span><span>{modeLabel(run.config.mode)}</span></>}<span className="topbar-divider" /><span>{configStatus}</span>{verified ? <span className="verified">已验证</span> : <span className="unverified">未验证</span>}</div><button className="button menu-button" onClick={() => setDrawerOpen((open) => !open)} aria-expanded={drawerOpen}>文明详情</button></header>
    <main className="workspace">
      {configError && <ErrorBanner error={configError} onDismiss={() => setConfigError(null)} />}
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {run?.error && ['paused','error'].includes(run.status) && <div className="error-banner error-llm" role="alert"><div><strong>推演已暂停，需要处理一个未完成的行动</strong><p>{run.error.includes('resources') || run.error.includes('budget') ? '文明提出的行动超出了当前可用资源。' : '本轮请求未能完成。'} 已完成的请求和世界状态已保留。</p><details><summary>查看具体原因</summary><p>{run.error}</p></details><div className="button-row"><button className="button" onClick={toggleRun}>重试未完成请求</button><button className="button" onClick={() => void fallback(true)}>明确改用规则继续</button></div></div></div>}
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div>}
      {majorAlerts.length > 0 && <div className="major-toast-stack" aria-live="polite">{majorAlerts.map((alert) => <MajorEventToast key={alert.key} alert={alert} onLocate={() => { const firstEventId = alert.eventId.split(',')[0]; if (humanMode) { const observation = human?.view?.observations.find((item) => item.sourceEventId === firstEventId); if (observation) setHumanAlertEvent(observation); return; } setSelectedEventId(firstEventId); setActiveTab('references'); setDrawerOpen(true); window.requestAnimationFrame(() => document.getElementById(`event-detail-${firstEventId}`)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })); }} onPause={() => { void pause(); }} onDismiss={() => setMajorAlerts((current) => current.filter((item) => item.key !== alert.key))} />)}</div>}
      {showRestore && <div className="restore-bar"><span>发现本机上次保存的快照，可通过服务端校验后恢复。</span><div><button className="button small" onClick={() => void restoreLocal()}>恢复</button><button className="text-button" onClick={() => setShowRestore(false)}>忽略</button></div></div>}
      <section className={`hero-row ${humanMode ? 'hero-human' : ''}`}><div><p className="eyebrow">{humanMode ? '我方视角 / FIRST PERSON' : '观众席 / OBSERVER DECK'}</p><h2>{humanMode ? `${selected ? civilizationIdentity(selected, displayWorld?.civilizations.findIndex((civ) => civ.id === selected.id) ?? 0).label : '我方文明'} · 第 ${displayWorld?.tick ?? 0} 轮` : run ? `第 ${displayWorld?.tick ?? 0} 轮，${aliveCount} 个文明仍在发光` : '让一个宇宙从第一轮开始'}</h2><p className="hero-copy">{humanMode ? '你只会根据我方冻结视图做决定；观察者全景随时可以返回。' : latestBehavior ? <>正在发生：<strong>{latestBehavior}</strong> · 只呈现已经发生并可追溯的行为。</> : '每一轮都由文明行动和物理结算推进。'}</p></div><div className="hero-actions"><button className="button primary cta" onClick={toggleRun} disabled={isReplay || run?.status === 'completed' || isPausing || Boolean(humanMode && human?.waiting && !human?.submitted)}>{!run ? '开始推演' : isReplay ? '历史只读' : isPausing ? '正在暂停…' : humanMode && human?.waiting ? '等待你的行动' : run.status === 'running' || run.status === 'idle' ? '暂停推演' : run.status === 'paused' || run.status === 'error' ? '继续推演' : '推演完成'}</button>{humanMode && <button className="button" onClick={() => setHumanPerspective('observer')}>返回观察者全景</button>}<button className="button" onClick={() => void oneStep()} disabled={controlsDisabled || isPausing || run?.status === 'completed'}>单步 N</button><button className="button" onClick={reset}>重置 R</button></div></section>
      {!run || showSetup ? <SetupPanel form={form} setForm={setForm} config={config} verified={verified} estimate={estimate} requestLimit={configuredRequestLimit} onStart={() => void createRun()} onImport={() => fileRef.current?.click()} onRestore={() => void restoreLocal()} storageAvailable={storageAvailable} /> : <>
        <section className="run-strip panel"><div className="run-strip-main"><span className="live-kicker">{isReplay ? '历史回放' : run?.humanCivilizationId && human?.waiting ? '用户回合' : run.status === 'completed' ? '阶段完成' : humanMode ? '我方视角' : '正在观察'}</span><strong>第 {displayWorld?.tick ?? 0} 轮</strong><span className="muted">seed {run.config.seed}</span><span className="muted">本段至 T{run.segmentEnd}</span></div><div className="run-strip-metrics"><span className={run.config.mode === 'llm' ? 'source-llm' : 'source-rules'}>{modeLabel(run.config.mode)}</span><span>{formatNumber(usedRequests)} 次调用</span>{!humanMode && <span>{aliveCount} 个文明 · {displayWorld?.transits.length ?? 0} 条在途</span>}{run?.humanCivilizationId && human?.waiting && <span className="source-human">等待我的行动</span>}{degraded && !human?.waiting && <span className="degraded">{run.config.mode === 'mixed' ? '已明确回退' : '有请求需要处理'}</span>}<details className="run-details"><summary>观察记录</summary><div className="run-details-body"><span>阶段：{phase}</span><span>请求预算：{formatNumber(usedRequests)} / {formatNumber(requestLimit)}</span><span>来源：{run.llmParameters?.provider ?? config?.provider ?? '规则'} · {run.llmParameters?.model ?? config?.model ?? '离线'}</span>{run.humanCivilizationId && <span className="source-human">接管：用户指令</span>}{run.error && <span className="degraded">原因：{run.error}</span>}</div></details></div></section>
        {isReplay && <div className="replay-bar"><span>历史帧只读 · T{replayTick}</span><button className="button small" onClick={() => setReplayTick(null)}>返回实时</button></div>}
        <section className="metrics-row">{!humanMode && <><Metric label="观测轮次" value={`T${displayWorld?.tick ?? 0}`} /><Metric label="存活文明" value={`${aliveCount} / ${displayWorld?.civilizations.length ?? 0}`} tone={aliveCount === 0 ? 'danger' : ''} /><Metric label="在途信号" value={displayWorld?.transits.length ?? 0} /></>}<Metric label="请求进度" value={`${formatNumber(usedRequests)} / ${formatNumber(requestLimit)}`} /><Metric label="本段终点" value={`T${run.segmentEnd}`} /></section>
        {!humanMode && <section className="map-section panel"><div className="panel-heading"><div><p className="eyebrow">宇宙现场</p><h2>从这里观察文明</h2><p className="map-intro">拖动旋转，滚轮靠近；选择一个文明查看它能知道的世界。</p></div><div className="map-meta"><span>第 {displayWorld?.tick ?? 0} 轮</span><span>{events.length} 条已发生记录</span></div></div>{displaySceneWorld && <Universe3D world={displaySceneWorld} selectedId={selected?.id ?? null} onSelect={setSelection} running={run.status === 'running' && !isReplay} reducedMotion={reducedMotion} playbackRate={speed} inactiveLabel={isReplay ? '历史只读 · 轨迹冻结' : run?.status === 'completed' ? '观察阶段完成 · 轨迹冻结' : human?.waiting ? '等待你的行动 · 轨迹冻结' : '已暂停 · 轨迹冻结'} />}</section>}
        <section className={`below-map ${humanMode ? 'human-mode-shell' : ''}`}>{!humanMode && <div className="timeline-column panel"><div className="panel-heading"><div><p className="eyebrow">事件时间线</p><h2>发生了什么</h2></div><span className="muted">按轮次与文明归纳</span></div><Timeline run={{ ...run, world: { ...(displayWorld ?? run.world), events } }} selectedEventId={selectedEventId} onSelect={(id) => { setSelectedEventId(id); setActiveTab('references'); setDrawerOpen(true); }} showAll={showAllEvents} onToggleAll={() => setShowAllEvents((value) => !value)} /></div>}{humanMode && humanAlertEvent && <section className="human-alert-detail panel-inset" aria-label="我方收到的重大动态"><div className="eyebrow">我方已收到 · T{humanAlertEvent.observedTick}</div><h3>{humanAlertEvent.summary}</h3><p>事件发生于第 {humanAlertEvent.occurredTick} 轮，来源记录 {humanAlertEvent.sourceEventId}。</p><button className="text-button" onClick={() => { setHumanPerspective('observer'); setSelectedEventId(humanAlertEvent.sourceEventId); setDrawerOpen(true); setHumanAlertEvent(null); }}>切到观察者查看完整因果</button></section>}<aside className={`side-panel panel ${drawerOpen || humanMode ? 'open' : ''}`}><div className="side-panel-head"><div><p className="eyebrow">文明观察</p><h2>{selected ? civilizationIdentity(selected, displayWorld?.civilizations.findIndex((civ) => civ.id === selected.id) ?? 0).label : '选择一个文明'}</h2></div><button className="icon-button close-drawer" onClick={() => setDrawerOpen(false)} aria-label="关闭文明详情">×</button></div>{selected && <HumanControlPanel civ={selected} view={run.humanCivilizationId === selected.id ? (human?.civilizationId === selected.id ? human.view : null) : civView} human={run.humanCivilizationId === selected.id && human?.civilizationId === selected.id ? human : null} controlledCivId={run.humanCivilizationId} runStatus={run.status} isReplay={isReplay} perspective={humanPerspective} submitting={humanSubmitting} onTakeover={(id) => void takeOverCivilization(id)} onRelease={() => void releaseCivilization()} onSubmit={(decision) => void submitHumanDecision(decision)} onPerspectiveChange={setHumanPerspective} onClearError={() => setHuman((current) => current ? { ...current, guidance: current.guidance ? { ...current.guidance, disabledReason: undefined } : null } : current)} />}{run.humanCivilizationId && !isReplay && <div className="human-current-civ">当前接管：{run.world.civilizations.find((item) => item.id === run.humanCivilizationId)?.name ?? run.humanCivilizationId}</div>}{!humanMode && <><nav className="tabs" aria-label="观察面板标签">{([['summary', '摘要'], ['civilizations', '文明视图'], ['actions', '行动'], ['consequences', '后果'], ['references', '事件引用']] as [Tab, string][]).map(([id, label]) => <button key={id} className={activeTab === id ? 'active' : ''} onClick={() => setActiveTab(id)}>{label}</button>)}</nav><SideContent tab={activeTab} run={sideRun ?? run} civ={selected} liveCiv={selected} view={civView} event={selectedEvent} isReplay={isReplay} onEventSelect={(id) => { setSelectedEventId(id); setActiveTab('references'); }} /></>}</aside></section>
        {!humanMode && <section className="lower-grid"><NarrativeView narratives={run.narratives ?? []} civilizations={run.world.civilizations} narrativeError={run.narrativeError} onGenerate={(template) => void generateNarrative(template)} onEventClick={(eventId) => { setSelectedEventId(eventId); setActiveTab('references'); setDrawerOpen(true); window.requestAnimationFrame(() => document.getElementById(`event-detail-${eventId}`)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })); }} /><section className="history-card panel"><div className="panel-heading"><div><p className="eyebrow">回放</p><h2>回看每一次提交</h2></div><span className="muted">只读</span></div>{run.history.length === 0 ? <div className="empty-state">提交第一轮后，这里会出现可回放的历史帧。</div> : <div className="history-list">{run.history.slice().reverse().map((frame) => <button key={frame.tick} className={replayTick === frame.tick ? 'active' : ''} onClick={() => void openHistory(frame.tick)}><span>T{frame.tick}</span><span>{frame.decisions.length} 个决策</span><small>{replayTick === frame.tick ? '正在回放' : '查看此帧'}</small></button>)}</div>}</section></section>}
        <section className="footer-actions"><div className="shortcut-hint"><kbd>空格</kbd> 开始 / 暂停 <kbd>N</kbd> 单步 <kbd>← →</kbd> 选择文明 <kbd>Enter</kbd> 打开事件</div><div className="button-row"><label className="speed-control">速度 <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label><div className="extension-actions"><div className="extension-buttons"><button className="button" disabled={!canExtend} onClick={() => void extend(50)}>续看 50 轮</button><button className="button" disabled={!canExtend} onClick={() => void extend(100)}>续看 100 轮</button></div>{run && run.config.mode !== 'offline' && <small className={`extension-hint ${extensionRemaining < aliveCount * 50 + 1 ? 'budget-short' : ''}`}>{extensionBudgetHint(50)}</small>}</div><button className="button" disabled={controlsDisabled} onClick={() => void fallback(true)}>开启离线回退</button><button className="button" disabled={!run} onClick={() => void exportSnapshot()}>导出 JSON</button><button className="button" disabled={!run} onClick={() => void exportMarkdown()}>导出 Markdown</button><button className="button" onClick={() => fileRef.current?.click()}>导入快照</button></div></section>
      </>}
    </main>
    <input ref={fileRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
  </div>;
}

type CreateForm = Pick<RunConfig, 'seed' | 'civilizationCount' | 'segmentTicks' | 'mode' | 'failurePolicy'>;
function SetupPanel({ form, setForm, config, verified, estimate, requestLimit, onStart, onImport, onRestore, storageAvailable }: { form: CreateForm; setForm: React.Dispatch<React.SetStateAction<CreateForm>>; config: ExtendedConfig | null; verified: boolean; estimate: number; requestLimit: number; onStart: () => void; onImport: () => void; onRestore: () => void; storageAvailable: boolean }) {
  const limits = config ? { ...config.limits, minSegmentTicks: Math.max(1, config.limits.minSegmentTicks), maxSegmentTicks: Math.max(500, config.limits.maxSegmentTicks) } : { minCivilizations: 2, maxCivilizations: 50, minSegmentTicks: 1, maxSegmentTicks: 500 };
  const budgetShortfall = estimate > requestLimit;
  return <section className="setup-card panel"><div className="setup-intro"><p className="eyebrow">NEW SIMULATION / 新推演</p><h2>先定义一个可复盘的宇宙</h2><p>默认观察 100 轮，每段可设 1—500 轮并继续延长。每次提交只有一个 tick，暂停和恢复都会保留服务端原子状态。</p><div className="setup-status"><span className={`status-dot ${config?.configured ? 'on' : ''}`} /><span>{config ? `${config.provider} · ${config.model}` : 'LLM 配置读取中'}</span><span className={verified ? 'verified' : 'unverified'}>{verified ? '已验证' : 'LLM 未验证'}</span></div></div><div className="setup-form"><label>Seed<input value={form.seed} onChange={(event) => setForm((current) => ({ ...current, seed: event.target.value }))} placeholder="例如 orion-2" /></label><label>文明数量<span className="input-with-unit"><input type="number" min={limits.minCivilizations} max={limits.maxCivilizations} value={form.civilizationCount} onChange={(event) => setForm((current) => ({ ...current, civilizationCount: Number(event.target.value) }))} /><em>2—50</em></span></label><label>首段观察轮数<span className="input-with-unit"><input type="number" min={limits.minSegmentTicks} max={limits.maxSegmentTicks} value={form.segmentTicks} onChange={(event) => setForm((current) => ({ ...current, segmentTicks: Number(event.target.value) }))} /><em>1—500</em></span></label><label>执行来源<select value={form.mode} onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value as RunConfig['mode'] }))}><option value="llm">真实 LLM</option><option value="offline">离线规则</option></select></label><label className="check-label"><input type="checkbox" checked={form.failurePolicy === 'auto-fallback'} onChange={(event) => setForm((current) => ({ ...current, failurePolicy: event.target.checked ? 'auto-fallback' : 'pause' }))} /><span>LLM 失败时自动回退到离线规则</span></label><div className={`estimate ${budgetShortfall ? 'estimate-warning' : ''}`}><span><strong>{formatNumber(estimate)}</strong> 次基础请求估计</span><span>人格 {form.civilizationCount} + 决策 {form.civilizationCount}×{form.segmentTicks} + 结局 1</span><small>{budgetShortfall ? `当前预算 ${formatNumber(requestLimit)} 不足以覆盖估计值，运行会在预算不足时明确暂停；可选择离线或启用自动回退。` : `当前预算上限 ${formatNumber(requestLimit)}，真实请求失败会暂停并保留已完成部分。`}</small></div><div className="setup-actions"><button className="button primary cta" onClick={onStart}>开始推演</button><button className="button" onClick={onImport}>导入 JSON 快照</button>{storageAvailable && <button className="text-button" onClick={onRestore}>恢复本机快照</button>}</div></div></section>;
}

function SideContent({ tab, run, civ, liveCiv, view, event, isReplay, onEventSelect }: { tab: Tab; run: ExtendedRun; civ?: Civilization; liveCiv?: Civilization; view: VisibleView | null; event?: WorldEvent; isReplay: boolean; onEventSelect: (id: string) => void }) {
  if (!civ) return <div className="empty-state">从星图或文明视图选择一个文明。</div>;
  const identity = civilizationIdentity(civ, run.world.civilizations.findIndex((item) => item.id === civ.id));
  const recent = recentCivilizationObservations(run.world, run.history, civ.id);
  const latestCommittedDecision = run.history.filter((frame) => frame.tick <= run.world.tick).flatMap((frame) => frame.decisions).filter((record) => record.civilizationId === civ.id).at(-1);
  if (tab === 'summary') return <div className="side-content"><div className="civ-identity"><span className="civ-swatch" style={{ background: civ.color }} aria-hidden="true">{identity.marker}</span><div><strong>{identity.label}</strong><span>{identity.secondaryName} · {civ.id}</span></div><span className={`badge ${civ.alive ? 'badge-live' : 'badge-dead'}`}>{civ.alive ? '存活' : '已毁灭'}</span></div><div className="side-metrics"><Metric label="健康" value={formatNumber(civ.health)} /><Metric label="储备" value={formatNumber(civ.resources)} /><Metric label="研究" value={formatNumber(civ.technology)} /><Metric label="防护" value={formatNumber(civ.defense)} /></div><p className="side-note">观众真值摘要包含整个宇宙的状态；文明视图会切换到它在 T{view?.tick ?? run.world.tick} 能知道的局部信息。</p><div className="observer-pulse"><h3>近期在做什么</h3>{recent.length ? recent.map((item) => { const primaryRefs = item.eventIds.slice(0, 2); const extraRefs = item.eventIds.slice(2); return <div className="observer-pulse-row" key={item.id}><span className="timeline-tick">T{item.tick}</span><div><strong>{item.text}</strong>{item.eventIds.length ? <div className="observer-pulse-refs">{primaryRefs.map((eventId) => <button key={eventId} onClick={() => onEventSelect(eventId)}>证据 {eventId}</button>)}{extraRefs.length ? <details><summary>其余 {extraRefs.length} 条依据</summary><div>{extraRefs.map((eventId) => <button key={eventId} onClick={() => onEventSelect(eventId)}>证据 {eventId}</button>)}</div></details> : null}</div> : <small>由该时点状态计算</small>}</div></div>; }) : <p className="muted">当前时点还没有可归纳的行动。</p>}</div><SourceLine label="人格" source={civ.personality?.source} /><SourceLine label="最新决策" source={latestCommittedDecision?.source} /></div>;
  if (tab === 'civilizations') return <div className="side-content"><div className="view-stamp">{isReplay ? '历史帧中的文明记忆' : '白名单文明可见视图'} · T{view?.tick ?? run.world.tick}</div>{view ? <><div className="side-metrics"><Metric label="健康" value={formatNumber(view.self.health)} /><Metric label="储备" value={formatNumber(view.self.resources)} /><Metric label="研究" value={formatNumber(view.self.technology)} /><Metric label="防护" value={formatNumber(view.self.defense)} /></div><SourceLine label="人格来源" source={view.self.personality.source} /><div className="view-group"><h3>已知接触 · {view.contacts.length}</h3>{view.contacts.length ? view.contacts.map((contact) => <div className="compact-row" key={contact.contactId}><span>{contact.label}</span><small>{contact.contactId} · {contact.status} · 观察 T{contact.observedAt}</small></div>) : <p className="muted">还没有可见接触。</p>}</div><div className="view-group"><h3>文明能观察到的事件 · {view.observations.length}</h3>{view.observations.slice(-5).map((observation) => <div className="compact-row" key={`${observation.sourceEventId}-${observation.observedTick}`}><span>{observation.summary}</span><small>{observation.sourceEventId} · 观察 T{observation.observedTick}</small></div>)}</div></> : <p className="muted">正在读取白名单视图，或该历史帧没有单独的观测快照。</p>}</div>;
  if (tab === 'actions') {
    const civRequests = run.requestLog.filter((record) => record.civilizationId === civ.id).slice().reverse();
    const issueRequests = civRequests.filter((record) => record.status === 'failed' || record.status === 'fallback');
    return <div className="side-content"><div className="view-stamp">每个决策来自单次冻结视图</div>{liveCiv?.lastDecision ? <><div className="action-card"><span className="action-name">{actionLabels[liveCiv.lastDecision.action] ?? liveCiv.lastDecision.action}</span><span className="badge">{liveCiv.lastDecision.target ?? '无目标'}</span><p><strong className="reason-label">它的判断：</strong>{liveCiv.lastDecision.reason}</p><small>强度 {liveCiv.lastDecision.intensity} · 预算 {liveCiv.lastDecision.budget}</small></div><SourceLine label="决策来源" source={latestCommittedDecision?.source} /></> : null}{issueRequests.length ? <div className="view-group request-issues"><h3>失败与回退 · {issueRequests.length}</h3>{issueRequests.map((record) => <div className="compact-row" key={record.id}><span><strong>{requestKindLabels[record.kind]}</strong> · T{record.tick} · <b className={record.status === 'failed' ? 'request-failed' : 'request-fallback'}>{requestStatusLabels[record.status]}</b></span><small>{record.error || (record.status === 'fallback' ? '已按策略切换到离线规则。' : '请求未完成。')} · 尝试 {record.attempts} 次 · {sourceLabel(record.source)}</small></div>)}</div> : null}{!liveCiv?.lastDecision && !issueRequests.length ? <div className="empty-state">该文明还没有已提交的决策或失败请求记录。</div> : null}</div>;
  }
  if (tab === 'consequences') { const consequences = (run.world.events ?? []).filter((item) => item.participants.includes(civ.id)).slice().reverse(); return <div className="side-content"><div className="view-stamp">参与文明 · {identity.label} · {identity.secondaryName}</div>{consequences.length ? consequences.map((item) => <div className="compact-row" key={item.eventId}><span>T{item.occurredTick} · {observedEventText(item, run.world)}</span><small>{item.eventId} · {item.source === 'engine' ? '引擎事实' : sourceLabel(item.source)}</small></div>) : <div className="empty-state">还没有与此文明相关的后果。</div>}</div>; }
  return <div className="side-content">{event ? <><div className="event-detail" id={`event-detail-${event.eventId}`}><div><span className="badge">T{event.occurredTick}</span><span className="badge">{event.eventId}</span></div><h3>{eventKindLabels[event.kind] ?? event.kind}</h3><p>{observedEventText(event, run.world)}</p><dl>{Object.entries(event.facts ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div><div className="view-group"><h3>观察记录</h3>{event.observations?.length ? event.observations.map((observation) => <div className="compact-row" key={`${observation.observerId}-${observation.observedTick}`}><span>{observation.summary}</span><small>{observation.observerId} · 观察 T{observation.observedTick}</small></div>) : <p className="muted">没有文明在事件发生时观察到它。</p>}</div><div className="view-group"><h3>因果引用</h3><p className="reference-line">{event.causalEventIds?.length ? event.causalEventIds.join('、') : '这是独立事件。'}</p></div></> : <div className="empty-state">点击时间线中的事件查看事实、观察轮次和因果引用。</div>}</div>;
}

function SourceLine({ label, source }: { label: string; source?: string }) { return <div className="source-line"><span>{label}</span><strong>{sourceLabel(source)}</strong></div>; }

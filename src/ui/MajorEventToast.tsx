import type { MajorAlert } from './importantEvents';

export function MajorEventToast({ alert, onLocate, onPause, onDismiss }: { alert: MajorAlert; onLocate: () => void; onPause: () => void; onDismiss: () => void }) {
  return <section className="major-toast" role="region" aria-label="重大动态" data-event-id={alert.eventId}>
    <div className="major-toast-copy"><span className="eyebrow">重大动态 · T{alert.observedTick ?? alert.occurredTick}</span><p>{alert.text}</p>{alert.observedTick !== undefined && alert.observedTick !== alert.occurredTick && <small>你在第 {alert.observedTick} 轮观测到，事件发生于第 {alert.occurredTick} 轮。</small>}</div>
    <div className="major-toast-actions"><button className="text-button" onClick={onLocate}>查看事件</button><button className="text-button" onClick={onPause}>暂停查看</button><button className="icon-button" onClick={onDismiss} aria-label="关闭重大动态">×</button></div>
  </section>;
}

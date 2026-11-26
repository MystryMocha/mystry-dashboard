import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { DashboardMetrics, InstanceInfo, StatsDiskBreakdown } from '@mystry/shared';
import { CoreIcon } from '../CoreIcon';
import { hasWarning } from '../DashboardMetrics';
import { InstanceStatusPill } from '../StatusPill';
import { useI18n } from '../../i18n';
import { isProcessAlive } from '../../instance-status';
import { formatCapacity, formatCapacityPair } from './format';

type StatKey = 'running' | 'cpu' | 'memory' | 'disk';
type LoadState = 'loading' | 'loaded' | 'error';

const PANEL_GAP = 6;
const VIEWPORT_MARGIN = 8;
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function StatRing({ ratio, warning }: { ratio: number | null; warning: boolean }) {
  const clamped = ratio != null && Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return (
    <svg className={`home-ring${warning ? ' is-warning' : ''}`} width="40" height="40" viewBox="0 0 44 44" aria-hidden="true">
      <circle className="home-ring-track" cx="22" cy="22" r={RING_RADIUS} />
      {clamped > 0 && (
        <circle
          className="home-ring-fill"
          cx="22"
          cy="22"
          r={RING_RADIUS}
          strokeDasharray={`${(clamped * RING_CIRCUMFERENCE).toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`}
          transform="rotate(-90 22 22)"
        />
      )}
    </svg>
  );
}

interface StatusBlocksProps {
  instances: InstanceInfo[];
  instancesLoadState: LoadState;
  metrics: DashboardMetrics | null;
  metricsError: string;
  processMetricsSupported: boolean;
  diskBreakdown: StatsDiskBreakdown | null;
}

/**
 * Row 1 of the home dashboard: four status cells in one inset solid panel separated by 1px dividers.
 * Each cell opens a viewport-clamped portal popover with its breakdown on click or keyboard activation.
 */
export function StatusBlocks({
  instances,
  instancesLoadState,
  metrics,
  metricsError,
  processMetricsSupported,
  diskBreakdown,
}: StatusBlocksProps) {
  const { t, fmt } = useI18n();
  const [openKey, setOpenKey] = useState<StatKey | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);
  const triggerRefs = useRef<Record<StatKey, HTMLButtonElement | null>>({
    running: null,
    cpu: null,
    memory: null,
    disk: null,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const popoverId = (key: StatKey) => `${baseId}-${key}`;

  const close = useCallback((returnFocus: boolean) => {
    setOpenKey((current) => {
      if (returnFocus && current) triggerRefs.current[current]?.focus();
      return null;
    });
    setPanelStyle(null);
  }, []);

  const updatePosition = useCallback(() => {
    if (!openKey) return;
    const trigger = triggerRefs.current[openKey];
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const panelWidth = Math.min(Math.max(panel.offsetWidth, 248), viewportWidth - VIEWPORT_MARGIN * 2);
    const panelHeight = panel.scrollHeight;

    const availableBelow = Math.max(0, viewportHeight - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN);
    const availableAbove = Math.max(0, rect.top - PANEL_GAP - VIEWPORT_MARGIN);
    const placeAbove = availableBelow < panelHeight && availableAbove > availableBelow;
    const maxHeight = Math.max(120, placeAbove ? availableAbove : availableBelow);
    const height = Math.min(panelHeight, maxHeight);

    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, viewportWidth - panelWidth - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      placeAbove ? rect.top - PANEL_GAP - height : rect.bottom + PANEL_GAP,
    );

    setPanelStyle({ top, left, maxHeight });
  }, [openKey]);

  useLayoutEffect(() => {
    if (!openKey) return;
    updatePosition();
  }, [openKey, updatePosition, instances, metrics, diskBreakdown]);

  useEffect(() => {
    if (!openKey) return;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [openKey, updatePosition]);

  useEffect(() => {
    if (!openKey) return;
    const panel = panelRef.current;
    // Focus the first interactive element inside the portal popover (such as an instance link), or the dialog itself for read-only breakdowns, so keyboard Tab and Escape stay predictable.
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? panel)?.focus({ preventScroll: true });

    const isInside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      const trigger = triggerRefs.current[openKey];
      return Boolean(trigger?.contains(target) || panelRef.current?.contains(target));
    };

    function onMouseDown(event: MouseEvent) {
      if (!isInside(event.target)) close(false);
    }
    function onFocusIn(event: FocusEvent) {
      if (!isInside(event.target)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    }

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openKey, close]);

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusables = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const leavingBackward = event.shiftKey && (focusables.length === 0 || document.activeElement === focusables[0] || document.activeElement === panelRef.current);
    const leavingForward = !event.shiftKey && (focusables.length === 0 || document.activeElement === focusables[focusables.length - 1]);
    if (leavingBackward || leavingForward) {
      // Return focus to the trigger synchronously without preventing default so the browser advances naturally to the sibling before or after the trigger.
      close(true);
    }
  }

  const stale = Boolean(metricsError && metrics);
  const runningInstances = instances.filter((inst) => inst.status === 'running');
  const aliveInstances = instances.filter((inst) => isProcessAlive(inst.status));

  const runningValue = instancesLoadState === 'loaded'
    ? `${fmt.number(runningInstances.length)} / ${fmt.number(instances.length)}`
    : '—';
  const runningRatio = instancesLoadState === 'loaded' && instances.length > 0
    ? runningInstances.length / instances.length
    : null;

  const cpuPercent = metrics?.cpuPercent ?? null;
  const cpuWarn = hasWarning(metrics, 'server.system.metricsCpuHigh');
  const cpuValue = cpuPercent != null
    ? fmt.percent(cpuPercent, 0)
    : metrics && !metricsError
      ? t('dashboard.metrics.collecting')
      : '—';
  const cpuRatio = cpuPercent != null ? cpuPercent / 100 : null;

  const memory = metrics?.memory ?? null;
  const memWarn = hasWarning(metrics, 'server.system.metricsMemoryHigh');
  const memValue = memory ? formatCapacityPair(memory.usedBytes, memory.totalBytes, fmt) : '—';
  const memRatio = memory && memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : null;

  const disk = metrics?.disk ?? null;
  const diskUsedBytes = disk ? Math.max(0, disk.totalBytes - disk.availableBytes) : null;
  const diskWarn = hasWarning(metrics, 'server.system.metricsDiskLow');
  const diskValue = disk && diskUsedBytes != null
    ? formatCapacityPair(diskUsedBytes, disk.totalBytes, fmt)
    : '—';
  const diskRatio = disk && diskUsedBytes != null && disk.totalBytes > 0
    ? diskUsedBytes / disk.totalBytes
    : null;

  const cells: Array<{
    key: StatKey;
    label: string;
    popoverLabel: string;
    value: string;
    ratio: number | null;
    warning: boolean;
    warnLabel?: string;
    isStale?: boolean;
  }> = [
    {
      key: 'running',
      label: t('home.stat.running'),
      popoverLabel: t('home.stat.popover.running'),
      value: runningValue,
      ratio: runningRatio,
      warning: false,
    },
    {
      key: 'cpu',
      label: t('home.stat.cpu'),
      popoverLabel: t('home.stat.popover.cpu'),
      value: cpuValue,
      ratio: cpuRatio,
      warning: cpuWarn,
      warnLabel: cpuWarn ? t('home.stat.warnHigh') : undefined,
      isStale: stale,
    },
    {
      key: 'memory',
      label: t('home.stat.memory'),
      popoverLabel: t('home.stat.popover.memory'),
      value: memValue,
      ratio: memRatio,
      warning: memWarn,
      warnLabel: memWarn ? t('home.stat.warnHigh') : undefined,
      isStale: stale,
    },
    {
      key: 'disk',
      label: t('home.stat.disk'),
      popoverLabel: t('home.stat.popover.disk'),
      value: diskValue,
      ratio: diskRatio,
      warning: diskWarn,
      warnLabel: diskWarn ? t('home.stat.warnDiskLow') : undefined,
      isStale: stale,
    },
  ];

  function renderPopoverContent(key: StatKey) {
    if (key === 'running') {
      if (instancesLoadState === 'error') {
        return <p className="home-pop-empty">{t('error.instances.load')}</p>;
      }
      if (instancesLoadState === 'loading') {
        return <p className="home-pop-empty">{t('common.loading')}</p>;
      }
      if (aliveInstances.length === 0) {
        return (
          <div className="home-pop-empty-box">
            <p className="home-pop-empty">{t('dashboard.list.noRunning')}</p>
            <Link to="/instances" className="link home-pop-link" onClick={() => close(false)}>
              {t('home.instances.all')}
            </Link>
          </div>
        );
      }
      return (
        <ul className="home-pop-list">
          {aliveInstances.map((inst) => {
            const sample = metrics?.instances[inst.id];
            const memBytes = processMetricsSupported ? sample?.memoryBytes ?? null : null;
            return (
              <li key={inst.id}>
                <Link to={`/instances/${inst.id}`} className="home-pop-row" onClick={() => close(false)}>
                  <CoreIcon coreType={inst.coreType} />
                  <span className="home-pop-name" title={inst.name}>{inst.name}</span>
                  {inst.status === 'starting' || inst.status === 'stopping' ? (
                    <InstanceStatusPill instance={inst} />
                  ) : (
                    <span className="home-pop-figure">
                      {memBytes != null ? formatCapacity(memBytes, fmt) : '—'}
                    </span>
                  )}
                  <ChevronRight size={16} aria-hidden="true" className="home-chevron" />
                </Link>
              </li>
            );
          })}
        </ul>
      );
    }

    if (key === 'cpu') {
      if (cpuPercent == null) {
        return (
          <p className="home-pop-empty">
            {metricsError ? t('dashboard.metrics.unavailable') : t('dashboard.metrics.collecting')}
          </p>
        );
      }
      if (!processMetricsSupported) {
        return (
          <dl className="home-pop-dl">
            <div>
              <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.all')}</dt>
              <dd>{fmt.percent(cpuPercent, 1)}</dd>
            </div>
          </dl>
        );
      }
      const samples = Object.values(metrics?.instances ?? {})
        .map((sample) => sample.cpuPercent)
        .filter((value): value is number => value != null);
      const hasSamples = aliveInstances.length === 0 || samples.length > 0;
      const instancesCpu = hasSamples ? Math.min(100, samples.reduce((sum, value) => sum + value, 0)) : null;
      const otherCpu = instancesCpu != null ? Math.max(0, cpuPercent - instancesCpu) : null;
      return (
        <dl className="home-pop-dl">
          <div>
            <dt><span className="home-swatch is-s1" aria-hidden="true" />{t('home.breakdown.instances')}</dt>
            <dd>{instancesCpu != null ? fmt.percent(instancesCpu, 1) : '—'}</dd>
          </div>
          <div>
            <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.otherApps')}</dt>
            <dd>{otherCpu != null ? fmt.percent(otherCpu, 1) : '—'}</dd>
          </div>
        </dl>
      );
    }

    if (key === 'memory') {
      if (!memory) {
        return (
          <p className="home-pop-empty">
            {metricsError ? t('dashboard.metrics.unavailable') : t('dashboard.metrics.collecting')}
          </p>
        );
      }
      const availableBytes = Math.max(0, memory.totalBytes - memory.usedBytes);
      if (!processMetricsSupported) {
        return (
          <dl className="home-pop-dl">
            <div>
              <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.used')}</dt>
              <dd>{formatCapacity(memory.usedBytes, fmt)}</dd>
            </div>
            <div>
              <dt><span className="home-swatch is-free" aria-hidden="true" />{t('home.breakdown.available')}</dt>
              <dd>{formatCapacity(availableBytes, fmt)}</dd>
            </div>
          </dl>
        );
      }
      const samples = Object.values(metrics?.instances ?? {})
        .map((sample) => sample.memoryBytes)
        .filter((value): value is number => value != null);
      const hasSamples = aliveInstances.length === 0 || samples.length > 0;
      const instancesBytes = hasSamples ? samples.reduce((sum, value) => sum + value, 0) : null;
      const otherBytes = instancesBytes != null ? Math.max(0, memory.usedBytes - instancesBytes) : null;
      return (
        <dl className="home-pop-dl">
          <div>
            <dt><span className="home-swatch is-s1" aria-hidden="true" />{t('home.breakdown.instances')}</dt>
            <dd>{instancesBytes != null ? formatCapacity(instancesBytes, fmt) : '—'}</dd>
          </div>
          <div>
            <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.otherApps')}</dt>
            <dd>{otherBytes != null ? formatCapacity(otherBytes, fmt) : '—'}</dd>
          </div>
          <div>
            <dt><span className="home-swatch is-free" aria-hidden="true" />{t('home.breakdown.available')}</dt>
            <dd>{formatCapacity(availableBytes, fmt)}</dd>
          </div>
        </dl>
      );
    }

    if (!disk || diskUsedBytes == null) {
      return (
        <p className="home-pop-empty">
          {metricsError || metrics ? t('dashboard.metrics.unavailable') : t('dashboard.metrics.collecting')}
        </p>
      );
    }
    const availableBytes = Math.max(0, disk.availableBytes);
    if (!diskBreakdown || diskBreakdown.instancesBytes == null) {
      return (
        <dl className="home-pop-dl">
          <div>
            <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.used')}</dt>
            <dd>{formatCapacity(diskUsedBytes, fmt)}</dd>
          </div>
          <div>
            <dt><span className="home-swatch is-free" aria-hidden="true" />{t('home.breakdown.available')}</dt>
            <dd>{formatCapacity(availableBytes, fmt)}</dd>
          </div>
        </dl>
      );
    }
    const instancesBytes = Math.max(0, diskBreakdown.instancesBytes);
    const showBackups = diskBreakdown.backupsOnSameVolume && diskBreakdown.backupsBytes != null;
    const backupsBytes = showBackups ? Math.max(0, diskBreakdown.backupsBytes!) : 0;
    const otherFilesBytes = Math.max(0, diskUsedBytes - instancesBytes - backupsBytes);
    return (
      <dl className="home-pop-dl">
        <div>
          <dt><span className="home-swatch is-s1" aria-hidden="true" />{t('home.breakdown.instances')}</dt>
          <dd>{formatCapacity(instancesBytes, fmt)}</dd>
        </div>
        {showBackups && (
          <div>
            <dt><span className="home-swatch is-s1-soft" aria-hidden="true" />{t('home.breakdown.backups')}</dt>
            <dd>{formatCapacity(backupsBytes, fmt)}</dd>
          </div>
        )}
        <div>
          <dt><span className="home-swatch is-context" aria-hidden="true" />{t('home.breakdown.otherFiles')}</dt>
          <dd>{formatCapacity(otherFilesBytes, fmt)}</dd>
        </div>
        <div>
          <dt><span className="home-swatch is-free" aria-hidden="true" />{t('home.breakdown.available')}</dt>
          <dd>{formatCapacity(availableBytes, fmt)}</dd>
        </div>
      </dl>
    );
  }

  const activeCell = openKey ? cells.find((cell) => cell.key === openKey) : null;

  return (
    <div className="home-stats">
      {cells.map((cell) => {
        const isOpen = openKey === cell.key;
        return (
          <div key={cell.key} className="home-stat-cell">
            <button
              ref={(node) => { triggerRefs.current[cell.key] = node; }}
              type="button"
              className={`home-stat${isOpen ? ' is-open' : ''}${cell.warning ? ' is-warning' : ''}${cell.isStale ? ' is-stale' : ''}`}
              aria-expanded={isOpen}
              aria-haspopup="dialog"
              aria-controls={isOpen ? popoverId(cell.key) : undefined}
              onClick={() => {
                if (isOpen) close(false);
                else setOpenKey(cell.key);
              }}
            >
              <StatRing ratio={cell.ratio} warning={cell.warning} />
              <span className="home-stat-text">
                <span className="home-stat-head">
                  <span className="home-stat-name">{cell.label}</span>
                  {cell.warnLabel && <span className="home-stat-warn">{cell.warnLabel}</span>}
                </span>
                <span className="home-stat-value">{cell.value}</span>
              </span>
            </button>
          </div>
        );
      })}

      {openKey && activeCell &&
        createPortal(
          <div
            id={popoverId(openKey)}
            ref={panelRef}
            className="home-stat-popover"
            role="dialog"
            aria-label={activeCell.popoverLabel}
            tabIndex={-1}
            style={panelStyle ?? { opacity: 0, top: 0, left: 0 }}
            onKeyDown={onPanelKeyDown}
          >
            {renderPopoverContent(openKey)}
          </div>,
          document.body,
        )}
    </div>
  );
}

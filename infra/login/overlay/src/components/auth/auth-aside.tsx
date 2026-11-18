import {
  AttendanceTrendCard,
  LeaveTrackerCard,
  NewHirePipelineCard,
  PillIndicator,
} from './auth-aside-cards';
import { StarMark } from './auth-brand';
import gridImage from './aside-grid.webp';

/**
 * Right-hand "workspace overview" panel. Purely illustrative marketing UI, so it is hidden from assistive
 * technology and contains nothing focusable. The grid image is a static import so Next serves it from /_next/static with the basePath applied.
 */
export function AuthAside() {
  return (
    <aside className="bos-aside" aria-hidden="true">
      {/* Decorative background; next/image would add a resize hop for a 25 KB static file. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="bos-aside-grid"
        src={gridImage.src}
        alt=""
        width={2880}
        height={2048}
        decoding="async"
        draggable={false}
      />
      <div className="bos-aside-inner">
        <div className="bos-aside-stage">
          <AttendanceTrendCard />
          <LeaveTrackerCard />
          <NewHirePipelineCard />
        </div>

        <div className="bos-aside-copy">
          <div className="bos-aside-monogram">
            <StarMark size={20} />
          </div>
          <div className="bos-aside-title">
            <span>A Unified Hub for Smarter</span> <span>Workplace operations</span>
          </div>
          <p className="bos-aside-body">
            Business-os empowers you with a unified financial command center—delivering deep
            insights and a 360° view of your entire economic world.
          </p>
        </div>

        <PillIndicator count={4} active={0} />
      </div>
    </aside>
  );
}

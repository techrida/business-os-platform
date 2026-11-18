/*
 * Static, decorative "workspace overview" cards for the login aside (Figma: Aside - Northstar workspace
 * overview). They illustrate the product and carry no live data. The parent aside is aria-hidden, nothing here
 * is focusable, and the "buttons" are plain spans.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ArrowUp() {
  return (
    <svg width="6" height="6" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M5 9V1.6M2 4.4 5 1.4l3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M1 5h7.4M5.6 2l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="6" height="6" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2 3.5 5 6.5l3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AttendanceTrendCard() {
  return (
    <div className="bos-acard bos-acard-attendance">
      <div className="bos-acard-head">
        <div>
          <div className="bos-acard-title bos-acard-title-lg">Attendance trend</div>
          <div className="bos-acard-sub bos-acard-sub-sm">
            Average attendance over the last 10 weeks
          </div>
        </div>
        <span className="bos-acard-select">
          This year
          <ChevronDown />
        </span>
      </div>

      <div className="bos-chart">
        {/* Dashed guide lines */}
        <svg
          className="bos-chart-layer bos-chart-grid"
          viewBox="0 0 187.318 67.4725"
          preserveAspectRatio="none"
          fill="none"
        >
          {[0.293359, 22.5886, 44.8839, 67.1792].map((y) => (
            <line
              key={y}
              x1="0"
              x2="187.318"
              y1={y}
              y2={y}
              strokeWidth="0.586718"
              strokeDasharray="1.351 2.251"
            />
          ))}
        </svg>
        {/* Area under the line */}
        <svg
          className="bos-chart-layer bos-chart-area"
          viewBox="0 0 187.318 60.4319"
          preserveAspectRatio="none"
        >
          <path d="M0 36.7068C12.4879 31.3351 17.1708 40.288 26.8489 28.2016C36.527 16.1152 40.5856 13.4293 49.9515 25.5157C59.3174 37.6021 65.5613 35.8115 74.9272 16.5628C84.2931 -2.68586 89.2882 22.3822 99.9029 11.1911C110.518 0 112.391 32.678 123.63 19.2487C134.869 5.81937 137.367 6.71466 146.108 17.9058C154.85 29.0969 162.342 7.60995 171.708 4.47644C181.074 1.34293 181.074 11.1911 187.318 0V60.4319H0V36.7068Z" />
        </svg>
        {/* The line */}
        <svg
          className="bos-chart-layer bos-chart-line"
          viewBox="0 0 188.662 38.3068"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0.671807 37.635C13.1597 32.2257 17.8426 41.2411 27.5207 29.0703C37.1988 16.8995 41.2574 14.1949 50.6233 26.3657C59.9892 38.5365 66.2331 36.7334 75.599 17.3503C84.9649 -2.03287 89.9601 23.2103 100.575 11.941C111.189 0.671759 113.063 33.578 124.302 20.0549C135.541 6.53178 138.038 7.43332 146.78 18.7026C155.521 29.9719 163.014 8.33487 172.38 5.17947C181.746 2.02407 181.746 11.941 187.99 0.671759"
            strokeWidth="1.34327"
            strokeLinecap="round"
          />
        </svg>
        {/* End dot */}
        <svg
          className="bos-chart-layer bos-chart-dot"
          viewBox="0 0 4.36453 5.4503"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M2.18227 4.77866C3.01656 4.77866 3.69289 3.85927 3.69289 2.72515C3.69289 1.59102 3.01656 0.671636 2.18227 0.671636C1.34797 0.671636 0.671636 1.59102 0.671636 2.72515C0.671636 3.85927 1.34797 4.77866 2.18227 4.77866Z"
            strokeWidth="1.34327"
          />
        </svg>
      </div>

      <div className="bos-chart-axis">
        {MONTHS.map((month) => (
          <span key={month}>{month}</span>
        ))}
      </div>

      <div className="bos-acard-stat">
        <span className="bos-acard-stat-value">94.8%</span>
        <span className="bos-acard-stat-delta">
          <ArrowUp />
          2.4% better than last month
        </span>
      </div>
    </div>
  );
}

export function LeaveTrackerCard() {
  return (
    <div className="bos-acard bos-acard-leave">
      <div className="bos-acard-head">
        <div className="bos-acard-title bos-acard-title-xl">Leave tracker</div>
        <span className="bos-acard-link">
          Manage Leave
          <ArrowRight />
        </span>
      </div>
      <div className="bos-acard-sub bos-acard-sub-md">Used days this year</div>

      <div className="bos-donut">
        <div className="bos-donut-hole">
          <span className="bos-donut-value">11</span>
          <span className="bos-donut-unit">of 20 days</span>
        </div>
      </div>

      <div className="bos-legend">
        <span className="bos-legend-item" data-kind="used">
          Used
        </span>
        <span className="bos-legend-item" data-kind="remaining">
          Remaining
        </span>
      </div>
    </div>
  );
}

const PIPELINE: {
  label: string;
  count: number;
  percent: number;
  tone: 'accent' | 'caution' | 'positive';
}[] = [
  { label: 'Offer accepted', count: 3, percent: 25, tone: 'accent' },
  { label: 'Documents pending', count: 4, percent: 34, tone: 'caution' },
  { label: 'Background check', count: 2, percent: 17, tone: 'accent' },
  { label: 'Ready for day one', count: 3, percent: 25, tone: 'positive' },
];

export function NewHirePipelineCard() {
  return (
    <div className="bos-acard bos-acard-pipeline">
      <div className="bos-acard-head">
        <div>
          <div className="bos-acard-title bos-acard-title-md">New hire pipeline</div>
          <div className="bos-acard-sub bos-acard-sub-xs">
            12 people across four onboarding stages
          </div>
        </div>
        <span className="bos-acard-mini-button">View all</span>
      </div>

      <div className="bos-pipeline">
        {PIPELINE.map((row) => (
          <div className="bos-pipeline-row" key={row.label}>
            <div className="bos-pipeline-text">
              <span>{row.label}</span>
              <span>{row.count}</span>
            </div>
            <div className="bos-pipeline-track">
              <div
                className="bos-pipeline-fill"
                data-tone={row.tone}
                style={{ width: `${row.percent}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Slide indicator: `count` pills, the one at `active` highlighted. Static. */
export function PillIndicator({ count = 4, active = 0 }: { count?: number; active?: number }) {
  return (
    <div className="bos-aside-pills">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="bos-aside-pill"
          data-active={index === active ? 'true' : undefined}
        />
      ))}
    </div>
  );
}

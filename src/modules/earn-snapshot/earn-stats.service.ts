import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EarnSnapshot } from '../../entities/earn-snapshot.entity.js';
import { NAV_SCALE, RATE_SCALE } from './earn-onchain.js';
import { EarnApyDto, EarnHistoryPointDto, EarnStatsResponseDto } from './dto/earn-stats.dto.js';

/** Seconds in a 365-day year — the annualisation base. */
const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Window definitions (seconds) for the three APY horizons. */
const WINDOWS = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
} as const;

/** Target number of points in the sparkline (downsample to this many). */
const MAX_HISTORY_POINTS = 60;

/**
 * Read-side of the earn snapshots: assembles `GET /earn/stats`.
 *
 * APY honesty rule (load-bearing): for each window we find the OLDEST snapshot
 * whose `ts` falls inside the window, then annualise the stRWT-rate growth over
 * the ACTUAL elapsed span between that snapshot and the latest one:
 *
 *     apy = (rate_now / rate_start) ^ (YEAR_SECONDS / elapsedSeconds) − 1
 *
 * Two guards keep the number honest:
 *   1. If NO snapshot is older than (now − window) — i.e. the available history
 *      is shorter than the requested window — we return `null`, never
 *      extrapolating a tiny span into a full-window claim. The frontend shows
 *      "accumulating data…".
 *   2. If the rate hasn't moved (no rewards deposited), the ratio is 1 and APY
 *      is genuinely 0 — we return 0, which is correct.
 */
@Injectable()
export class EarnStatsService {
  private readonly logger = new Logger(EarnStatsService.name);

  constructor(
    @InjectRepository(EarnSnapshot)
    private readonly snapshots: Repository<EarnSnapshot>,
  ) {}

  async getStats(): Promise<EarnStatsResponseDto> {
    // Pull the longest window (month) once, ascending by ts. One query feeds
    // both the APY computation (needs the oldest-in-window per horizon) and the
    // sparkline (downsampled). For a 5-min cadence, 30 days ≈ 8640 rows — small
    // enough to load and process in-memory without pagination.
    const since = new Date(Date.now() - WINDOWS.month * 1000);
    const rows = await this.snapshots
      .createQueryBuilder('s')
      .where('s.ts >= :since', { since })
      .orderBy('s.ts', 'ASC')
      .getMany();

    if (rows.length === 0) {
      // No data yet — the snapshot cron hasn't produced a row. 404 so the
      // frontend can distinguish "endpoint up but no data" from a transport
      // error, and show its own "accumulating data…" state.
      throw new NotFoundException('No earn snapshots yet');
    }

    const latest = rows[rows.length - 1];
    const nowMs = Date.now();

    const apy: EarnApyDto = {
      day: this.computeApy(rows, latest, WINDOWS.day, nowMs),
      week: this.computeApy(rows, latest, WINDOWS.week, nowMs),
      month: this.computeApy(rows, latest, WINDOWS.month, nowMs),
    };

    return {
      bookNav: this.scaled(latest.bookNav, NAV_SCALE),
      strwtRate: this.scaled(latest.strwtRate, RATE_SCALE),
      tvl: this.scaled(latest.tvl, NAV_SCALE),
      apy,
      history: this.downsample(rows),
    };
  }

  /**
   * Annualise the stRWT-rate growth over the actual elapsed span within
   * `windowSeconds`. Returns `null` when the history doesn't reach back the
   * full window (honesty rule), or when inputs are degenerate.
   */
  private computeApy(
    rows: EarnSnapshot[],
    latest: EarnSnapshot,
    windowSeconds: number,
    nowMs: number,
  ): number | null {
    const windowStartMs = nowMs - windowSeconds * 1000;

    // Honesty guard 1: require at least one snapshot OLDER than the window
    // start. The earliest row we have is rows[0]; if even it is younger than
    // windowStart, our history is shorter than the window → null.
    const earliest = rows[0];
    if (earliest.ts.getTime() > windowStartMs) {
      return null;
    }

    // Find the oldest snapshot whose ts is within the window (i.e. the first
    // row at or after windowStart). rows are ascending by ts.
    const start = rows.find((r) => r.ts.getTime() >= windowStartMs);
    if (!start) return null;

    const elapsedSeconds = (latest.ts.getTime() - start.ts.getTime()) / 1000;
    // Need a positive span to annualise. With a single point in-window, or two
    // points at the same ts, elapsed is 0 → can't annualise → null.
    if (elapsedSeconds <= 0) return null;

    const rateStart = Number(start.strwtRate);
    const rateNow = Number(latest.strwtRate);
    if (!Number.isFinite(rateStart) || rateStart <= 0 || !Number.isFinite(rateNow)) {
      return null;
    }

    const ratio = rateNow / rateStart;
    // Rate never decreases (rewards only raise it; the virtual-offset math is
    // monotonic non-decreasing). A ratio < 1 would indicate corrupt data —
    // treat defensively as null rather than reporting negative APY.
    if (ratio < 1) {
      this.logger.warn(
        `stRWT rate decreased in ${windowSeconds}s window (start=${rateStart} now=${rateNow}) — returning null`,
      );
      return null;
    }
    // Honesty guard 2: a flat rate is a genuine 0% APY, not null.
    if (ratio === 1) return 0;

    const apy = Math.pow(ratio, YEAR_SECONDS / elapsedSeconds) - 1;
    return Number.isFinite(apy) ? apy : null;
  }

  /**
   * Downsample the ascending rows to ~MAX_HISTORY_POINTS evenly-spaced points
   * for the sparkline. Always includes the last point so the chart's right edge
   * is the live value. Each point carries bookNav + strwtRate so the frontend
   * can value any holdings against either.
   */
  private downsample(rows: EarnSnapshot[]): EarnHistoryPointDto[] {
    const n = rows.length;
    if (n <= MAX_HISTORY_POINTS) {
      return rows.map((r) => this.toPoint(r));
    }
    const step = (n - 1) / (MAX_HISTORY_POINTS - 1);
    const out: EarnHistoryPointDto[] = [];
    for (let i = 0; i < MAX_HISTORY_POINTS; i++) {
      const idx = Math.round(i * step);
      out.push(this.toPoint(rows[idx]));
    }
    return out;
  }

  private toPoint(r: EarnSnapshot): EarnHistoryPointDto {
    return {
      ts: r.ts.toISOString(),
      bookNav: this.scaled(r.bookNav, NAV_SCALE),
      strwtRate: this.scaled(r.strwtRate, RATE_SCALE),
    };
  }

  /**
   * Convert a 6-dec fixed-point numeric string to a JS float for the API.
   * Safe here: NAV (~1) and rate (~10) are tiny; the float is for display only,
   * never re-used in on-chain math. The canonical fixed-point value stays in
   * the DB.
   */
  private scaled(fixed: string, scale: bigint): number {
    return Number(fixed) / Number(scale);
  }
}

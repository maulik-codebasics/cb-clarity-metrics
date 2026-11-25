/**
 * Generic flattener for Clarity "project-live-insights" responses.
 *
 * The response is an array of `{ metricName, information: [ {...} ] }`. Field
 * names are not hardcoded: every numeric-looking field becomes a metric row,
 * and every non-numeric string field is treated as a dimension value. Problems
 * with individual items or fields become warnings; only a response that isn't
 * an array of metric objects at all is a parse failure.
 */

export const URL_VALUE_MAX_LENGTH = 2000;
const MAX_DIMENSIONS = 3;
const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** Metric names we expect. Others are still stored, but logged so they can be reviewed. */
export const KNOWN_METRICS = new Set([
    'Traffic',
    'EngagementTime',
    'ScrollDepth',
    'PopularPages',
    'DeadClickCount',
    'RageClickCount',
    'QuickbackClick',
    'ExcessiveScroll',
    'ScriptErrorCount',
    'ErrorClickCount',
]);

export interface Dimension {
    name: string;
    value: string;
}

export interface MetricRow {
    metricName: string;
    field: string;
    /** Always exactly three entries; unused ones are `{ name: '', value: '' }`. */
    dims: [Dimension, Dimension, Dimension];
    /** Decimal as a string, to keep full precision into numeric(20,6). */
    value: string;
}

export interface FlattenResult {
    rows: MetricRow[];
    /** Number of `information[]` items seen (the run's "rows fetched"). */
    itemCount: number;
    warnings: string[];
}

export interface FlattenOptions {
    /** Dimensions the pull asked for; they come first, in this order. */
    requestedDimensions: readonly string[];
    /** Strip `?query` and `#fragment` from URL dimension values. */
    stripUrlQuery: boolean;
}

export class FlattenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FlattenError';
    }
}

const EMPTY_DIM: Dimension = { name: '', value: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise a numeric-looking value to a decimal string, or return null. */
export function toNumericString(value: unknown): string | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim().replace(/,/g, '');
        return NUMERIC.test(trimmed) ? trimmed : null;
    }
    return null;
}

function isUrlDimension(name: string): boolean {
    return /^(url|page|pageurl|referrerurl)$/i.test(name);
}

export function normaliseDimensionValue(name: string, value: string, stripUrlQuery: boolean): string {
    let result = value.trim();
    if (isUrlDimension(name)) {
        if (stripUrlQuery) {
            result = result.split(/[?#]/, 1)[0] ?? '';
        }
        result = result.slice(0, URL_VALUE_MAX_LENGTH);
    }
    return result;
}

export function flattenClarityResponse(payload: unknown, options: FlattenOptions): FlattenResult {
    if (!Array.isArray(payload)) {
        throw new FlattenError(`Expected a JSON array of metrics, got ${payload === null ? 'null' : typeof payload}`);
    }

    const rows: MetricRow[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let itemCount = 0;
    let duplicates = 0;
    const requested = options.requestedDimensions.map((d) => d.toLowerCase());

    payload.forEach((metric, metricIndex) => {
        if (!isRecord(metric) || typeof metric.metricName !== 'string' || metric.metricName.trim() === '') {
            warnings.push(`Item ${metricIndex} has no metricName; skipped`);
            return;
        }
        const metricName = metric.metricName.trim();
        if (!KNOWN_METRICS.has(metricName)) {
            warnings.push(`Unknown metric "${metricName}" (stored anyway)`);
        }
        if (!Array.isArray(metric.information)) {
            warnings.push(`Metric "${metricName}" has no information array; skipped`);
            return;
        }

        metric.information.forEach((item: unknown, itemIndex: number) => {
            itemCount += 1;
            if (!isRecord(item)) {
                warnings.push(`${metricName}[${itemIndex}] is not an object; skipped`);
                return;
            }

            const numeric: Array<[string, string]> = [];
            const dims: Dimension[] = [];
            for (const [key, raw] of Object.entries(item)) {
                if (raw === null || raw === undefined || raw === '') {
                    continue;
                }
                const asNumber = requested.includes(key.toLowerCase()) ? null : toNumericString(raw);
                if (asNumber !== null) {
                    numeric.push([key, asNumber]);
                } else if (typeof raw === 'string' || typeof raw === 'number') {
                    dims.push({ name: key, value: normaliseDimensionValue(key, String(raw), options.stripUrlQuery) });
                } else {
                    warnings.push(`${metricName}[${itemIndex}].${key} has unsupported type ${typeof raw}; ignored`);
                }
            }

            // Requested dimensions first (in request order), then any others alphabetically.
            dims.sort((a, b) => {
                const ia = requested.indexOf(a.name.toLowerCase());
                const ib = requested.indexOf(b.name.toLowerCase());
                if (ia !== -1 || ib !== -1) {
                    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
                }
                return a.name.localeCompare(b.name);
            });
            if (dims.length > MAX_DIMENSIONS) {
                warnings.push(
                    `${metricName}[${itemIndex}] has ${dims.length} dimension fields; kept ${dims
                        .slice(0, MAX_DIMENSIONS)
                        .map((d) => d.name)
                        .join(', ')}`,
                );
            }
            const kept = dims.slice(0, MAX_DIMENSIONS);
            const padded: [Dimension, Dimension, Dimension] = [kept[0] ?? EMPTY_DIM, kept[1] ?? EMPTY_DIM, kept[2] ?? EMPTY_DIM];

            for (const [field, value] of numeric) {
                const key = [metricName, field, padded[0].value, padded[1].value, padded[2].value].join('\u0000');
                if (seen.has(key)) {
                    duplicates += 1;
                    continue;
                }
                seen.add(key);
                rows.push({ metricName, field, dims: padded, value });
            }
        });
    });

    if (duplicates > 0) {
        warnings.push(
            `${duplicates} value(s) collided after URL normalisation (query strings stripped / length capped); kept the first occurrence`,
        );
    }

    return { rows, itemCount, warnings };
}

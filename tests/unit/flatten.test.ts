import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlattenError, URL_VALUE_MAX_LENGTH, flattenClarityResponse, normaliseDimensionValue, toNumericString } from '@/etl/flatten';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/clarity', name), 'utf8'));

describe('toNumericString', () => {
    it.each([
        ['1234', '1234'],
        [' 2.14 ', '2.14'],
        ['1,234', '1234'],
        [6.7, '6.7'],
        ['-3', '-3'],
        ['1e3', '1e3'],
    ])('%j → %s', (input, expected) => {
        expect(toNumericString(input)).toBe(expected);
    });

    it.each(['NaN', 'abc', '', 'Windows', true, null, {}, Number.POSITIVE_INFINITY])('%j is not numeric', (input) => {
        expect(toNumericString(input)).toBeNull();
    });
});

describe('flattenClarityResponse', () => {
    it('flattens the overall response, turning string numbers into values', () => {
        const result = flattenClarityResponse(fixture('overall.json'), { requestedDimensions: [], stripUrlQuery: true });
        const sessions = result.rows.find((r) => r.metricName === 'Traffic' && r.field === 'totalSessionCount');
        expect(sessions?.value).toBe('4821');
        expect(sessions?.dims).toEqual([
            { name: '', value: '' },
            { name: '', value: '' },
            { name: '', value: '' },
        ]);
        const rage = result.rows.find((r) => r.metricName === 'RageClickCount' && r.field === 'sessionsWithMetricPercentage');
        expect(rage?.value).toBe('1.2');
        expect(result.warnings).toEqual([]);
    });

    it('treats string fields in information[] as dimensions, requested ones first', () => {
        const result = flattenClarityResponse(fixture('source_medium.json'), {
            requestedDimensions: ['Source', 'Medium'],
            stripUrlQuery: true,
        });
        const row = result.rows.find((r) => r.metricName === 'Traffic' && r.field === 'totalSessionCount' && r.dims[0].value === 'google');
        expect(row?.dims).toEqual([
            { name: 'Source', value: 'google' },
            { name: 'Medium', value: 'organic' },
            { name: '', value: '' },
        ]);
        expect(result.itemCount).toBe(9 * 4);
    });

    it('strips query strings from URL dimensions and keeps the first value on collision', () => {
        const result = flattenClarityResponse(fixture('url.json'), { requestedDimensions: ['URL'], stripUrlQuery: true });
        const urls = new Set(result.rows.map((r) => r.dims[0].value));
        expect(urls).toContain('https://codebasics.io/courses/power-bi-data-analysis');
        expect([...urls].some((u) => u.includes('?'))).toBe(false);
    });

    it('keeps query strings when STRIP_URL_QUERY is off', () => {
        const result = flattenClarityResponse(fixture('url.json'), { requestedDimensions: ['URL'], stripUrlQuery: false });
        expect(result.rows.some((r) => r.dims[0].value.includes('?utm_source=yt'))).toBe(true);
    });

    it('logs (but does not fail on) unknown metrics, bad items and unparseable fields', () => {
        const result = flattenClarityResponse(fixture('edge-cases.json'), { requestedDimensions: [], stripUrlQuery: true });

        // "1,234" and a plain number both parse; OS becomes a dimension.
        const windows = result.rows.filter((r) => r.metricName === 'Traffic' && r.dims[0].value === 'Windows');
        expect(windows.map((r) => [r.field, r.value])).toEqual([
            ['totalSessionCount', '1234'],
            ['totalBotSessionCount', '10'],
            ['distinctUserCount', '900'],
            ['pagesPerSessionPercentage', '2.14'],
        ]);
        // A numeric-looking OS value that wasn't requested as a dimension is stored as a number.
        expect(result.rows.some((r) => r.metricName === 'Traffic' && r.field === 'OS' && r.value === '10')).toBe(true);
        // Unknown metric stored anyway.
        expect(result.rows.some((r) => r.metricName === 'BrandNewMetric' && r.field === 'someCount')).toBe(true);
        // Two URLs that collide after stripping: first kept.
        const scroll = result.rows.filter((r) => r.metricName === 'ScrollDepth');
        expect(scroll).toEqual([
            {
                metricName: 'ScrollDepth',
                field: 'averageScrollDepth',
                dims: [
                    { name: 'URL', value: 'https://codebasics.io/a' },
                    { name: '', value: '' },
                    { name: '', value: '' },
                ],
                value: '40',
            },
        ]);

        expect(result.warnings).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Unknown metric "BrandNewMetric"'),
                expect.stringContaining('DeadClickCount" has no information array'),
                expect.stringContaining('Item 3 has no metricName'),
                expect.stringContaining('Item 4 has no metricName'),
                expect.stringContaining('note has unsupported type object'),
            ]),
        );
    });

    it('treats requested dimensions as dimensions even when they look numeric', () => {
        const result = flattenClarityResponse([{ metricName: 'Traffic', information: [{ OS: '10', totalSessionCount: '5' }] }], {
            requestedDimensions: ['OS'],
            stripUrlQuery: true,
        });
        expect(result.rows).toEqual([
            {
                metricName: 'Traffic',
                field: 'totalSessionCount',
                dims: [
                    { name: 'OS', value: '10' },
                    { name: '', value: '' },
                    { name: '', value: '' },
                ],
                value: '5',
            },
        ]);
    });

    it('fails only when the response is not an array', () => {
        expect(() => flattenClarityResponse({ error: 'x' }, { requestedDimensions: [], stripUrlQuery: true })).toThrow(FlattenError);
        expect(() => flattenClarityResponse(null, { requestedDimensions: [], stripUrlQuery: true })).toThrow(FlattenError);
        expect(flattenClarityResponse([], { requestedDimensions: [], stripUrlQuery: true }).rows).toEqual([]);
    });
});

describe('normaliseDimensionValue', () => {
    it('caps URL values so they stay indexable', () => {
        const long = `https://codebasics.io/${'a'.repeat(5000)}`;
        expect(normaliseDimensionValue('URL', long, true)).toHaveLength(URL_VALUE_MAX_LENGTH);
    });

    it('leaves non-URL dimensions alone', () => {
        expect(normaliseDimensionValue('Source', 'google?x', true)).toBe('google?x');
    });
});

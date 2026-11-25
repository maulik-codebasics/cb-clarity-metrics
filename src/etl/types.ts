/** Breakdown dimensions the Clarity Data Export API accepts (dimension1..3). */
export const CLARITY_DIMENSIONS = ['Browser', 'Device', 'Country/Region', 'OS', 'Source', 'Medium', 'Campaign', 'Channel', 'URL'] as const;

export type ClarityDimension = (typeof CLARITY_DIMENSIONS)[number];

/** One Clarity API call made on every run. */
export interface PullDefinition {
    key: string;
    dimensions: ClarityDimension[];
    enabled: boolean;
    displayOrder: number;
}

export function isClarityDimension(value: string): value is ClarityDimension {
    return (CLARITY_DIMENSIONS as readonly string[]).includes(value);
}

export type LcovLineDetail = {
    line: number;
    hit: number;
};

export type LcovFunctionDetail = {
    name: string;
    line: number;
    hit?: number;
};

export type LcovBranchDetail = {
    line: number;
    block: number;
    branch: number;
    taken: number;
};

export type LcovRecord = {
    title?: string;
    file?: string;
    lines: {
        found: number;
        hit: number;
        details: LcovLineDetail[];
    };
    functions: {
        found: number;
        hit: number;
        details: LcovFunctionDetail[];
    };
    branches: {
        found: number;
        hit: number;
        details: LcovBranchDetail[];
    };
};

function createEmptyRecord(): LcovRecord {
    return {
        lines: { found: 0, hit: 0, details: [] },
        functions: { found: 0, hit: 0, details: [] },
        branches: { found: 0, hit: 0, details: [] }
    };
}

/**
 * Parse an LCOV report provided as a string.
 * Throws if the string cannot be parsed into any records.
 */
export function parseLcov(input: string): LcovRecord[] {
    const records: LcovRecord[] = [];
    let record = createEmptyRecord();

    // Ensure we flush the last record only when we see end_of_record.
    const lines = input.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.toLowerCase() === "end_of_record") {
            records.push(record);
            record = createEmptyRecord();
            continue;
        }

        const [tagRaw, ...rest] = line.split(":");
        const tag = (tagRaw ?? "").toUpperCase();
        const value = rest.join(":"); // keep ':' inside filenames/paths if present

        switch (tag) {
            case "TN": {
                record.title = value.trim();
                break;
            }
            case "SF": {
                record.file = value.trim();
                break;
            }
            case "FNF": {
                record.functions.found = Number(value.trim());
                break;
            }
            case "FNH": {
                record.functions.hit = Number(value.trim());
                break;
            }
            case "LF": {
                record.lines.found = Number(value.trim());
                break;
            }
            case "LH": {
                record.lines.hit = Number(value.trim());
                break;
            }
            case "DA": {
                const [lineNo, hitCount] = value.split(",");
                record.lines.details.push({
                    line: Number(lineNo),
                    hit: Number(hitCount)
                });
                break;
            }
            case "FN": {
                const [lineNo, name] = value.split(",");
                record.functions.details.push({
                    name,
                    line: Number(lineNo)
                });
                break;
            }
            case "FNDA": {
                const [hitCountRaw, name] = value.split(",");
                const hitCount = Number(hitCountRaw);

                const fn = record.functions.details.find(d => d.name === name && d.hit === undefined);
                if (fn) fn.hit = hitCount;

                break;
            }
            case "BRDA": {
                const [lineNo, blockNo, branchNo, takenRaw] = value.split(",");
                record.branches.details.push({
                    line: Number(lineNo),
                    block: Number(blockNo),
                    branch: Number(branchNo),
                    taken: takenRaw === "-" ? 0 : Number(takenRaw)
                });
                break;
            }
            case "BRF": {
                record.branches.found = Number(value.trim());
                break;
            }
            case "BRH": {
                record.branches.hit = Number(value.trim());
                break;
            }
            default:
                // ignore unknown tags
                break;
        }
    }

    if (records.length === 0) {
        throw new Error("Failed to parse LCOV string: no end_of_record markers found.");
    }

    return records;
}

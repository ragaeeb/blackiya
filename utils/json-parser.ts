/**
 * JSON Parser Utility
 *
 * Provides robust parsing for complex, embedded, or dirty JSON structures
 * often found in LLM responses.
 */

/**
 * Extracts a balanced JSON array from a string.
 * Useful for finding JSON arrays embedded within other text or garbage.
 *
 * @param data - The string to search
 * @param startFrom - Optional index to start searching from
 * @returns The extracted JSON string or null if not found
 */
export function extractBalancedJsonArray(data: string, startFrom = 0): string | null {
    const startBracket = data.indexOf('[', startFrom);
    if (startBracket === -1) {
        return null;
    }

    const endBracket = scanForClosingBracket(data, startBracket);
    if (endBracket !== -1) {
        return data.substring(startBracket, endBracket + 1);
    }

    return null;
}

interface ParserState {
    balance: number;
    insideString: boolean;
    isEscaped: boolean;
}

function scanForClosingBracket(data: string, start: number): number {
    const state: ParserState = { balance: 0, insideString: false, isEscaped: false };

    for (let i = start; i < data.length; i++) {
        if (processChar(data[i], state)) {
            return i;
        }
    }

    return -1;
}

function processChar(char: string, state: ParserState): boolean {
    if (state.isEscaped) {
        state.isEscaped = false;
        return false;
    }

    if (char === '\\') {
        state.isEscaped = true;
        return false;
    }

    if (char === '"') {
        state.insideString = !state.insideString;
        return false;
    }

    if (state.insideString) {
        return false;
    }

    if (char === '[') {
        state.balance++;
    } else if (char === ']') {
        state.balance--;
        return state.balance === 0;
    }

    return false;
}

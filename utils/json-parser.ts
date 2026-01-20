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

    let balance = 0;
    let insideString = false;
    let isEscaped = false;

    for (let i = startBracket; i < data.length; i++) {
        const char = data[i];

        if (isEscaped) {
            isEscaped = false;
            continue;
        }

        if (char === '\\') {
            isEscaped = true;
            continue;
        }

        if (char === '"') {
            insideString = !insideString;
            continue;
        }

        if (!insideString) {
            if (char === '[') {
                balance++;
            } else if (char === ']') {
                balance--;
                if (balance === 0) {
                    return data.substring(startBracket, i + 1);
                }
            }
        }
    }

    return null;
}

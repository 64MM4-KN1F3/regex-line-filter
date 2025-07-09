import { moment } from 'obsidian';

export class Templater {
    /**
     * Resolves date-based template variables in a string.
     * @param template The string containing potential date templates.
     * @returns The string with date templates resolved.
     */
    public static resolve(template: string): string {
        // General regex to find all {{...}} templates.
        const templateRegex = /\{\{(.*?)\}\}/g;

        return template.replace(templateRegex, (match, content) => {
            const [variable, format] = content.trim().split(':').map((s: string) => s.trim());
            const momentFormat = format || 'YYYY-MM-DD'; // Default format

            try {
                // First, try to resolve as a date range.
                const dateRange = this.getDatesForRange(variable);
                if (dateRange) {
                    const formattedDates = dateRange.map(d => d.format(momentFormat));
                    return `(${formattedDates.join('|')})`;
                }

                // If not a range, try to resolve as a single date.
                const targetDate = this.getDateFromVariable(variable);
                if (targetDate) {
                    return targetDate.format(momentFormat);
                }
            } catch (e) {
                console.error(`Regex Line Filter: Error formatting date for template "${match}". Using default.`, e);
                // Fallback for valid variables but invalid formats
                const fallbackDate = this.getDateFromVariable(variable);
                if (fallbackDate) {
                    return fallbackDate.format('YYYY-MM-DD');
                }
            }

            // If the variable is not recognized, return the original template string
            return match;
        });
    }

    /**
     * Returns an array of Moment objects for a given date range variable.
     * @param variable The date range variable (e.g., 'last-week', 'this-month').
     * @returns An array of Moment objects, or null if the variable is not a recognized range.
     */
    private static getDatesForRange(variable: string): moment.Moment[] | null {
        const now = moment();
        let startOf: moment.Moment;
        let endOf: moment.Moment;

        const lowerCaseVariable = variable.toLowerCase();

        switch (lowerCaseVariable) {
            case 'this-week':
                startOf = now.clone().startOf('isoWeek');
                endOf = now.clone().endOf('isoWeek');
                break;
            case 'last-week':
                startOf = now.clone().subtract(1, 'week').startOf('isoWeek');
                endOf = now.clone().subtract(1, 'week').endOf('isoWeek');
                break;
            case 'next-week':
                startOf = now.clone().add(1, 'week').startOf('isoWeek');
                endOf = now.clone().add(1, 'week').endOf('isoWeek');
                break;
            case 'this-month':
                startOf = now.clone().startOf('month');
                endOf = now.clone().endOf('month');
                break;
            case 'last-month':
                startOf = now.clone().subtract(1, 'month').startOf('month');
                endOf = now.clone().subtract(1, 'month').endOf('month');
                break;
            case 'next-month':
                startOf = now.clone().add(1, 'month').startOf('month');
                endOf = now.clone().add(1, 'month').endOf('month');
                break;
            case 'this-year':
                startOf = now.clone().startOf('year');
                endOf = now.clone().endOf('year');
                break;
            case 'last-year':
                startOf = now.clone().subtract(1, 'year').startOf('year');
                endOf = now.clone().subtract(1, 'year').endOf('year');
                break;
            case 'next-year':
                startOf = now.clone().add(1, 'year').startOf('year');
                endOf = now.clone().add(1, 'year').endOf('year');
                break;
            default:
                return null; // Not a recognized range variable
        }

        const dates: moment.Moment[] = [];
        let current = startOf.clone();
        while (current.isSameOrBefore(endOf, 'day')) {
            dates.push(current.clone());
            current.add(1, 'day');
        }
        return dates;
    }

    /**
     * Returns a Moment object based on the template variable.
     * @param variable The date variable (e.g., 'today', 'yesterday').
     * @returns A Moment object or null if the variable is not recognized.
     */
    private static getDateFromVariable(variable: string): moment.Moment | null {
        const now = moment();
        switch (variable.toLowerCase()) {
            case 'date':       // Legacy support
            case 'today':
                return now;
            case 'yesterday':
                return now.subtract(1, 'days');
            case 'tomorrow':
                return now.add(1, 'days');
            default:
                return null; // Variable not recognized
        }
    }
}
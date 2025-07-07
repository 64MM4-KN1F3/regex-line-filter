import { moment } from 'obsidian';

export class Templater {
    /**
     * Resolves only {{date}} variables in a template string.
     * @param template The string containing potential date templates.
     * @returns The string with date templates resolved.
     */
    public static resolve(template: string): string {
        let resolvedTemplate = template;

        // {{date}} with optional formatting, e.g., {{date:YYYY-MM-DD}}
        const dateRegex = /\{\{date:?(.*?)\}\}/g;
        
        resolvedTemplate = resolvedTemplate.replace(dateRegex, (match, format) => {
            const momentFormat = format.trim() || 'YYYY-MM-DD'; // Default format if none provided
            try {
                return moment().format(momentFormat);
            } catch (e) {
                console.error("Regex Line Filter: Error formatting date. Using default.", e);
                return moment().format('YYYY-MM-DD');
            }
        });

        return resolvedTemplate;
    }
}
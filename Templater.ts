import { TFile } from 'obsidian';
import { moment } from 'obsidian';

export class Templater {
    // Method to resolve both static and dynamic variables
    public static resolve(template: string, file: TFile): string {
        let resolvedTemplate = template;

        // Resolve static variables like {{title}}
        resolvedTemplate = this.resolveStaticVariables(resolvedTemplate, file);

        // Resolve dynamic variables like {{date}} and {{time}}
        resolvedTemplate = this.resolveDynamicVariables(resolvedTemplate);

        return resolvedTemplate;
    }

    // Resolve variables that don't change during a session
    private static resolveStaticVariables(template: string, file: TFile): string {
        if (!file) return template;

        let resolvedTemplate = template;

        // {{title}}
        if (template.includes('{{title}}')) {
            resolvedTemplate = resolvedTemplate.replace(/\{\{title\}\}/g, file.basename);
        }

        return resolvedTemplate;
    }

    // Resolve variables that can change, like date and time
    private static resolveDynamicVariables(template: string): string {
        let resolvedTemplate = template;

        // {{date}} and {{time}} with optional formatting
        const dateTimeRegex = /\{\{(date|time):?(.*?)\}\}/g;
        resolvedTemplate = resolvedTemplate.replace(dateTimeRegex, (match, type, format) => {
            const momentFormat = format || 'YYYY-MM-DD'; // Default format
            if (type === 'date') {
                return moment().format(momentFormat);
            }
            // Note: Add time support if needed
            return match; // Return original match if type is not recognized
        });

        return resolvedTemplate;
    }
}
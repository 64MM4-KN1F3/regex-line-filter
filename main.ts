import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, editorInfoField, TFile } from 'obsidian';
import { EditorState, StateField, StateEffect, Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body'; // CSS Class for body

// --- Settings ---
interface RegexLineFilterSettings { hideEmptyLines: boolean; regexHistory: string[]; }
const DEFAULT_SETTINGS: RegexLineFilterSettings = { hideEmptyLines: true, regexHistory: [], }

// --- State & Effects ---
interface FilterState { regex: RegExp | null; enabled: boolean; hideEmptyLines: boolean; }
const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();

// --- ViewPlugin definition ---
const filterViewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = this.buildDecorations(view); }
        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged || update.state.field(filterStateField) !== update.startState.field(filterStateField)) {
                 this.decorations = this.buildDecorations(update.view);
            }
        }
        buildDecorations(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();
            const { regex, enabled, hideEmptyLines } = view.state.field(filterStateField);
            if (!enabled || !regex) { return builder.finish(); }
            const doc = view.state.doc;
            try {
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    const lineText = line?.text;
                    if (typeof lineText !== 'string') { continue; }
                    const isEmpty = lineText.trim().length === 0;
                    let shouldHide = false;
                    let matchesRegex = regex.test(lineText);
                    if (!matchesRegex) { shouldHide = true; }
                    if (hideEmptyLines && isEmpty) { shouldHide = true; }
                    if (shouldHide) { builder.add(line.from, line.from, Decoration.line({ attributes: { class: 'regex-filter-hidden-line' } })); }
                }
            } catch (e) { console.error("Regex Line Filter: Error during decoration build:", e); }
            return builder.finish();
        }
    },
    { decorations: (v) => v.decorations, }
);
// --- End of ViewPlugin definition ---


// --- StateField definition ---
const filterStateField = StateField.define<FilterState>({
    create(state): FilterState { return { regex: null, enabled: false, hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines, }; },
    update(value, tr): FilterState { let newValue: FilterState = { ...value }; for (let effect of tr.effects) { if (effect.is(setRegexEffect)) { newValue.regex = effect.value; newValue.enabled = !!effect.value; } if (effect.is(toggleFilterEffect)) { newValue.enabled = effect.value; if (!effect.value) { newValue.enabled = false; } else if (!newValue.regex) { newValue.enabled = false; console.warn("Attempted to enable filter without a regex."); } } if (effect.is(setHideEmptyLinesEffect)) { newValue.hideEmptyLines = effect.value; } } return newValue; }
});

// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings; lastRegexStr: string | null = null; cssStyleEl: HTMLElement | null = null;
    async onload() { console.log('Loading Regex Line Filter plugin'); await this.loadSettings(); this.addCommand({ id: 'toggle-regex-filter', name: 'Toggle Regex Line Filter', editorCallback: (editor: Editor, view: MarkdownView) => { this.toggleFilter(editor, view); }, }); this.addSettingTab(new RegexLineFilterSettingTab(this.app, this)); this.registerEditorExtension([filterStateField, filterViewPlugin]); this.addCss(); this.app.workspace.onLayoutReady(() => { this.dispatchSettingToEditors(this.settings.hideEmptyLines); }); }
    onunload() { console.log('Unloading Regex Line Filter plugin'); this.removeCss(); // removeCss now also handles body class
        this.app.workspace.iterateCodeMirrors(cm => { try { const currentFilterState = cm.state.field(filterStateField, false); if (currentFilterState?.enabled) { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } } catch (e) { /* Ignore */ } }); }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); if (!Array.isArray(this.settings.regexHistory)) { this.settings.regexHistory = []; } this.settings.regexHistory = this.settings.regexHistory.slice(0, REGEX_HISTORY_LIMIT); }
    async saveSettings() { await this.saveData(this.settings); }
    updateRegexHistory(newRegexString: string) { const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString); const updatedHistory = [newRegexString, ...filteredHistory]; this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT); this.saveSettings(); }
    dispatchSettingToEditors(newValue: boolean) { this.app.workspace.iterateCodeMirrors(cm => { try { if (cm.state.field(filterStateField, false) !== undefined) { cm.dispatch({ effects: setHideEmptyLinesEffect.of(newValue) }); } } catch (e) { console.warn("Regex Line Filter: Error dispatching setting", e); } }); }

    // ----- Add CSS including the body class rule -----
    addCss() {
        if (document.getElementById('regex-filter-styles')) return;
        const css = `
            /* Rule to hide non-matching lines */
            .regex-filter-hidden-line {
                display: none !important;
            }

            /* Rule to style the active view when filter is on */
            body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .view-content {
                /* Inset box shadow to darken edges */
                box-shadow: inset 0 0 0 70px rgba(0, 0, 0, 0.15); /* Adjust size/color/opacity */

                /* Alternatively, adjust padding and background */
                /* padding: 30px !important; */
                /* background-color: var(--background-secondary) !important; */

                transition: box-shadow 0.3s ease-in; /* Optional smooth transition */
            }

            /* Ensure padding doesn't affect CodeMirror gutter/line numbers if using padding approach */
            /* body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .cm-editor { padding: 0 !important; } */
        `;
        this.cssStyleEl = document.createElement('style');
        this.cssStyleEl.id = 'regex-line-filter-styles';
        this.cssStyleEl.textContent = css;
        document.head.appendChild(this.cssStyleEl);
     }
    // ----- End addCss -----

    // ----- removeCss now also removes body class -----
    removeCss() {
         // Remove the style tag
         if (this.cssStyleEl) { this.cssStyleEl.remove(); this.cssStyleEl = null; }
         const existingStyle = document.getElementById('regex-line-filter-styles');
         if (existingStyle) { existingStyle.remove(); }
         // Remove the body class
         document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
    }
    // ----- End removeCss -----

    // ----- toggleFilter manages body class -----
    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as any).cm as EditorView;
        if (!cm || !(cm instanceof EditorView)) { new Notice("Regex filter only works in Live Preview or Source Mode."); return; }
        const currentFilterState = cm.state.field(filterStateField, false);
        if(currentFilterState === undefined) { new Notice("Filter not ready. Please try toggling again."); return; }

        if (currentFilterState.enabled) {
            // Disable filter
            cm.dispatch({ effects: toggleFilterEffect.of(false) });
            document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS); // Remove body class
            new Notice('Regex filter disabled.');
        } else {
            // Enable filter (via prompt)
            this.promptForRegex(cm);
        }
    }
    // ----- End toggleFilter -----

    // ----- promptForRegex manages body class -----
    promptForRegex(cm: EditorView) {
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";
        new RegexInputModal(this.app, prefillValue, this.settings.regexHistory, (result) => {
            if (result) { // User submitted a regex string
                try {
                    const regex = new RegExp(result, 'u');
                    this.lastRegexStr = result;
                    this.updateRegexHistory(result);

                    // Dispatch effect to set the regex
                    cm.dispatch({ effects: [ setRegexEffect.of(regex) ] });
                    document.body.classList.add(ACTIVE_FILTER_BODY_CLASS); // Add body class on success
                    new Notice(`Regex filter enabled: /${result}/u`);
                } catch (e) { // Invalid Regex
                    const errorMessage = (e instanceof Error) ? e.message : String(e);
                    new Notice(`Invalid Regex: ${errorMessage}`);
                    console.error("Regex Compile Error:", e);
                    document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS); // Ensure class removed on error
                    try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore */ }
                }
            } else { // User cancelled
                 new Notice('Regex filter cancelled.');
                 document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS); // Ensure class removed on cancel
                 try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore */ }
            }
        }).open();
    }
    // ----- End promptForRegex -----

} // End of Plugin Class

// --- Settings Tab Class ---
class RegexLineFilterSettingTab extends PluginSettingTab {
	plugin: RegexLineFilterPlugin; constructor(app: App, plugin: RegexLineFilterPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void { const {containerEl} = this; containerEl.empty(); containerEl.createEl('h2', {text: 'Regex Line Filter Settings'}); new Setting(containerEl).setName('Hide empty lines').setDesc('When the filter is active, also hide lines that contain only whitespace.').addToggle(toggle => toggle.setValue(this.plugin.settings.hideEmptyLines).onChange(async (value) => { this.plugin.settings.hideEmptyLines = value; await this.plugin.saveSettings(); this.plugin.dispatchSettingToEditors(value); })); }
}

// --- Modal Class definition (Includes History Display) ---
class RegexInputModal extends Modal {
    result: string; onSubmit: (result: string | null) => void; initialValue: string; history: string[]; inputComponent: Setting; textInputEl: HTMLInputElement | null = null;
    constructor(app: App, initialValue: string, history: string[], onSubmit: (result: string | null) => void) { super(app); this.initialValue = initialValue; this.history = history; this.onSubmit = onSubmit; this.result = initialValue; }
    onOpen() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Enter Regex Filter' }); this.inputComponent = new Setting(contentEl).setName('Regular Expression (supports emoji):').addText((text) => { this.textInputEl = text.inputEl; text.setValue(this.initialValue).setPlaceholder('e.g., ^\\s*- \\[ \\].*💡').onChange((value) => { this.result = value; }); text.inputEl.focus(); text.inputEl.select(); text.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.submit(); } }); }); this.inputComponent.controlEl.addClass('regex-filter-input-control'); if (this.history && this.history.length > 0) { const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' }); historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' }); this.history.forEach(histEntry => { const btn = historyEl.createEl('button', { text: `/${histEntry}/`, cls: 'regex-filter-history-item', attr: { title: histEntry } }); btn.addEventListener('click', () => { if (this.textInputEl) { this.textInputEl.value = histEntry; this.result = histEntry; this.textInputEl.focus(); } }); }); } new Setting(contentEl).addButton((btn) => btn.setButtonText('Apply Filter').setCta().onClick(() => { this.submit(); })).addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null); })); }
    submit() { if (this.result && this.result.trim().length > 0) { this.close(); this.onSubmit(this.result); } else if (this.result === "") { new Notice("Regex cannot be empty. Filter cancelled."); this.close(); this.onSubmit(null); } else { new Notice("Please enter a regular expression."); } }
    onClose() { let { contentEl } = this; contentEl.empty(); }
}
// --- End of Modal Class definition ---
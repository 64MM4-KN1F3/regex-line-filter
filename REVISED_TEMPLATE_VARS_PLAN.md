# Revised Plan: On-Demand Template Variable Support

This document outlines the revised plan to refactor the template variable support feature based on user feedback. The goal is to make the feature more performant and controllable.

### **1. Core Requirements**

1.  **Toggleable Feature:** Template variable support must be optional and controlled by a new plugin setting. It will be **disabled by default**.
2.  **Scoped Support:** The feature will **only** support the `{{date}}` variable with custom formatting (e.g., `{{date:YYYY-MM-DD}}`). Support for `{{title}}` will be removed.
3.  **On-Demand Resolution:** Date variables will be resolved *only* when a filter containing them is activated or toggled on. There will be no "live" updates during typing or scrolling.

---

### **2. Implementation Plan**

#### **Phase 1: Update Settings**

1.  **Modify `RegexLineFilterSettings` Interface (in `main.ts`):**
    *   Add a new property: `enableTemplateVariables: boolean;`.
2.  **Update `DEFAULT_SETTINGS` (in `main.ts`):**
    *   Set `enableTemplateVariables: false`.
3.  **Update `RegexLineFilterSettingTab` (in `main.ts`):**
    *   Add a new `Setting` toggle switch in the `display()` method.
    *   **Name:** "Enable `{{date}}` template variables"
    *   **Description:** "When enabled, any instance of `{{date}}` or `{{date:format}}` in a filter will be replaced with the current date *at the moment the filter is activated*. This feature is disabled by default for performance."

#### **Phase 2: Simplify Templating Logic**

1.  **Refactor `Templater.ts`:**
    *   Remove the `resolveStaticVariables` method and all logic related to `{{title}}`.
    *   The main `resolve` method will now only contain the logic for `{{date}}`.
    *   The `resolve` method's signature will be simplified to `public static resolve(template: string): string`, as the `file` context is no longer needed.

#### **Phase 3: Modify Resolution Trigger**

1.  **Update `filterStateField` (in `main.ts`):**
    *   The state will no longer need to distinguish between `unresolvedRegexStrings` and `activeRegexStrings`. We will resolve the template *before* dispatching the effect to update the state.
2.  **Modify `toggleSpecificSavedRegex` and `promptForManualRegex` (in `main.ts`):**
    *   Before dispatching the `toggleSpecificRegexStringEffect` or `applyManualRegexStringEffect`, check if `settings.enableTemplateVariables` is `true`.
    *   If it is, call `Templater.resolve(regexString)` on the input string.
    *   The resulting *resolved* string will be passed into the state effect.
3.  **Remove Resolution from `buildDecorations`:**
    *   The call to `Templater.resolve` inside the `buildDecorations` method will be removed entirely. The filtering will now work directly with the pre-resolved strings stored in the state.

---

### **3. Revised Data Flow**

This diagram illustrates the new, more efficient data flow.

```mermaid
graph TD
    subgraph "Filter Activation (e.g., Hotkey Press)"
        A[User activates filter with "Task - {{date:dddd}}"] --> B{Check if setting is enabled};
        B -->|If Yes| C{Templater.resolve(regex)};
        C -->|Resolves {{date}}| D[Dispatch effect with "Task - Saturday"];
        B -->|If No| E[Dispatch effect with "Task - {{date:dddd}}"];
        D --> F[Update editor state];
        E --> F[Update editor state];
    end

    subgraph "Live Filtering (Typing, Scrolling)"
        G[Get resolved regex from state] --> H[new RegExp(resolvedRegex)];
        H --> I[Filter lines in the editor];
    end

    style C fill:#f9f,stroke:#333,stroke-width:2px
    style H fill:#bbf,stroke:#333,stroke-width:2px
```

This revised approach directly addresses the feedback, ensuring the feature is opt-in, scoped, and has minimal performance impact.
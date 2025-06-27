# Plan: Template Variable Support

This document outlines the plan to implement template variable support in regex filters, as requested in GitHub issue #2.

### **1. Research & Analysis**

*   **Current Implementation:** The plugin uses a CodeMirror `StateField` to manage an array of active regex strings. These are combined into a single `RegExp` object and used to decorate the editor, hiding non-matching lines. The key function is `buildCombinedRegex(regexStrings)`, which creates the final regex.
*   **Templating in Obsidian:** Plugins like *Templater* and the core *Daily Notes* plugin typically resolve templates at a specific point in time (e.g., on file creation or template insertion). This plugin's "live" filtering presents a challenge, as the template would need to be resolved repeatedly.
*   **Challenges:**
    *   **Resolution Timing:** Deciding when to substitute the template variables is the main issue. Doing it on every editor update could be a performance bottleneck.
    *   **Context:** To resolve variables like `{{title}}` or `{{file_path}}`, the resolver needs access to the current file's context.
    *   **Complexity:** Supporting formatted variables (e.g., `{{date:YYYY-MM-DD}}`) adds parsing complexity.

### **2. Proposed Solutions**

Here are three potential approaches:

*   **Solution A: Simple, Time-of-Use Substitution**
    *   **How it works:** A new function, let's call it `resolveTemplateVariables(regexString, file)`, would be called from within the `buildDecorations` method, just before the regex is tested against a line. This function would perform a simple string replacement for a predefined set of variables like `{{date}}` and `{{title}}`.
    *   **Pros:** Simple to implement, low performance overhead for a small number of variables.
    *   **Cons:** Not easily extensible to support more complex variables or formatting.

*   **Solution B: "Snapshot" Variables on Filter Activation**
    *   **How it works:** When a filter is activated, the template variables are resolved *once*. The resulting regex string is then used for filtering until the filter is deactivated and reactivated.
    *   **Pros:** Best performance, as the template is only resolved once.
    *   **Cons:** This behavior could be confusing. A filter with `{{date}}` would not update to the new date until it's toggled off and on again.

*   **Solution C: A Hybrid Approach (Recommended)**
    *   **How it works:** This approach combines the performance of snapshotting with the dynamic nature of time-of-use substitution.
        1.  When a filter is activated, we "pre-compile" the regex string, resolving static variables like `{{title}}` or `{{file_path}}` that are unlikely to change during the session.
        2.  We identify any "dynamic" variables like `{{date}}` or `{{time}}` and replace them with a unique placeholder.
        3.  In the `buildDecorations` method, before testing a line, we do a final, very fast replacement of the dynamic placeholders.
    *   **Pros:** Good balance of performance and dynamic behavior. Extensible for new variables.
    *   **Cons:** More complex to implement than the other solutions.

### **3. Recommendation & Plan**

I recommend **Solution C: The Hybrid Approach**. It provides the best balance of features, performance, and user experience.

Here is a high-level plan for implementing this solution:

**Phase 1: Create a Templating Service**

1.  **Create `Templater.ts`:** A new file and class responsible for resolving template variables.
2.  **Implement `resolve(regex: string, file: TFile): string`:** This will be the main method. It will take a regex string and the current file, and return the resolved regex string.
3.  **Add Variable Support:**
    *   `{{title}}`: The name of the current file.
    *   `{{date}}`: The current date, with support for formats like `{{date:YYYY-MM-DD}}`.
    *   `{{time}}`: The current time, with support for formats.

**Phase 2: Integrate the Templating Service**

1.  **Modify `filterStateField`:** The state will need to be updated to store both the original regex string and the "snapshotted" version.
2.  **Update `buildCombinedRegex`:** This function will now take the array of resolved regex strings to build the final regex.
3.  **Modify `toggleSpecificSavedRegex` and `promptForManualRegex`:** When a filter is activated, these functions will use the new `Templater` service to resolve the variables and update the `filterStateField`.

**Phase 3: UI and Documentation**

1.  **Update Settings UI:** Add a description in the settings tab to inform users about the available template variables.
2.  **Update README.md:** Document the new feature and provide examples of how to use it.

Here is a Mermaid diagram illustrating the proposed data flow:

```mermaid
graph TD
    subgraph "Filter Activation"
        A[User activates filter with "{{title}} - {{date}}"] --> B{Templater.resolveInitial(regex, file)};
        B -->|Resolves {{title}}| C[Stores "My Note - {{date}}" in state];
    end

    subgraph "Editor Update (buildDecorations)"
        D[Get "My Note - {{date}}" from state] --> E{Templater.resolveDynamic(storedRegex)};
        E -->|Resolves {{date}}| F[Returns "My Note - 2023-10-27"];
        F --> G[new RegExp("My Note - 2023-10-27")];
        G --> H[Filter lines];
    end

    style B fill:#f9f,stroke:#333,stroke-width:2px
    style E fill:#f9f,stroke:#333,stroke-width:2px
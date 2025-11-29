# Development Guide for Regex Line Filter Plugin

## Overview

This document provides instructions for developing and testing the Obsidian Regex Line Filter plugin.

## Project Structure

```
├── main.ts                 # Main plugin code
├── Templater.ts            # Template variable handling
├── styles.css              # Plugin styles
├── manifest.json           # Plugin manifest
├── package.json            # Dependencies and scripts
├── jest.config.js          # Jest testing configuration
├── jest.setup.js           # Jest global setup
├── tsconfig.json           # TypeScript configuration
├── esbuild.config.mjs      # Build configuration
├── __tests__/              # Test files
│   ├── settings.test.ts
│   ├── state.test.ts
│   ├── copy.test.ts
│   ├── commands.test.ts
│   ├── decorations.test.ts
│   ├── settings-tab.test.ts
│   ├── modals.test.ts
│   └── persistence.test.ts
├── __mocks__/              # Mock implementations
│   ├── obsidian.ts
│   └── @codemirror/
│       ├── state.ts
│       └── view.ts
└── build_notes/            # Development notes
```

## Development Setup

### Prerequisites

- Node.js 16+
- pnpm

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```

### Building the Plugin

To compile the TypeScript code and bundle for production:

```bash
pnpm run build
```

This will:
1. Run TypeScript type checking
2. Bundle the code using esbuild
3. Output `main.js` and `styles.css`

### Development Build

For development with live reloading:

```bash
pnpm dev
```


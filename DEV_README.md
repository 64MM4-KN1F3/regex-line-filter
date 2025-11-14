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
- npm

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Building the Plugin

To compile the TypeScript code and bundle for production:

```bash
npm run build
```

This will:
1. Run TypeScript type checking
2. Bundle the code using esbuild
3. Output `main.js` and `styles.css`

### Development Build

For development with live reloading:

```bash
npm run dev
```

## Testing

### Test Framework

The project uses Jest with TypeScript support and jsdom for DOM simulation.

### Running Tests

#### Run all tests once:
```bash
npm test
```

#### Run tests in watch mode (re-runs on file changes):
```bash
npm run test:watch
```

#### Run tests with coverage report:
```bash
npm run test:coverage
```

### Test Structure

Tests are organized by functionality:

- **`settings.test.ts`**: Tests for plugin settings and defaults
- **`state.test.ts`**: Tests for CodeMirror state management and effects
- **`copy.test.ts`**: Tests for the copy-only-filtered-text functionality
- **`commands.test.ts`**: Tests for plugin commands
- **`decorations.test.ts`**: Tests for line decorations and filtering
- **`settings-tab.test.ts`**: Tests for settings UI
- **`modals.test.ts`**: Tests for input modals
- **`persistence.test.ts`**: Tests for data persistence

### Writing Tests

#### Test Setup

Tests use mocked versions of Obsidian and CodeMirror APIs. Global mocks are set up in `jest.setup.js`, and module-specific mocks are in `__mocks__/`.

#### Example Test Structure

```typescript
import { someFunction } from '../main';

describe('Function Name', () => {
  describe('specific behavior', () => {
    it('should do something', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = someFunction(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Test Coverage

The test suite covers:

- ✅ Settings management and defaults
- ✅ CodeMirror state effects and updates
- ✅ Copy functionality with filtering
- ✅ Command execution
- ✅ UI component rendering
- ✅ Modal interactions
- ✅ Data persistence per file
- ✅ Regex validation and processing

### Running Tests in CI

Tests are automatically run in GitHub Actions on pull requests and pushes to main branch.

## Key Features Tested

### Copy-Only-Filtered-Text Functionality

The most recently added feature includes comprehensive tests for:

- Copying only visible lines when `copyOnlyFilteredText` is enabled
- Falling back to default copy behavior when disabled
- Proper handling when no filters are active

### State Management

Tests verify that CodeMirror state effects properly update:
- Active regex filters
- Settings (hide empty lines, include children, etc.)
- Copy-only-filtered-text setting

### Persistence

Tests ensure settings and per-file filter states are properly saved and loaded.

## Debugging Tests

### Common Issues

1. **Module Import Errors**: Ensure mocks are properly set up in `__mocks__/` directory
2. **Type Errors**: Check TypeScript types in test files and mocks
3. **DOM Errors**: Verify jsdom setup in `jest.setup.js`

### Debugging Tips

- Use `console.log` in test files (Jest captures output)
- Run single test files: `npm test settings.test.ts`
- Use `--verbose` flag for detailed output
- Check coverage reports in `coverage/` directory

## Contributing

1. Write tests for new features before implementing
2. Ensure all tests pass before submitting PR
3. Maintain test coverage above 80%
4. Follow existing test patterns and naming conventions

## Plugin Development in Obsidian

### Key Concepts

- **CodeMirror 6**: The editor uses CodeMirror 6 for text editing
- **State Effects**: Changes are made through state effects, not direct DOM manipulation
- **View Plugins**: UI components are implemented as CodeMirror ViewPlugins
- **Settings**: Persistent settings use Obsidian's data API

### Architecture

- `main.ts`: Main plugin class and initialization
- State management through CodeMirror's `StateField`
- UI through `ViewPlugin` for decorations and event handling
- Settings through `PluginSettingTab`

This testing setup ensures the plugin's functionality is thoroughly validated and provides a solid foundation for future development.
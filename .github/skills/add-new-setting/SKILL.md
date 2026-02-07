---
name: add-new-setting
description: "Step-by-step guide for adding a new configuration setting to Ollama Copilot. Use when asked to add, create, or register a new extension setting, preference, or configuration option."
---

# Adding a New Extension Setting

Follow these steps to add a new setting. Settings touch **5+ files** due to the mapping between VS Code configuration (dot-separated keys) and the webview (camelCase keys).

## Step 1: Define the Setting Schema

Add the setting to `package.json` under `contributes.configuration.properties`:

```json
"ollamaCopilot.mySection.mySetting": {
  "type": "string",
  "default": "defaultValue",
  "description": "What this setting controls"
}
```

**Naming conventions:**
- Use dot-separated sections: `ollamaCopilot.<section>.<setting>`
- Sections map to mode groups: `completionMode`, `askMode`, `editMode`, `planMode`, `agentMode`, `agent`
- Top-level settings (e.g., `baseUrl`, `enableAutoComplete`) have no section

## Step 2: Add to TypeScript Config Types

In `src/types/config.ts`, add the field to the appropriate interface:

```typescript
// For mode-specific settings → ModeConfig
export interface ModeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  mySetting?: string; // ← if mode-specific
}

// For agent settings → AgentConfig
export interface AgentConfig {
  maxIterations: number;
  // ...
  mySetting?: string; // ← if agent-specific
}

// For top-level settings → ExtensionConfig
export interface ExtensionConfig {
  baseUrl: string;
  // ...
  mySetting?: string; // ← if global
}
```

## Step 3: Read the Setting

In `src/config/settings.ts`, add the `config.get()` call to `getConfig()`:

```typescript
export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');
  return {
    // ...existing fields...
    mySetting: config.get('mySection.mySetting', 'defaultValue'),
  };
}
```

**Important**: `getConfig()` returns a **snapshot** (reads all settings on every call). It is NOT reactive.

## Step 4: Add to Settings Payload (Backend → Webview)

In `src/views/settingsHandler.ts`, add the field to `getSettingsPayload()`:

```typescript
getSettingsPayload() {
  const config = getConfig();
  return {
    // ...existing fields...
    mySetting: config.mySection?.mySetting ?? 'defaultValue',
  };
}
```

**Key naming rule**: The webview payload uses **camelCase** keys, while VS Code config uses **dot-separated** keys. This mapping is manual.

## Step 5: Add to Settings Save (Webview → Backend)

In `src/views/settingsHandler.ts`, add the save logic to `saveSettings()`:

```typescript
async saveSettings(settings: any) {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');
  // ...existing saves...

  if (settings.mySetting !== undefined) {
    await config.update('mySection.mySetting', settings.mySetting, vscode.ConfigurationTarget.Global);
  }
}
```

**Scope rule**: Almost all settings use `ConfigurationTarget.Global`. Only `baseUrl` respects workspace scope (uses `config.inspect()` to detect). Follow the `Global` pattern unless you have a specific reason for workspace scope.

## Step 6: Add to Webview Settings UI

Add the setting to the appropriate section component in `src/webview/components/settings/components/`:

| Setting Type | Component |
|-------------|-----------|
| Connection/URL | `ConnectionSection.vue` |
| Agent behavior | `AgentSection.vue` |
| Autocomplete | `AutocompleteSection.vue` |
| Chat modes | `ChatSection.vue` |
| Model selection | `ModelsSection.vue` |
| Tool toggles | `ToolsSection.vue` |

The settings component reads from `settings` reactive ref (in `src/webview/scripts/core/state.ts`) and sends `saveSettings` messages back:

```typescript
// Reading
const value = settings.value?.mySetting ?? 'defaultValue';

// Saving
vscode.postMessage({ type: 'saveSettings', settings: { mySetting: newValue } });
```

## Step 7: Add to Webview State (if needed)

If the setting needs to be tracked reactively in the webview beyond the settings page, add it to `src/webview/scripts/core/state.ts`:

```typescript
export const mySetting = ref<string>('defaultValue');
```

And update it in the relevant message handler in `src/webview/scripts/core/messageHandlers/`.

## Naming Mapping Reference

| VS Code Config Key | Webview Payload Key | TypeScript Type Location |
|--------------------|--------------------|--------------------------|
| `ollamaCopilot.baseUrl` | `baseUrl` | `ExtensionConfig.baseUrl` |
| `ollamaCopilot.agentMode.model` | `agentModel` | `ExtensionConfig.agentMode.model` |
| `ollamaCopilot.agent.maxIterations` | `maxIterations` | `AgentConfig.maxIterations` |
| `ollamaCopilot.agent.toolTimeout` | `toolTimeout` | `AgentConfig.toolTimeout` |
| `ollamaCopilot.agent.sensitiveFilePatterns` | `sensitiveFilePatterns` (JSON string) | `AgentConfig.sensitiveFilePatterns` |

## Checklist

- [ ] Setting schema in `package.json` with type, default, and description
- [ ] TypeScript type in `src/types/config.ts`
- [ ] Reader in `src/config/settings.ts` → `getConfig()`
- [ ] Payload mapping in `src/views/settingsHandler.ts` → `getSettingsPayload()`
- [ ] Save mapping in `src/views/settingsHandler.ts` → `saveSettings()`
- [ ] UI component in `src/webview/components/settings/components/`
- [ ] State ref in `src/webview/scripts/core/state.ts` (if needed outside settings page)
- [ ] Instructions updated if the setting introduces new conventions

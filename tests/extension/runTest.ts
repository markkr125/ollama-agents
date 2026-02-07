import { runTests } from '@vscode/test-electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { startOllamaMockServer } from './mocks/ollamaMockServer';

async function main() {
  process.env.OLLAMA_COPILOT_TEST = '1';
  const server = await startOllamaMockServer({ type: 'chatEcho' });
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    const userDataDir = path.resolve(extensionDevelopmentPath, '.vscode-test-user-data');
    const userSettingsDir = path.resolve(userDataDir, 'User');
    const userSettingsPath = path.resolve(userSettingsDir, 'settings.json');

    await fs.mkdir(userSettingsDir, { recursive: true });
    await fs.writeFile(
      userSettingsPath,
      JSON.stringify(
        {
          'ollamaCopilot.baseUrl': server.baseUrl,
          'ollamaCopilot.enableAutoComplete': false
        },
        null,
        2
      ),
      'utf8'
    );

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-extensions',
        '--user-data-dir', userDataDir,
        '--extensions-dir', path.resolve(extensionDevelopmentPath, '.vscode-test-extensions')
      ]
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

void main();

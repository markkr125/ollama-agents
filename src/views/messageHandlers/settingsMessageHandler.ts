import { IMessageHandler } from '../chatTypes';
import { SettingsHandler } from '../settingsHandler';

/**
 * Handles settings-related webview messages.
 * Delegates to SettingsHandler for all operations.
 */
export class SettingsMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'saveSettings', 'testConnection', 'saveBearerToken', 'runDbMaintenance', 'recreateMessagesTable'
  ] as const;

  constructor(
    private readonly settingsHandler: SettingsHandler
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'saveSettings':
        await this.settingsHandler.saveSettings(data.settings);
        break;
      case 'testConnection':
        await this.settingsHandler.testConnection(data.baseUrl);
        break;
      case 'saveBearerToken':
        await this.settingsHandler.saveBearerToken(data.token, data.testAfterSave, data.baseUrl);
        break;
      case 'runDbMaintenance':
        await this.settingsHandler.runDbMaintenance();
        break;
      case 'recreateMessagesTable':
        await this.settingsHandler.recreateMessagesTable();
        break;
    }
  }
}

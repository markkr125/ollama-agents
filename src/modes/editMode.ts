import * as vscode from 'vscode';
import { getModeConfig } from '../config/settings';
import { EditManager } from '../services/editManager';
import { OllamaClient } from '../services/ollamaClient';

export async function registerEditMode(
  context: vscode.ExtensionContext,
  client: OllamaClient
): Promise<void> {
  const editManager = new EditManager(client);

  const command = vscode.commands.registerCommand(
    'ollamaCopilot.editWithInstructions',
    async () => {
      const editor = vscode.window.activeTextEditor;
      
      if (!editor) {
        vscode.window.showWarningMessage('No active editor found');
        return;
      }

      const config = getModeConfig('edit');
      if (!config.model) {
        vscode.window.showWarningMessage(
          'No model configured for Edit mode. Please configure ollamaCopilot.editMode.model in settings.',
          'Open Settings'
        ).then(choice => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaCopilot.editMode');
          }
        });
        return;
      }

      // Get selection or full document
      const document = editor.document;
      const selection = editor.selection;
      const isSelection = !selection.isEmpty;
      const range = isSelection 
        ? selection 
        : new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
      const originalCode = document.getText(range);

      if (!originalCode.trim()) {
        vscode.window.showWarningMessage('No code to edit');
        return;
      }

      // Prompt for instructions
      const instructions = await vscode.window.showInputBox({
        prompt: 'Describe the changes you want to make',
        placeHolder: 'e.g., Convert to async/await, Add error handling, Extract into function, Fix bugs',
        ignoreFocusOut: true
      });

      if (!instructions) {
        return;
      }

      // Show progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Ollama Copilot',
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Generating edits...' });

          try {
            // Generate modified code
            const modifiedCode = await editManager.generateEdit(
              originalCode,
              instructions,
              document.languageId,
              config.model,
              config.temperature,
              config.maxTokens
            );

            if (!modifiedCode || modifiedCode === originalCode) {
              vscode.window.showWarningMessage('No changes generated');
              return;
            }

            progress.report({ message: 'Showing preview...' });

            // Show diff preview
            await editManager.showDiff(
              document.uri,
              originalCode,
              modifiedCode,
              `Edit: ${instructions}`
            );

            // Ask for confirmation
            const choice = await vscode.window.showWarningMessage(
              'Apply these changes?',
              { modal: true },
              'Apply',
              'Cancel',
              'Modify Instructions'
            );

            if (choice === 'Apply') {
              const success = await editManager.applyEdit(document, modifiedCode, range);
              if (success) {
                vscode.window.showInformationMessage('✅ Changes applied successfully');
              } else {
                vscode.window.showErrorMessage('Failed to apply changes');
              }
            } else if (choice === 'Modify Instructions') {
              // Re-run the command to get new instructions
              vscode.commands.executeCommand('ollamaCopilot.editWithInstructions');
            }

          } catch (error: any) {
            vscode.window.showErrorMessage(`Edit failed: ${error.message}`);
          }
        }
      );
    }
  );

  context.subscriptions.push(command);
}

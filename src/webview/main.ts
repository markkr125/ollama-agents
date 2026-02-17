import '@vscode/codicons/dist/codicon.css';
import { createApp } from 'vue';
import App from './App.vue';
import './styles/styles.scss';

const app = createApp(App);

// Surface Vue render errors visibly — without this, Vue silently replaces
// crashed components with empty content and only logs to console.error,
// which is invisible in a VS Code webview unless you open Developer Tools.
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue Error]', info, err);

  // Show a persistent red error overlay so the user actually sees something
  const overlay = document.createElement('div');
  overlay.className = 'vue-error-overlay';
  overlay.innerHTML = `
    <div class="vue-error-title">⚠ Render Error</div>
    <pre class="vue-error-detail">${String(err)}</pre>
    <div class="vue-error-hint">Open <b>Developer Tools</b> (Help → Toggle Developer Tools) for the full stack trace.</div>
  `;
  document.getElementById('app')?.appendChild(overlay);
};

app.mount('#app');

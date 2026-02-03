import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import type { StatusMessage } from '../types';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true
}).use(taskLists, { enabled: true, label: true, labelAfter: true });

const renderCodeBlock = (code: string, language: string) => {
  const normalizedLang = (language || '').trim() || 'text';
  const safeLang = markdown.utils.escapeHtml(normalizedLang);
  const safeCode = markdown.utils.escapeHtml(code);
  const languageClass = safeLang ? `language-${safeLang}` : '';

  return `
    <div class="code-block" data-lang="${safeLang}">
      <div class="code-header">
        <span class="code-lang">${safeLang}</span>
        <button class="code-copy-btn" data-copy-label="Copy" data-copied-label="Copied">Copy</button>
      </div>
      <pre><code class="${languageClass}">${safeCode}</code></pre>
    </div>
  `;
};

markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const language = info ? info.split(/\s+/)[0] : '';
  return renderCodeBlock(token.content, language);
};

markdown.renderer.rules.code_block = (tokens, idx) => {
  const token = tokens[idx];
  return renderCodeBlock(token.content, 'text');
};

export const statusClass = (status: StatusMessage) => {
  return {
    visible: status.visible,
    success: status.success,
    error: !status.success
  };
};

export const formatMarkdown = (text: string) => {
  if (!text) return '';
  return markdown.render(text);
};

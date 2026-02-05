import { createTwoFilesPatch } from 'diff';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const diff2html = require('diff2html');

export const renderDiffHtml = (
  filePath: string,
  originalContent: string,
  newContent: string
): string => {
  const safePath = filePath.replace(/[\r\n]/g, '');
  const diffText = createTwoFilesPatch(
    safePath,
    safePath,
    originalContent ?? '',
    newContent ?? '',
    '',
    '',
    { context: 3 }
  );

  return diff2html.html(diffText, {
    inputFormat: 'diff',
    drawFileList: false,
    matching: 'lines',
    outputFormat: 'line-by-line'
  });
};

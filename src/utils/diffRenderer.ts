import { createTwoFilesPatch } from 'diff';
import { Diff2Html } from 'diff2html';

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

  return Diff2Html.getPrettyHtml(diffText, {
    inputFormat: 'diff',
    showFiles: false,
    matching: 'lines',
    outputFormat: 'line-by-line'
  });
};

declare module 'diff2html' {
  export const Diff2Html: {
    getPrettyHtml: (diffText: string, options?: Record<string, any>) => string;
  };
}
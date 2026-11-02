import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { php } from '@codemirror/lang-php';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

export type EditorLanguage = 'javascript' | 'typescript' | 'html' | 'css' | 'php' | 'json' | 'text';

/** Language for a file name (file manager). */
export function languageFor(name: string): EditorLanguage {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'javascript';
  if (['ts', 'tsx', 'mts'].includes(ext)) return 'typescript';
  if (['html', 'htm', 'vue', 'svelte', 'svg', 'xml'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['php', 'phtml'].includes(ext)) return 'php';
  if (['json', 'webmanifest'].includes(ext)) return 'json';
  return 'text';
}

const languageExtension = (lang: EditorLanguage) =>
  ({
    javascript: [javascript({ jsx: true })],
    typescript: [javascript({ typescript: true, jsx: true })],
    html: [html()],
    css: [css()],
    php: [php()],
    json: [json()],
    text: [],
  })[lang];

/** Code editor (CodeMirror 6), loaded on demand (Workers and the file manager). */
export default function CodeEditor({
  value,
  onChange,
  onSave,
  readOnly,
  className,
  language = 'javascript',
}: {
  value: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  className?: string;
  language?: EditorLanguage;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const editable = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          languageExtension(language),
          oneDark,
          keymap.of([
            indentWithTab,
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave?.();
                return true;
              },
            },
          ]),
          editable.current.of(EditorState.readOnly.of(!!readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace" },
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once; later value changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (loading a version, resetting) replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(!!readOnly)) });
  }, [readOnly]);

  return <div ref={host} className={className} />;
}

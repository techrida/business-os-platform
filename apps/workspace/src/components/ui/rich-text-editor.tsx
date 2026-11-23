'use client';

import { richTextToHtml, richTextToPlain, sanitizeRichText } from '@bos/contracts';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { Icon, type IconName } from './icon';
import richStyles from './rich-text.module.css';
import styles from './rich-text-editor.module.css';
import { Tooltip } from '@/components/ui/tooltip';

/** What the editor opens: rich text as it is, legacy plain text as escaped paragraphs. */
export function toEditorHtml(value: string | null | undefined): string {
  return richTextToHtml(value);
}

/**
 * What the editor reports: the editor's HTML rebuilt from the allow-list, and '' for a document
 * without words (an empty editor is an empty string, never '<p></p>' or an empty list).
 */
export function toStoredValue(html: string): string {
  const clean = sanitizeRichText(html);
  return richTextToPlain(clean).trim() === '' ? '' : clean;
}

/** The length the limit applies to: the words, not the markup. */
export function countRichTextChars(value: string | null | undefined): number {
  return richTextToPlain(value).length;
}

// Only paragraphs, lists, bold, italic and soft line breaks: the subset the contract stores (D31).
// Everything else the kit ships is off, so a paste or a shortcut cannot create it.
const EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    link: false,
    strike: false,
    trailingNode: false,
    underline: false,
  }),
];

const DEFAULT_MIN_HEIGHT = 'calc(8 * var(--line-height-body-small) + 20px)';

interface Action {
  key: 'bold' | 'italic' | 'bulletList' | 'orderedList';
  icon: IconName;
  label: string;
  shortcut: string;
  run: (editor: Editor) => void;
}

const ACTIONS: readonly Action[] = [
  {
    key: 'bold',
    icon: 'bold',
    label: 'Bold',
    shortcut: 'Ctrl+B',
    run: (editor) => void editor.chain().focus().toggleBold().run(),
  },
  {
    key: 'italic',
    icon: 'italic',
    label: 'Italic',
    shortcut: 'Ctrl+I',
    run: (editor) => void editor.chain().focus().toggleItalic().run(),
  },
  {
    key: 'bulletList',
    icon: 'list',
    label: 'Bulleted list',
    shortcut: 'Ctrl+Shift+8',
    run: (editor) => void editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'orderedList',
    icon: 'list-ordered',
    label: 'Numbered list',
    shortcut: 'Ctrl+Shift+7',
    run: (editor) => void editor.chain().focus().toggleOrderedList().run(),
  },
];

/**
 * Rich text field for wording such as terms (D31): paragraphs, bulleted and numbered lists, bold
 * and italic. `value` and `onChange` carry the stored form (sanitised HTML; '' when empty). A
 * `value` that is legacy plain text opens as paragraphs and is stored as HTML after the first
 * edit. The limit counts words (`richTextToPlain`), shows as "n / max" and turns to the error
 * colour with `aria-invalid` when passed; typing is not blocked, so pasted text is never cut.
 *
 *   <Field label="Terms">
 *     {(c) => <RichTextEditor {...c} name="terms" value={terms} onChange={setTerms} maxChars={2000} />}
 *   </Field>
 *
 * With `name` it also writes a hidden input, so a plain form post carries the value. Pass
 * `aria-labelledby` (Field does) or `label` to name the text box.
 */
export function RichTextEditor({
  id,
  name,
  value,
  onChange,
  maxChars,
  label,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  invalid,
  disabled,
  placeholder,
  minHeight,
}: {
  id?: string | undefined;
  name?: string | undefined;
  value: string;
  onChange: (html: string) => void;
  maxChars: number;
  label?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  /** Height of the typing area before it grows; a number is pixels. Default: 8 lines. */
  minHeight?: string | number | undefined;
}) {
  const counterId = useId();
  const count = countRichTextChars(value);
  const over = count > maxChars;
  const isInvalid = Boolean(invalid) || over;
  const describedBy = [ariaDescribedby, counterId].filter(Boolean).join(' ');

  // The newest callback and the last value this editor reported, read by the editor's own events
  // and by the re-sync below without making them dependencies.
  const onChangeRef = useRef(onChange);
  const lastEmitted = useRef(value);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const attributes = useMemo(() => {
    const attrs: Record<string, string> = {
      class: [richStyles.prose, styles.content].filter(Boolean).join(' '),
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-describedby': describedBy,
    };
    if (id) attrs.id = id;
    if (ariaLabelledby) attrs['aria-labelledby'] = ariaLabelledby;
    else attrs['aria-label'] = label ?? 'Text';
    if (placeholder) attrs['aria-placeholder'] = placeholder;
    if (isInvalid) attrs['aria-invalid'] = 'true';
    if (disabled) attrs['aria-disabled'] = 'true';
    return attrs;
  }, [id, ariaLabelledby, label, placeholder, isInvalid, disabled, describedBy]);

  const editor = useEditor({
    // Next renders this on the server first; the editor only exists in the browser.
    immediatelyRender: false,
    extensions: EXTENSIONS,
    content: toEditorHtml(value),
    editable: !disabled,
    editorProps: { attributes },
    onUpdate: ({ editor: current }) => {
      const next = toStoredValue(current.getHTML());
      if (next === lastEmitted.current) return;
      lastEmitted.current = next;
      onChangeRef.current(next);
    },
  });

  // Attributes and editability follow the props; the editor's own events are not re-emitted.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({ editorProps: { attributes } });
  }, [editor, attributes]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  // A value that did not come from typing here (a preset was picked, the form was reset) replaces
  // the document. A value the editor just reported, or one that reads the same, is left alone, so
  // there is no feedback loop and the caret stays put.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmitted.current) return;
    const html = toEditorHtml(value);
    lastEmitted.current = value;
    if (toStoredValue(html) === toStoredValue(editor.getHTML())) return;
    editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, value]);

  const liveState = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      bulletList: current?.isActive('bulletList') ?? false,
      orderedList: current?.isActive('orderedList') ?? false,
      empty: current?.isEmpty ?? true,
    }),
  });

  const state = liveState ?? {
    bold: false,
    italic: false,
    bulletList: false,
    orderedList: false,
    empty: true,
  };

  // One tab stop for the whole toolbar; the arrow keys move between its buttons.
  const [stop, setStop] = useState(0);
  const toolbarKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = ACTIONS.length - 1;
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = stop === last ? 0 : stop + 1;
    else if (event.key === 'ArrowLeft') next = stop === 0 ? last : stop - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === undefined) return;
    event.preventDefault();
    setStop(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  const toolsOff = !editor || Boolean(disabled);
  const minHeightValue = typeof minHeight === 'number' ? `${minHeight}px` : minHeight;
  const scrollStyle = { '--rte-min-height': minHeightValue ?? DEFAULT_MIN_HEIGHT } as CSSProperties;

  return (
    <div className={styles.wrap}>
      <div
        className={styles.root}
        data-invalid={isInvalid ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
      >
        <div
          role="toolbar"
          aria-label="Text formatting"
          aria-controls={id}
          className={styles.toolbar}
          onKeyDown={toolbarKeys}
        >
          {ACTIONS.map((action, index) => (
            <Fragment key={action.key}>
              {index === 2 ? (
                <span className={styles.sep} role="separator" aria-orientation="vertical" />
              ) : null}
              <Tooltip content={`${action.label} (${action.shortcut})`}>
                <button
                  type="button"
                  className={styles.tool}
                  aria-label={action.label}
                  aria-pressed={state[action.key]}
                  disabled={toolsOff}
                  tabIndex={index === stop ? 0 : -1}
                  // Keep the caret in the text while a toolbar button is pressed with the mouse.
                  onMouseDown={(event) => event.preventDefault()}
                  onFocus={() => setStop(index)}
                  onClick={() => editor && action.run(editor)}
                >
                  <Icon name={action.icon} size={16} />
                </button>
              </Tooltip>
            </Fragment>
          ))}
        </div>
        <div className={styles.scroll} style={scrollStyle}>
          {placeholder && state.empty ? (
            <div className={styles.placeholder} aria-hidden="true">
              {placeholder}
            </div>
          ) : null}
          <EditorContent editor={editor} />
        </div>
      </div>
      <div className={styles.footer}>
        <span id={counterId} className={styles.counter} data-over={over ? '' : undefined}>
          {count} / {maxChars}
          {over ? <span className="sr-only"> characters, over the limit</span> : null}
        </span>
      </div>
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
    </div>
  );
}

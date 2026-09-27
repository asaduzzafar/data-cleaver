import { useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers,
  placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { api } from "../api";
import type { Column, Relation } from "../types";

/**
 * The SQL editor: CodeMirror 6, completing relation and column names from
 * the live catalog.
 *
 * Tab indents, so it must not become a keyboard trap: Esc, then Tab, moves
 * focus on (CodeMirror's tab-focus mode), and the hint under the editor says
 * so. Ctrl+Enter runs.
 */

// Code-led, on the working paper: ink for names, ref blue for keywords,
// pencil for comments. Each clears 4.5:1 on the sheet.
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--color-ref)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-go)" },
  { tag: [t.number, t.bool, t.null], color: "var(--color-trace-strong)" },
  { tag: t.comment, color: "var(--color-muted)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation], color: "var(--color-ink-2)" },
  { tag: t.invalid, color: "var(--color-stop)" },
]);

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-panel)", color: "var(--color-ink)",
    border: "1px solid var(--color-edge)", borderRadius: "2px",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "2px solid var(--color-ref)", outlineOffset: "1px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { padding: "6px 0", minHeight: "7.5em", caretColor: "var(--color-ink)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-casing)", color: "var(--color-muted)",
    borderRight: "1px solid var(--color-line)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-well) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-well)", color: "var(--color-ink-2)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-ref-wash)",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--color-well)", outline: "1px solid var(--color-edge)" },
  ".cm-placeholder": { color: "var(--color-muted)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-panel)", border: "1px solid var(--color-edge)",
    borderRadius: "2px",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "13px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-ink)", color: "var(--color-panel)",
  },
  ".cm-completionDetail": { color: "inherit", opacity: "0.8", fontStyle: "normal" },
});

/** Relation name -> column names, for completion. Relations whose schema
 *  has not arrived yet complete by name only. */
function useCatalogSchema(relations: Relation[]) {
  const schemas = useQueries({
    queries: relations.map((r) => ({
      queryKey: ["schema", r.name],
      queryFn: () => api.get<{ columns: Column[] }>(
        `/relations/${encodeURIComponent(r.name)}/schema`),
      staleTime: 60_000,
    })),
  });
  const namespace: Record<string, string[]> = {};
  relations.forEach((r, i) => {
    namespace[r.name] = (schemas[i]?.data?.columns ?? []).map((c) => c.name);
  });
  return namespace;
}

export function SqlEditor({ value, onChange, onRun, relations, defaultTable,
  labelledBy, describedBy }: {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  relations: Relation[];
  /** Columns of this relation complete without a prefix. */
  defaultTable: string;
  labelledBy: string;
  describedBy?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Latest callbacks, read by extensions created once.
  const latest = useRef({ onChange, onRun });
  latest.current = { onChange, onRun };
  const namespace = useCatalogSchema(relations);
  const schemaKey = JSON.stringify(namespace);

  const languageFor = () => sql({
    // No DuckDB dialect ships; PostgreSQL is its nearest: double-quoted
    // identifiers, :: casts, the same core keywords.
    dialect: PostgreSQL, schema: namespace, defaultTable, upperCaseKeywords: true,
  });

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(),
          bracketMatching(), closeBrackets(), autocompletion(),
          language.current.of(languageFor()),
          syntaxHighlighting(highlight), theme,
          placeholder("SELECT … FROM a relation in the index"),
          Prec.highest(keymap.of([{
            key: "Mod-Enter", preventDefault: true,
            run: () => { latest.current.onRun(); return true; },
          }])),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
                     ...completionKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-labelledby": labelledBy,
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            "aria-multiline": "true",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // Created once; value and schema flow in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New columns arrive as schemas load or relations change.
  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(languageFor()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, defaultTable]);

  // A value set from outside (not typed here) replaces the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} />;
}

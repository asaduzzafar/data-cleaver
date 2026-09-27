import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter,
  useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, horizontalListSortingStrategy,
  sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../ui";
import { typeFamily, type Column } from "../types";

/**
 * Choosing columns by moving them: a field list on the left, zones on the
 * right that hold pills in order. Used by Slice (one zone: the columns to
 * show) and Pivot (Rows, Columns, Values).
 *
 * Every drag has a keyboard path that does not depend on drag physics:
 * Enter on a field adds it to the first zone; each field has a checkbox for
 * the first zone when `checks` is set (the default with one zone), and every
 * other zone has an Add chooser; a focused pill
 * moves with Alt+Left/Right and leaves with Delete. dnd-kit's own keyboard
 * dragging (Space to lift) works on top, announced in plain words.
 */

type Zone = {
  id: string;
  label: string;
  hint?: string;
  /** How many fields the zone holds; 1 makes it a single slot. */
  max?: number;
  items: string[];
  onChange: (items: string[]) => void;
  /** Extra controls shown in the zone's header, e.g. an aggregate. */
  extra?: ReactNode;
};

const FIELD = "field:";
const pillId = (zone: string, name: string) => `${zone}::${name}`;
function parse(id: string | number) {
  const s = String(id);
  if (s.startsWith(FIELD)) return { kind: "field" as const, name: s.slice(FIELD.length) };
  if (s.startsWith("zone:")) return { kind: "zone" as const, zone: s.slice(5) };
  if (s === "fields") return { kind: "fields" as const };
  const [zone, ...rest] = s.split("::");
  return { kind: "pill" as const, zone, name: rest.join("::") };
}

/** A column's kind, as the owner asked for it: ABC text, 123 numbers,
 *  # dates. The exact SQL type rides in the title. */
const KIND = { number: "123", temporal: "#", text: "ABC", boolean: "Y/N", other: "?" } as const;

function FamilyMark({ type }: { type: string }) {
  return (
    <span aria-hidden="true" title={type}
          className="inline-flex h-[18px] min-w-8 shrink-0 items-center justify-center rounded
                     border border-line px-1 text-[10px] leading-none font-semibold tracking-wide
                     text-muted">
      {KIND[typeFamily(type)]}
    </span>
  );
}

export function FieldWell({ columns, zones, label, checks = zones.length === 1 }: {
  columns: Column[]; zones: Zone[]; label: string;
  /** Checkboxes in the field list that add to or remove from the first zone. */
  checks?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const help = useId();
  const typeOf = useMemo(() => Object.fromEntries(columns.map((c) => [c.name, c.type])),
                         [columns]);
  const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const place = (zone: Zone, name: string, at = zone.items.length) => {
    if (zone.items.includes(name)) return;
    const next = [...zone.items];
    next.splice(Math.min(at, next.length), 0, name);
    zone.onChange(zone.max ? next.slice(-zone.max) : next);
  };
  const removeFrom = (zone: Zone, name: string) =>
    zone.onChange(zone.items.filter((n) => n !== name));

  const onEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const from = parse(active.id);
    if (!over) return;
    const to = parse(over.id);
    const name = from.kind === "pill" || from.kind === "field" ? from.name : null;
    if (!name) return;
    if (to.kind === "fields") {                 // dragged back: remove
      if (from.kind === "pill") removeFrom(byId[from.zone], name);
      return;
    }
    const target = to.kind === "pill" ? byId[to.zone] : to.kind === "zone" ? byId[to.zone] : null;
    if (!target) return;
    const at = to.kind === "pill" ? target.items.indexOf(to.name) : target.items.length;
    if (from.kind === "pill" && from.zone === target.id) {
      const i = target.items.indexOf(name);
      if (i !== at && at >= 0) target.onChange(arrayMove(target.items, i, at));
      return;
    }
    if (from.kind === "pill") removeFrom(byId[from.zone], name);
    place(target, name, at);
  };

  const words = (id: string | number) => {
    const p = parse(id);
    return p.kind === "pill" || p.kind === "field" ? p.name : "";
  };
  const where = (id?: string | number) => {
    if (id === undefined) return "outside any zone";
    const p = parse(id);
    if (p.kind === "fields") return "the field list, which removes it";
    const z = p.kind === "pill" || p.kind === "zone" ? byId[p.zone] : null;
    if (!z) return "outside any zone";
    const pos = p.kind === "pill" ? z.items.indexOf(p.name) + 1 : z.items.length + 1;
    return `${z.label}, position ${pos}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${words(active.id)}.`,
    onDragOver: ({ active, over }) => `${words(active.id)} is over ${where(over?.id)}.`,
    onDragEnd: ({ active, over }) =>
      over ? `${words(active.id)} placed in ${where(over.id)}.`
           : `${words(active.id)} dropped outside; nothing changed.`,
    onDragCancel: ({ active }) => `Cancelled. ${words(active.id)} is back where it was.`,
  };

  const shown = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const first = checks ? zones[0] : null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragStart={({ active }: DragStartEvent) => setDragging(words(active.id))}
                onDragEnd={onEnd} onDragCancel={() => setDragging(null)}
                accessibility={{ announcements, screenReaderInstructions: {
                  draggable: "To move a column, press Space, use the arrow keys, "
                    + "then Space to drop. Or press Enter to add it, Alt and the "
                    + "arrow keys to reorder, Delete to remove.",
                } }}>
      <p id={help} className="sr-only">
        Press Enter on a column to add it. On a chosen column, press Alt and
        the left or right arrow to move it, and Delete to remove it.
      </p>
      <div role="group" aria-label={label}
           className="grid gap-3 md:grid-cols-[15rem_minmax(0,1fr)]">
        <FieldList columns={shown} query={query} onQuery={setQuery}
                   onAdd={(name) => zones[0] && place(zones[0], name)}
                   used={new Set(zones.flatMap((z) => z.items))} describedBy={help}
                   onToggle={first ? (name, on) => (on ? place(first, name)
                                                       : removeFrom(first, name)) : undefined} />
        <div className="flex flex-col gap-2">
          {zones.map((z) => (
            <ZoneBox key={z.id} zone={z} columns={columns} typeOf={typeOf}
                     chooser={z !== first}
                     onAdd={(name) => place(z, name)} describedBy={help}
                     onRemove={(name) => removeFrom(z, name)} />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <Pill name={dragging} type={typeOf[dragging] ?? ""} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

function FieldList({ columns, query, onQuery, onAdd, used, describedBy, onToggle }: {
  columns: Column[]; query: string; onQuery: (q: string) => void;
  onAdd: (name: string) => void; used: Set<string>; describedBy: string;
  /** Present with one zone: each field gets a checkbox that adds or removes it. */
  onToggle?: (name: string, on: boolean) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "fields" });
  const search = useId();
  return (
    <div ref={setNodeRef}
         className={`flex flex-col overflow-hidden rounded-lg border ${isOver ? "border-stop bg-stop-wash" : "border-line"}`}>
      <label htmlFor={search} className="sr-only">Find a column</label>
      <input id={search} value={query} onChange={(e) => onQuery(e.target.value)}
             placeholder="Find a column…"
             className="h-8 border-b border-line bg-panel px-2.5 text-[13px] outline-none
                        placeholder:text-muted focus:border-ref" />
      <ul aria-label="Columns" className="max-h-52 overflow-auto py-1">
        {columns.map((c) => (
          <FieldItem key={c.name} column={c} used={used.has(c.name)}
                     onAdd={() => onAdd(c.name)} describedBy={describedBy}
                     onToggle={onToggle && ((on) => onToggle(c.name, on))} />
        ))}
        {columns.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-muted">No column matches.</li>
        )}
      </ul>
    </div>
  );
}

function FieldItem({ column, used, onAdd, describedBy, onToggle }: {
  column: Column; used: boolean; onAdd: () => void; describedBy: string;
  onToggle?: (on: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: FIELD + column.name });
  return (
    <li className="flex items-center hover:bg-well">
      {onToggle && (
        <input type="checkbox" checked={used} aria-label={`Show ${column.name}`}
               onChange={(e) => onToggle(e.target.checked)} className="ml-2.5" />
      )}
      <button ref={setNodeRef} type="button" {...attributes} {...listeners}
              aria-describedby={describedBy}
              onClick={onAdd}
              onKeyDown={(e) => {
                // Enter adds; Space is dnd-kit's lift.
                if (e.key === "Enter") { e.preventDefault(); onAdd(); return; }
                listeners?.onKeyDown?.(e);
              }}
              className={`flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2.5 py-1 text-left
                          text-[13px] ${isDragging ? "opacity-40" : ""} text-ink`}>
        <span className="min-w-0 flex-1 truncate">{column.name}</span>
        {used && !onToggle && (
          <>
            <Icon name="tick" size={12} className="text-go" />
            <span className="sr-only">(chosen)</span>
          </>
        )}
        <FamilyMark type={column.type} />
      </button>
    </li>
  );
}

function ZoneBox({ zone, columns, typeOf, onAdd, onRemove, describedBy,
  chooser = true }: {
  zone: Zone; columns: Column[]; typeOf: Record<string, string>;
  onAdd: (name: string) => void; onRemove: (name: string) => void;
  describedBy: string;
  /** The Add select; redundant where the field list has checkboxes. */
  chooser?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${zone.id}` });
  const add = useId();
  const free = columns.filter((c) => !zone.items.includes(c.name));
  return (
    <section aria-label={zone.label}
             className={`flex flex-col overflow-hidden rounded-lg border flex-1 ${isOver ? "border-ref bg-ref-wash" : "border-line bg-panel"}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1">
        <h4 className="text-[12px] font-semibold text-ink-2">{zone.label}</h4>
        {zone.hint && <span className="text-[12px] text-muted">{zone.hint}</span>}
        <div className="ml-auto flex items-center gap-2">
          {zone.extra}
          {chooser && (
            <>
              <label htmlFor={add} className="sr-only">Add a column to {zone.label}</label>
              <select id={add} value="" onChange={(e) => e.target.value && onAdd(e.target.value)}
                      className="h-6 max-w-32 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-[12px] text-ink-2">
                <option value="">+ Add</option>
                {free.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </>
          )}
        </div>
      </header>
      <div ref={setNodeRef} className={`flex min-h-10 flex-wrap content-start items-center gap-1.5 p-1.5 flex-1`}>
        <SortableContext items={zone.items.map((n) => pillId(zone.id, n))}
                         strategy={horizontalListSortingStrategy}>
          {zone.items.map((n, i) => (
            <SortablePill key={n} zone={zone} name={n} index={i}
                          type={typeOf[n] ?? ""} describedBy={describedBy}
                          onRemove={() => onRemove(n)} />
          ))}
        </SortableContext>
        {zone.items.length === 0 && (
          <span className="px-1 text-[12px] text-muted">
            Drag a column here{zone.max === 1 ? "" : ", or several"}.
          </span>
        )}
      </div>
    </section>
  );
}

function SortablePill({ zone, name, index, type, onRemove, describedBy }: {
  zone: Zone; name: string; index: number; type: string;
  onRemove: () => void; describedBy: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: pillId(zone.id, name) });
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const to = index + (e.key === "ArrowLeft" ? -1 : 1);
      if (to >= 0 && to < zone.items.length) zone.onChange(arrayMove(zone.items, index, to));
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove();
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} onKeyDown={keys}
         aria-describedby={describedBy}
         aria-label={`${name}, ${zone.label} position ${index + 1} of ${zone.items.length}`}
         style={{ transform: CSS.Transform.toString(transform), transition }}
         className={isDragging ? "opacity-30" : ""}>
      <Pill name={name} type={type} onRemove={onRemove} />
    </div>
  );
}

function Pill({ name, type, onRemove, lifted = false }: {
  name: string; type: string; onRemove?: () => void; lifted?: boolean;
}) {
  return (
    <span className={`inline-flex h-7 cursor-grab items-center gap-1.5 rounded-md border px-2
                      text-[13px] ${lifted ? "border-ref bg-ref-wash" : "border-edge bg-panel"}`}>
      <FamilyMark type={type} />
      {name}
      {onRemove && (
        <button type="button" tabIndex={-1} aria-label={`Remove ${name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onRemove}
                className="-mr-1 cursor-pointer p-0.5 text-muted hover:text-stop">
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

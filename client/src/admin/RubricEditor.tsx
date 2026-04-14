import type { RubricEntry, BranchCondition } from "./builder-types.ts";
import { st } from "./builder-types.ts";

export interface RubricEditorProps {
    entries:  RubricEntry[];
    vocab:    string[];
    onChange: (v: RubricEntry[]) => void;
}

export function RubricEditor({ entries, vocab, onChange }: RubricEditorProps) {
    const updateEntry = (i: number, patch: Partial<RubricEntry>) =>
        onChange(entries.map((e, idx) => idx === i ? { ...e, ...patch } : e));
    const addEntry    = () => onChange([...entries, { signal: "", weight: "1.0" }]);
    const removeEntry = (i: number) => onChange(entries.filter((_, idx) => idx !== i));

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {entries.map((entry, i) => (
                <div key={i} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <select
                        style={{ ...st.input, width: "200px" }}
                        value={entry.signal}
                        onChange={e => updateEntry(i, { signal: e.target.value })}
                    >
                        <option value="">— select signal —</option>
                        {vocab.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input
                        style={{ ...st.input, width: "70px" }}
                        type="number" step="0.1" min="0" max="1"
                        value={entry.weight}
                        onChange={e => updateEntry(i, { weight: e.target.value })}
                        placeholder="weight"
                    />
                    <button style={st.iconBtn} onClick={() => removeEntry(i)}>✕</button>
                </div>
            ))}
            <button style={st.btn} onClick={addEntry}>+ Add signal</button>
        </div>
    );
}

export interface BranchEditorProps {
    conditions: BranchCondition[];
    allClipIds: string[];
    onChange:   (v: BranchCondition[]) => void;
}

export function BranchEditor({ conditions, allClipIds, onChange }: BranchEditorProps) {
    const update = (i: number, patch: Partial<BranchCondition>) =>
        onChange(conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
    const addCondition    = () => onChange([...conditions, { min_score: "-1.0", max_score: "1.01", next_clip: "__null__" }]);
    const removeCondition = (i: number) => onChange(conditions.filter((_, idx) => idx !== i));

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {conditions.map((cond, i) => (
                <div key={i} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={st.hint}>min</span>
                    <input
                        style={{ ...st.input, width: "70px" }}
                        type="number" step="0.01"
                        value={cond.min_score}
                        onChange={e => update(i, { min_score: e.target.value })}
                    />
                    <span style={st.hint}>max (exclusive)</span>
                    <input
                        style={{ ...st.input, width: "70px" }}
                        type="number" step="0.01"
                        value={cond.max_score}
                        onChange={e => update(i, { max_score: e.target.value })}
                    />
                    <span style={st.hint}>→</span>
                    <select
                        style={{ ...st.input, width: "200px" }}
                        value={cond.next_clip}
                        onChange={e => update(i, { next_clip: e.target.value })}
                    >
                        <option value="__null__">null — terminal</option>
                        {allClipIds.map(id => <option key={id} value={id}>{id}</option>)}
                    </select>
                    <button style={st.iconBtn} onClick={() => removeCondition(i)}>✕</button>
                </div>
            ))}
            <button style={st.btn} onClick={addCondition}>+ Add condition</button>
        </div>
    );
}
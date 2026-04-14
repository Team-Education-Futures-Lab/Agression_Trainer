import React, { useState } from "react";
import { st } from "./builder-types.ts";

export interface TagInputProps {
    tags:        string[];
    onChange:    (v: string[]) => void;
    placeholder: string;
}

export function TagInput({ tags, onChange, placeholder }: TagInputProps) {
    const [input, setInput] = useState("");

    const commit = (raw: string) => {
        const val = raw.trim();
        if (val && !tags.includes(val)) onChange([...tags, val]);
        setInput("");
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(input); }
        else if (e.key === "Backspace" && input === "" && tags.length > 0) onChange(tags.slice(0, -1));
    };

    return (
        <div style={st.tagWrap}>
            {tags.map(t => (
                <span key={t} style={st.tag}>
                    {t}
                    <button style={st.tagRemove} onClick={() => onChange(tags.filter(x => x !== t))}>×</button>
                </span>
            ))}
            <input
                style={{ ...st.input, minWidth: "160px", flex: 1 }}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={() => { if (input.trim()) commit(input); }}
                placeholder={placeholder}
            />
        </div>
    );
}

export interface VocabTagInputProps {
    tags:        string[];
    vocab:       string[];
    onChange:    (v: string[]) => void;
    placeholder: string;
}

export function VocabTagInput({ tags, vocab, onChange, placeholder }: VocabTagInputProps) {
    const [input,    setInput]    = useState("");
    const [showDrop, setShowDrop] = useState(false);

    const suggestions = vocab.filter(v => v.includes(input.toLowerCase()) && !tags.includes(v));

    const add = (val: string) => {
        const v = val.trim();
        if (v && !tags.includes(v)) onChange([...tags, v]);
        setInput(""); setShowDrop(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (input.trim()) add(input); }
        else if (e.key === "Backspace" && input === "" && tags.length > 0) onChange(tags.slice(0, -1));
    };

    return (
        <div style={{ position: "relative" }}>
            <div style={st.tagWrap}>
                {tags.map(t => (
                    <span key={t} style={st.tag}>
                        {t}
                        <button style={st.tagRemove} onClick={() => onChange(tags.filter(x => x !== t))}>×</button>
                    </span>
                ))}
                <input
                    style={{ ...st.input, minWidth: "160px", flex: 1 }}
                    value={input}
                    onChange={e => { setInput(e.target.value); setShowDrop(true); }}
                    onFocus={() => setShowDrop(true)}
                    onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                />
            </div>
            {showDrop && suggestions.length > 0 && (
                <div style={st.dropdown}>
                    {suggestions.map(s => (
                        <div key={s} style={st.dropItem} onMouseDown={() => add(s)}>{s}</div>
                    ))}
                </div>
            )}
        </div>
    );
}
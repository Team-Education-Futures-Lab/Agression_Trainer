import React from "react";
import { st } from "./builder-types.ts";
import { Tooltip } from "./Tooltip.tsx";

export interface SectionProps {
    label:    string;
    children: React.ReactNode;
}

export function Section({ label, children }: SectionProps) {
    return (
        <div style={st.section}>
            <div style={st.sectionLabel}>{label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>{children}</div>
        </div>
    );
}

export interface FieldRowProps {
    label:    string;
    docKey?:  string;
    children: React.ReactNode;
}

export function FieldRow({ label, docKey, children }: FieldRowProps) {
    return (
        <div style={st.fieldRow}>
            <div style={st.fieldLabel}>
                {docKey ? <Tooltip docKey={docKey}>{label}</Tooltip> : label}
            </div>
            <div style={st.fieldValue}>{children}</div>
        </div>
    );
}
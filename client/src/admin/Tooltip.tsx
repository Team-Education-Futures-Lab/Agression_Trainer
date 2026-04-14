import React, { useRef, useState } from "react";
import { FIELD_DOCS, st } from "./builder-types.ts";

export interface TooltipProps {
    docKey:   string;
    children: React.ReactNode;
}

export function Tooltip({ docKey, children }: TooltipProps) {
    const [visible, setVisible] = useState(false);
    const [pos,     setPos]     = useState({ top: 0, left: 0 });
    const ref = useRef<HTMLSpanElement | null>(null);
    const doc = FIELD_DOCS[docKey];

    if (!doc) return <>{children}</>;

    const show = () => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const left = Math.min(rect.right + 8, window.innerWidth - 324);
        setPos({ top: rect.top, left });
        setVisible(true);
    };

    const hide = () => setVisible(false);

    return (
        <>
            <span
                ref={ref}
                style={st.tooltipAnchor}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                tabIndex={0}
            >
                {children}
                <span style={st.tooltipIcon}>?</span>
            </span>
            {visible && (
                <div
                    style={{ ...st.tooltipBox, top: pos.top, left: pos.left }}
                    onMouseEnter={show}
                    onMouseLeave={hide}
                >
                    <div style={st.tooltipWhat}>{doc.what}</div>
                    <div style={st.tooltipAcceptsLabel}>Accepts</div>
                    <div style={st.tooltipAccepts}>{doc.accepts}</div>
                </div>
            )}
        </>
    );
}
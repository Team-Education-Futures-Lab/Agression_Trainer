import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevTools } from "./DevTools.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
    <StrictMode>
        <DevTools />
    </StrictMode>,
);